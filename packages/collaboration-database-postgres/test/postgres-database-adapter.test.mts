import { Buffer } from "node:buffer";
import { Decoder } from "@msgpack/msgpack";
import {
  createChangeset,
  createDatabaseContext,
  createSheetBlock,
  createSnapshot,
  createUnitRecord,
} from "@univerjs-pro/collaboration-database-testkit";
import { UniverType } from "@univerjs/protocol";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresDatabaseAdapter } from "../src/index.js";
import { createTestPool, dropSchema, expectRequiredMetadataColumns, POSTGRES_URL } from "./helpers.mjs";

describe.skipIf(POSTGRES_URL === undefined)("PostgresDatabaseAdapter", () => {
  let pool: Pool;
  const context = createDatabaseContext();

  beforeAll(() => {
    pool = createTestPool();
  });

  beforeEach(async () => {
    await dropSchema(pool);
  });

  afterAll(async () => {
    await dropSchema(pool);
    await pool.end();
  });

  it("initializes the core v2 schema once and reopens it", async () => {
    await PostgresDatabaseAdapter.create({ pool });
    await PostgresDatabaseAdapter.create({ pool });
    const { rows } = await pool.query("SELECT component, version FROM collaboration.schema_versions");
    expect(rows).toEqual([{ component: "core", version: 2 }]);
  });

  it("initializes once when several nodes start together", async () => {
    await Promise.all(Array.from({ length: 4 }, () => PostgresDatabaseAdapter.create({ pool })));
    const { rows } = await pool.query("SELECT component, version FROM collaboration.schema_versions");
    expect(rows).toEqual([{ component: "core", version: 2 }]);
  });

  it("requires metadata columns without constraining their JSON shape", async () => {
    const adapter = await PostgresDatabaseAdapter.create({ pool });
    const unitID = "metadata-columns";
    const type = UniverType.UNIVER_DOC;
    await adapter.createUnit(context, {
      record: createUnitRecord(unitID, type), snapshot: createSnapshot(unitID, type, 1),
    });
    await adapter.commitChangeset(context, {
      changeset: createChangeset({ unitID, type, revision: 2, sid: "metadata-columns", reqId: 1 }),
      unitMetadata: {},
    });
    await expectRequiredMetadataColumns(pool, unitID);
  });

  it("stores queryable changeset metadata separately from the protocol payload", async () => {
    const adapter = await PostgresDatabaseAdapter.create({ pool });
    const unitID = "separate-metadata";
    const type = UniverType.UNIVER_DOC;
    await adapter.createUnit(context, {
      record: createUnitRecord(unitID, type), snapshot: createSnapshot(unitID, type, 1),
    });
    const metadata = JSON.parse('{"source":"import","__proto__":{"application":true},"nested":{"metadata":"application value"}}');
    const changeset = createChangeset({ unitID, type, revision: 2, sid: "metadata-column", reqId: 1, metadata });
    const result = await adapter.commitChangeset(context, { changeset, unitMetadata: { name: "Imported" } });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("Expected a committed changeset");

    const { rows } = await pool.query<{ payload: Buffer; metadata: Record<string, unknown> }>(
      "SELECT payload, metadata FROM collaboration.changesets WHERE unit_id = $1 AND metadata ->> 'source' = 'import'",
      [unitID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual(metadata);
    const { metadata: savedMetadata, ...protocolChangeset } = result.changeset;
    const payload = new Decoder().decode(rows[0]!.payload);
    expect(payload).toEqual(protocolChangeset);
    expect(Object.hasOwn(payload as object, "metadata")).toBe(false);
    expect(savedMetadata).toEqual(metadata);
    await expect(adapter.getChangesets(context, unitID, { from: 1 })).resolves.toEqual([result.changeset]);
    await expect(adapter.getChangesets(context, unitID, { from: 1, to: 2 })).resolves.toEqual([result.changeset]);
  });

  it("rolls back both metadata objects when the changeset insert fails", async () => {
    const adapter = await PostgresDatabaseAdapter.create({ pool });
    const unitID = "metadata-rollback";
    const type = UniverType.UNIVER_DOC;
    await adapter.createUnit(context, {
      record: { ...createUnitRecord(unitID, type), metadata: { name: "Before", source: "import" } },
      snapshot: createSnapshot(unitID, type, 1),
    });
    const changeset = createChangeset({ unitID, type, revision: 2, sid: "metadata", reqId: 1 });

    // A database constraint failure after the head UPDATE must roll the whole statement back.
    await pool.query(`ALTER TABLE collaboration.changesets
      ADD CONSTRAINT reject_metadata CHECK (NOT metadata ? 'rejected')`);
    await expect(adapter.commitChangeset(context, {
      changeset: { ...changeset, sid: "reject-metadata", metadata: { rejected: true } },
      unitMetadata: { name: "Must not persist" },
    })).rejects.toThrow(/reject_metadata/);
    await expect(adapter.getUnit(context, unitID)).resolves.toMatchObject({
      headRevision: 1, metadata: { name: "Before", source: "import" },
    });
    await expect(adapter.getChangesets(context, unitID, { from: 1 })).resolves.toEqual([]);

    const metadata = { author: { id: "editor" } };
    const result = await adapter.commitChangeset(context, {
      changeset: { ...changeset, metadata }, unitMetadata: { name: "After" },
    });
    metadata.author.id = "input mutation";
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("Expected a committed changeset");
    expect(result.changeset.metadata).toEqual({ author: { id: "editor" } });
    (result.changeset.metadata.author as { id: string }).id = "result mutation";
    const reopened = await PostgresDatabaseAdapter.create({ pool });
    await expect(reopened.getUnit(context, unitID)).resolves.toMatchObject({
      headRevision: 2, metadata: { name: "After" },
    });
    const history = await reopened.getChangesets(context, unitID, { from: 1 });
    expect(history![0]!.metadata).toEqual({ author: { id: "editor" } });

    await reopened.deleteUnits(context, { unitIDs: [unitID], hardDelete: true });
    const { rows } = await pool.query("SELECT metadata FROM collaboration.units WHERE unit_id = $1", [unitID]);
    expect(rows[0]!.metadata).toEqual({});
    await expect(reopened.getChangesets(context, unitID, { from: 1 })).resolves.toBeNull();
  });

  it("rejects a different core schema version", async () => {
    await pool.query(`
      CREATE SCHEMA collaboration;
      CREATE TABLE collaboration.schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO collaboration.schema_versions VALUES ('core', 99);
    `);
    await expect(PostgresDatabaseAdapter.create({ pool })).rejects.toThrow(/version 99 is not supported/);
  });

  it("sends only the blocks the Unit does not store yet", async () => {
    const adapter = await PostgresDatabaseAdapter.create({ pool });
    const unitID = "dedup-unit";
    const type = UniverType.UNIVER_SHEET;
    const unchanged = createSheetBlock("block-unchanged", 1);
    await adapter.createUnit(context, {
      record: createUnitRecord(unitID, type),
      snapshot: createSnapshot(unitID, type, 1),
      sheetBlocks: [unchanged],
    });
    await adapter.commitChangeset(context, {
      unitMetadata: {},
      changeset: createChangeset({ unitID, type, revision: 2, sid: "sid-dedup", reqId: 1 }),
    });
    const version = () => pool.query<{ xmin: string }>(
      "SELECT xmin::text FROM collaboration.sheet_blocks WHERE unit_id = $1 AND block_id = $2",
      [unitID, unchanged.id],
    ).then(({ rows }) => rows[0]!.xmin);
    const storedVersion = await version();

    // Record the block IDs bound to the save statement.
    const sentBlockIDs: string[][] = [];
    const query = pool.query.bind(pool);
    pool.query = ((config: { name?: string; values?: unknown[] }, ...rest: unknown[]) => {
      if (config?.name === "save_snapshot") sentBlockIDs.push(config.values![4] as string[]);
      return (query as (...args: unknown[]) => unknown)(config, ...rest);
    }) as typeof pool.query;
    const added = createSheetBlock("block-added", 2);
    try {
      await adapter.saveSnapshot(context, {
        snapshot: createSnapshot(unitID, type, 2),
        sheetBlocks: [createSheetBlock("block-unchanged", 1), added],
      });
    } finally {
      pool.query = query;
    }

    expect(sentBlockIDs).toEqual([[added.id]]);
    // The stored row was not rewritten.
    expect(await version()).toBe(storedVersion);
    await expect(adapter.getSheetBlock(context, unitID, unchanged.id)).resolves.toEqual(unchanged);
    await expect(adapter.getSheetBlock(context, unitID, added.id)).resolves.toEqual(added);
    await expect(adapter.getSnapshotInfo(context, unitID)).resolves.toEqual({ unitID, type, rev: 2 });
  });

  it("persists binary blocks, assigns the commit time and keeps hard-delete markers", async () => {
    const adapter = await PostgresDatabaseAdapter.create({ pool });
    const unitID = "persistent-unit";
    const type = UniverType.UNIVER_SHEET;
    await adapter.createUnit(context, {
      record: { ...createUnitRecord(unitID, type), creatorID: "creator", createdAt: 1700000000123 },
      snapshot: createSnapshot(unitID, type, 1),
      sheetBlocks: [{ ...createSheetBlock("block-1", 1), data: Buffer.from([0, 128, 255]) }],
    });
    await expect(adapter.getUnit(context, unitID)).resolves.toEqual({
      unitID, type, headRevision: 1, creatorID: "creator", createdAt: 1700000000123, metadata: {},
    });

    const block = await adapter.getSheetBlock(context, unitID, "block-1");
    expect(block?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(block!.data)).toEqual([0, 128, 255]);

    const changeset = createChangeset({ unitID, type, revision: 2, sid: "sid", reqId: 1 });
    changeset.createTime = 1700000000;
    const committed = await adapter.commitChangeset(context, { unitMetadata: {}, changeset });
    expect(committed.status).toBe("committed");
    const { rows } = await pool.query<{ created_at_ms: string }>(
      "SELECT created_at_ms FROM collaboration.changesets WHERE unit_id = $1 AND revision = 2",
      [unitID],
    );
    expect(committed.status === "committed" && committed.changeset.createTime).toBe(
      Math.floor(Number(rows[0]!.created_at_ms) / 1000),
    );
    expect(changeset.createTime).toBe(1700000000);

    await adapter.deleteUnits(context, { unitIDs: [unitID], hardDelete: true });
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM collaboration.snapshots WHERE unit_id = $1) AS snapshots,
        (SELECT COUNT(*)::int FROM collaboration.units WHERE unit_id = $1 AND deleted_status = 'hard') AS markers
    `, [unitID]);
    expect(counts.rows[0]).toEqual({ snapshots: 0, markers: 1 });
  });

  it("rolls back the snapshot and its blocks when publication fails", async () => {
    const adapter = await PostgresDatabaseAdapter.create({ pool });
    const unitID = "rollback-unit";
    const type = UniverType.UNIVER_DOC;
    const initial = createSnapshot(unitID, type, 1);
    await adapter.createUnit(context, { record: createUnitRecord(unitID, type), snapshot: initial });
    await adapter.commitChangeset(context, {
      unitMetadata: {},
      changeset: createChangeset({ unitID, type, revision: 2, sid: "sid-rollback", reqId: 1 }),
    });

    const invalidBlock = {
      ...createSheetBlock("block-invalid", 2),
      data: (() => undefined) as unknown as Uint8Array,
    };
    await expect(
      adapter.saveSnapshot(context, {
        snapshot: createSnapshot(unitID, type, 2),
        sheetBlocks: [createSheetBlock("block-must-not-leak", 2), invalidBlock],
      }),
    ).rejects.toThrow();
    await expect(adapter.getSheetBlock(context, unitID, "block-must-not-leak")).resolves.toBeNull();
    await expect(adapter.getSnapshot(context, unitID, { revision: 2 })).resolves.toEqual(initial);
  });
});
