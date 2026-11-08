import { Buffer } from "node:buffer";
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
import { createTestPool, dropSchema, POSTGRES_URL } from "./helpers.mjs";

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

  it("initializes the core v1 schema once and reopens it", async () => {
    await PostgresDatabaseAdapter.create({ pool });
    await PostgresDatabaseAdapter.create({ pool });
    const { rows } = await pool.query("SELECT component, version FROM collaboration.schema_versions");
    expect(rows).toEqual([{ component: "core", version: 1 }]);
  });

  it("initializes once when several nodes start together", async () => {
    await Promise.all(Array.from({ length: 4 }, () => PostgresDatabaseAdapter.create({ pool })));
    const { rows } = await pool.query("SELECT component, version FROM collaboration.schema_versions");
    expect(rows).toEqual([{ component: "core", version: 1 }]);
  });

  it("rejects a different core schema version", async () => {
    await pool.query(`
      CREATE SCHEMA collaboration;
      CREATE TABLE collaboration.schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO collaboration.schema_versions VALUES ('core', 99);
    `);
    await expect(PostgresDatabaseAdapter.create({ pool })).rejects.toThrow(/version 99 is not supported/);
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
      unitID, type, headRevision: 1, creatorID: "creator", createdAt: 1700000000123,
    });

    const block = await adapter.getSheetBlock(context, unitID, "block-1");
    expect(block?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(block!.data)).toEqual([0, 128, 255]);

    const changeset = createChangeset({ unitID, type, revision: 2, sid: "sid", reqId: 1 });
    changeset.createTime = 1700000000;
    const committed = await adapter.commitChangeset(context, { changeset });
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
