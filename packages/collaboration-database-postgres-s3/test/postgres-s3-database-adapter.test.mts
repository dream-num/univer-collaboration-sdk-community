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
import { PostgresS3DatabaseAdapter } from "../src/index.js";
import { createTestDatabase, dropSchema, MemoryObjectStore, POSTGRES_URL, type TestDatabase } from "./helpers.mjs";

describe.skipIf(POSTGRES_URL === undefined)("PostgresS3DatabaseAdapter", () => {
  let database: TestDatabase;
  let pool: Pool;
  let store: MemoryObjectStore;
  const context = createDatabaseContext();
  const type = UniverType.UNIVER_SHEET;

  const create = (options: { prefix?: string } = {}) =>
    PostgresS3DatabaseAdapter.create({ pool, s3: { client: store.client, bucket: "blocks", ...options } });
  const puts = () => store.requests.filter((request) => request.name === "put").map((request) => request.key);

  /** Creates a Unit at revision 2 so a snapshot can be saved for it. */
  async function createUnitAtRevision2(adapter: PostgresS3DatabaseAdapter, unitID: string, blockIDs: string[] = []) {
    await adapter.createUnit(context, {
      record: createUnitRecord(unitID, type),
      snapshot: createSnapshot(unitID, type, 1),
      sheetBlocks: blockIDs.map((id) => createSheetBlock(id, 1)),
    });
    await adapter.commitChangeset(context, {
      unitMetadata: {},
      changeset: createChangeset({ unitID, type, revision: 2, sid: `sid-${unitID}`, reqId: 1 }),
    });
  }

  async function expectRequiredMetadataColumns(unitID: string): Promise<void> {
    for (const table of ["units", "changesets"]) {
      await expect(pool.query(
        `UPDATE collaboration.${table} SET metadata = NULL WHERE unit_id = $1`, [unitID],
      )).rejects.toMatchObject({ code: "23502" });
      // The object shape belongs to the caller contract, not the database schema.
      const { rows } = await pool.query(
        `UPDATE collaboration.${table} SET metadata = '[]'::jsonb WHERE unit_id = $1 RETURNING metadata`, [unitID],
      );
      expect(rows).toEqual([{ metadata: [] }]);
    }
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = database.pool;
  });

  beforeEach(async () => {
    await dropSchema(pool);
    store = new MemoryObjectStore();
  });

  afterAll(async () => {
    await database.dispose();
  });

  it("initializes its schema once and reopens it", async () => {
    await create();
    await create();
    const { rows } = await pool.query("SELECT component, version FROM collaboration.schema_versions");
    expect(rows).toEqual([{ component: "core-s3", version: 1 }]);
  });

  it("initializes once when several nodes start together", async () => {
    await Promise.all(Array.from({ length: 4 }, () => create()));
    const { rows } = await pool.query("SELECT component, version FROM collaboration.schema_versions");
    expect(rows).toEqual([{ component: "core-s3", version: 1 }]);
  });

  it("requires metadata columns without constraining their JSON shape", async () => {
    const adapter = await create();
    const unitID = "metadata-columns";
    const type = UniverType.UNIVER_DOC;
    await adapter.createUnit(context, {
      record: createUnitRecord(unitID, type), snapshot: createSnapshot(unitID, type, 1),
    });
    await adapter.commitChangeset(context, {
      changeset: createChangeset({ unitID, type, revision: 2, sid: "metadata-columns", reqId: 1 }),
      unitMetadata: {},
    });
    await expectRequiredMetadataColumns(unitID);
  });

  it("stores queryable changeset metadata separately from the protocol payload", async () => {
    const adapter = await create();
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
    const adapter = await create();
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
    const reopened = await create();
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

  it("rejects a different schema version", async () => {
    await pool.query(`
      CREATE SCHEMA collaboration;
      CREATE TABLE collaboration.schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO collaboration.schema_versions VALUES ('core-s3', 99);
    `);
    await expect(create()).rejects.toThrow(/version 99 is not supported/);
  });

  it("rejects a database that stores Sheet blocks in PostgreSQL", async () => {
    await pool.query(`
      CREATE SCHEMA collaboration;
      CREATE TABLE collaboration.schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO collaboration.schema_versions VALUES ('core', 1);
    `);
    await expect(create()).rejects.toThrow(/collaboration-database-postgres/);
  });

  it("validates its options", async () => {
    const s3 = { client: store.client, bucket: "blocks" };
    await expect(PostgresS3DatabaseAdapter.create({ pool, s3: { ...s3, bucket: "" } })).rejects.toThrow(TypeError);
    await expect(PostgresS3DatabaseAdapter.create({ pool, s3: { ...s3, prefix: "blocks/" } })).rejects.toThrow(TypeError);
    await expect(PostgresS3DatabaseAdapter.create({ pool, s3: { ...s3, concurrency: 0 } })).rejects.toThrow(TypeError);
  });

  it("stores block contents as objects and only their IDs in PostgreSQL", async () => {
    const adapter = await create({ prefix: "tenant/blocks" });
    const unitID = "unit/with space";
    const block = { ...createSheetBlock("block 1", 1), data: Buffer.from([0, 128, 255]) };
    await adapter.createUnit(context, {
      record: createUnitRecord(unitID, type),
      snapshot: createSnapshot(unitID, type, 1),
      sheetBlocks: [block],
    });

    // Unit and block IDs are percent-encoded so they cannot change the key structure.
    expect(store.keys()).toEqual(["tenant/blocks/unit%2Fwith%20space/block%201"]);
    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'collaboration' AND table_name = 'sheet_blocks' ORDER BY column_name",
    );
    expect(rows.map((row) => row.column_name)).toEqual(["block_id", "unit_id", "unreferenced_at_ms"]);

    const stored = await adapter.getSheetBlock(context, unitID, block.id);
    expect(stored?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(stored!.data)).toEqual([0, 128, 255]);
    expect({ ...stored, data: undefined }).toEqual({ ...block, data: undefined });
  });

  it("uploads only the blocks the Unit does not store yet", async () => {
    const adapter = await create();
    const unitID = "dedup-unit";
    await createUnitAtRevision2(adapter, unitID, ["block-unchanged"]);
    store.requests.length = 0;

    const added = createSheetBlock("block-added", 2);
    await adapter.saveSnapshot(context, {
      snapshot: createSnapshot(unitID, type, 2),
      sheetBlocks: [createSheetBlock("block-unchanged", 1), added],
    });

    expect(puts()).toEqual([`${unitID}/${added.id}`]);
    await expect(adapter.getSheetBlock(context, unitID, "block-unchanged")).resolves.toEqual(
      createSheetBlock("block-unchanged", 1),
    );
    await expect(adapter.getSheetBlock(context, unitID, added.id)).resolves.toEqual(added);
    await expect(adapter.getSnapshotInfo(context, unitID)).resolves.toEqual({ unitID, type, rev: 2 });
  });

  it("records the blocks every snapshot references, uploaded or not", async () => {
    const adapter = await create();
    const unitID = "referenced-unit";
    await createUnitAtRevision2(adapter, unitID, ["block-a", "block-b"]);
    await adapter.saveSnapshot(context, {
      snapshot: createSnapshot(unitID, type, 2),
      sheetBlocks: [createSheetBlock("block-a", 1), createSheetBlock("block-c", 2)],
    });

    const snapshots = await pool.query(
      "SELECT revision, block_ids FROM collaboration.snapshots WHERE unit_id = $1 ORDER BY revision",
      [unitID],
    );
    expect(snapshots.rows).toEqual([
      { revision: 1, block_ids: ["block-a", "block-b"] },
      { revision: 2, block_ids: ["block-a", "block-c"] },
    ]);
    // One ledger row per object, however many snapshots reference it.
    const ledger = await pool.query(
      "SELECT block_id, unreferenced_at_ms FROM collaboration.sheet_blocks WHERE unit_id = $1 ORDER BY block_id",
      [unitID],
    );
    expect(ledger.rows).toEqual([
      { block_id: "block-a", unreferenced_at_ms: null },
      { block_id: "block-b", unreferenced_at_ms: null },
      { block_id: "block-c", unreferenced_at_ms: null },
    ]);
  });

  it("replaces the references of a snapshot saved again at the same revision", async () => {
    const adapter = await create();
    const unitID = "resaved-unit";
    await createUnitAtRevision2(adapter, unitID);
    const save = (blockID: string) => adapter.saveSnapshot(context, {
      snapshot: createSnapshot(unitID, type, 2),
      sheetBlocks: [createSheetBlock(blockID, 2)],
    });
    await save("block-first");
    await save("block-second");

    const { rows } = await pool.query(
      "SELECT block_ids FROM collaboration.snapshots WHERE unit_id = $1 AND revision = 2",
      [unitID],
    );
    expect(rows).toEqual([{ block_ids: ["block-second"] }]);
  });

  it("uploads nothing for a snapshot the Unit cannot take", async () => {
    const adapter = await create();
    const unitID = "rejected-unit";
    await createUnitAtRevision2(adapter, unitID);
    store.requests.length = 0;
    const block = createSheetBlock("block-rejected", 3);

    // Beyond the head revision.
    await expect(
      adapter.saveSnapshot(context, { snapshot: createSnapshot(unitID, type, 3), sheetBlocks: [block] }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // Deleted.
    await adapter.deleteUnits(context, { unitIDs: [unitID], hardDelete: true });
    await expect(
      adapter.saveSnapshot(context, { snapshot: createSnapshot(unitID, type, 2), sheetBlocks: [block] }),
    ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });

    expect(puts()).toEqual([]);
    expect(store.keys()).toEqual([]);
  });

  it("leaves the objects of an existing Unit untouched when its ID is created again", async () => {
    const adapter = await create();
    const unitID = "existing-unit";
    const original = createSheetBlock("block-shared-id", 1);
    const input = {
      record: createUnitRecord(unitID, type),
      snapshot: createSnapshot(unitID, type, 1),
    };
    await adapter.createUnit(context, { ...input, sheetBlocks: [original] });
    store.requests.length = 0;

    await expect(
      adapter.createUnit(context, { ...input, sheetBlocks: [createSheetBlock("block-shared-id", 9)] }),
    ).resolves.toMatchObject({ status: "already-exists" });

    expect(puts()).toEqual([]);
    await expect(adapter.getSheetBlock(context, unitID, original.id)).resolves.toEqual(original);
  });

  it("keeps the blocks of the creator that wins when several nodes create the same Unit ID", async () => {
    const adapters = await Promise.all(Array.from({ length: 4 }, () => create()));
    for (let round = 0; round < 10; round++) {
      const unitID = `contested-${round}`;
      // Every node offers the same block ID with its own content.
      const results = await Promise.all(adapters.map((adapter, node) =>
        adapter.createUnit(context, {
          record: createUnitRecord(unitID, type),
          snapshot: createSnapshot(unitID, type, 1),
          sheetBlocks: [createSheetBlock("block-contested", node)],
        })));

      const winners = results.flatMap((result, node) => (result.status === "created" ? [node] : []));
      expect(winners).toHaveLength(1);
      await expect(adapters[0]!.getSheetBlock(context, unitID, "block-contested")).resolves.toEqual(
        createSheetBlock("block-contested", winners[0]!),
      );
    }
  });

  it("publishes neither the snapshot nor its blocks when a block cannot be stored", async () => {
    const adapter = await create();
    const unitID = "rollback-unit";
    await createUnitAtRevision2(adapter, unitID);
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
    await expect(adapter.getSnapshotInfo(context, unitID)).resolves.toEqual({ unitID, type, rev: 1 });
  });

  it("reports a stored block whose object is missing", async () => {
    const adapter = await create();
    const unitID = "missing-object-unit";
    await createUnitAtRevision2(adapter, unitID, ["block-lost"]);
    store.objects.clear();

    await expect(adapter.getSheetBlock(context, unitID, "block-lost")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("removes every object of a hard-deleted Unit and keeps other Units", async () => {
    const adapter = await create();
    await createUnitAtRevision2(adapter, "doomed", ["block-a", "block-b"]);
    await createUnitAtRevision2(adapter, "doomed-2", ["block-c"]);
    // An object a failed save left behind has no row but lives under the Unit's prefix.
    store.objects.set("doomed/leftover", new Uint8Array([1]));

    await adapter.deleteUnits(context, { unitIDs: ["doomed"], hardDelete: false });
    expect(store.keys()).toEqual(["doomed-2/block-c", "doomed/block-a", "doomed/block-b", "doomed/leftover"]);

    await adapter.deleteUnits(context, { unitIDs: ["doomed"], hardDelete: true });
    expect(store.keys()).toEqual(["doomed-2/block-c"]);
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM collaboration.sheet_blocks WHERE unit_id = 'doomed') AS blocks,
        (SELECT COUNT(*)::int FROM collaboration.units WHERE unit_id = 'doomed' AND deleted_status = 'hard') AS markers
    `);
    expect(counts.rows[0]).toEqual({ blocks: 0, markers: 1 });
  });

  it("completes a hard delete whose objects cannot be removed and retries the purge later", async () => {
    const adapter = await create();
    await createUnitAtRevision2(adapter, "stuck", ["block-a"]);
    const ledger = async () => (await pool.query(
      "SELECT block_id, unreferenced_at_ms IS NOT NULL AS unreferenced FROM collaboration.sheet_blocks WHERE unit_id = 'stuck'",
    )).rows;
    store.failDeletes = true;

    await expect(adapter.deleteUnits(context, { unitIDs: ["stuck"], hardDelete: true })).resolves.toEqual({
      units: [{ unitID: "stuck", status: "hard-deleted" }],
    });
    await expect(adapter.getUnit(context, "stuck")).resolves.toBeNull();
    // The ledger row stays, unreferenced, for as long as the object may still exist.
    expect(store.keys()).toEqual(["stuck/block-a"]);
    await expect(ledger()).resolves.toEqual([{ block_id: "block-a", unreferenced: true }]);

    // Deleting again purges what the first attempt left.
    store.failDeletes = false;
    await expect(adapter.deleteUnits(context, { unitIDs: ["stuck"], hardDelete: true })).resolves.toEqual({
      units: [{ unitID: "stuck", status: "already-hard-deleted" }],
    });
    expect(store.keys()).toEqual([]);
    await expect(ledger()).resolves.toEqual([]);
  });
});
