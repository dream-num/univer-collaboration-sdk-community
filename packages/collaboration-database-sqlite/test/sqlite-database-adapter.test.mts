import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import {
  createChangeset,
  createDatabaseContext,
  createSheetBlock,
  createSnapshot,
  createUnitRecord,
} from "@univerjs-pro/collaboration-database-testkit";
import { UniverType } from "@univerjs/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteDatabaseAdapter } from "../src/index.js";

describe("SQLiteDatabaseAdapter", () => {
  let directory: string;
  let filename: string;
  const context = createDatabaseContext();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "univer-collab-sqlite-"));
    filename = join(directory, "collaboration.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("persists snapshots, changesets and binary blocks across reopen", async () => {
    const unitID = "persistent-unit";
    const type = UniverType.UNIVER_SHEET;
    const initialBlock = { ...createSheetBlock("block-1", 1), data: Buffer.from([0, 128, 255]) };
    const adapter = new SQLiteDatabaseAdapter({ filename });
    await adapter.createUnit(context, {
      record: { ...createUnitRecord(unitID, type), creatorID: "creator", createdAt: 1700000000123 },
      snapshot: createSnapshot(unitID, type, 1),
      sheetBlocks: [initialBlock],
    });
    const changeset = createChangeset({ unitID, type, revision: 2, sid: "persistent-sid", reqId: 1 });
    changeset.createTime = 1700000000;
    const committed = await adapter.commitChangeset(context, { changeset });
    const latestSnapshot = createSnapshot(unitID, type, 2);
    const latestBlock = createSheetBlock("block-2", 2);
    await adapter.saveSnapshot(context, { snapshot: latestSnapshot, sheetBlocks: [latestBlock] });
    await adapter.dispose();

    const reopened = new SQLiteDatabaseAdapter({ filename });
    try {
      await expect(reopened.getUnit(context, unitID)).resolves.toEqual({
        unitID, type, headRevision: 2, creatorID: "creator", createdAt: 1700000000123,
      });
      await expect(reopened.getSnapshot(context, unitID)).resolves.toEqual(latestSnapshot);
      await expect(reopened.getChangesets(context, unitID, { from: 1 })).resolves.toEqual([
        committed.status === "committed" ? committed.changeset : null,
      ]);
      // Binary block data comes back as a plain Uint8Array regardless of the input view type.
      const block = await reopened.getSheetBlock(context, unitID, "block-1");
      expect(block?.data).toBeInstanceOf(Uint8Array);
      expect(Array.from(block!.data)).toEqual([0, 128, 255]);
      await expect(reopened.getSheetBlock(context, unitID, "block-2")).resolves.toEqual(latestBlock);
    } finally {
      await reopened.dispose();
    }

    // The persisted createTime is the commit time in Unix seconds, not the caller's value.
    const database = new Database(filename);
    try {
      const row = database
        .prepare("SELECT created_at_ms FROM collaboration_changesets WHERE unit_id = ? AND revision = 2")
        .get(unitID) as { created_at_ms: number };
      expect(committed.status === "committed" && committed.changeset.createTime).toBe(
        Math.floor(row.created_at_ms / 1000),
      );
      expect(committed.status === "committed" && committed.changeset.createTime).not.toBe(1700000000);
    } finally {
      database.close();
    }
  });

  it("observes another connection's writes and lets only one connection win a revision CAS", async () => {
    const unitID = "shared-unit";
    const type = UniverType.UNIVER_DOC;
    const writer = new SQLiteDatabaseAdapter({ filename, busyTimeoutMs: 10_000 });
    const reader = new SQLiteDatabaseAdapter({ filename, busyTimeoutMs: 10_000 });
    try {
      await writer.createUnit(context, {
        record: createUnitRecord(unitID, type),
        snapshot: createSnapshot(unitID, type, 1),
      });
      await expect(reader.getSnapshotInfo(context, unitID)).resolves.toEqual({ unitID, type, rev: 1 });

      const results = await Promise.all([
        writer.commitChangeset(context, {
          changeset: createChangeset({ unitID, type, revision: 2, sid: "sid-a", reqId: 1 }),
        }),
        reader.commitChangeset(context, {
          changeset: createChangeset({ unitID, type, revision: 2, sid: "sid-b", reqId: 1 }),
        }),
      ]);
      expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
      expect(results.filter((result) => result.status === "revision-mismatch")).toEqual([
        { status: "revision-mismatch", actualHeadRevision: 2 },
      ]);
    } finally {
      await writer.dispose();
      await reader.dispose();
    }
  });

  it("rolls back the snapshot and its blocks when publication fails", async () => {
    const unitID = "rollback-unit";
    const type = UniverType.UNIVER_SHEET;
    const adapter = new SQLiteDatabaseAdapter({ filename });
    try {
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
    } finally {
      await adapter.dispose();
    }
  });

  it("has idempotent disposal and rejects later operations", async () => {
    const adapter = new SQLiteDatabaseAdapter({ filename });
    await adapter.dispose();
    await adapter.dispose();
    await expect(adapter.getUnit(context, "any")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("requires a filename", () => {
    expect(() => new SQLiteDatabaseAdapter({ filename: "" })).toThrow(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("initializes the core v3 schema and keeps other component versions", async () => {
    const database = new Database(filename);
    database.exec(`
      CREATE TABLE collaboration_schema_versions (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1)
      );
      INSERT INTO collaboration_schema_versions (component, version) VALUES ('worktree', 3);
    `);
    database.close();

    const adapter = new SQLiteDatabaseAdapter({ filename });
    await adapter.dispose();

    const inspect = new Database(filename);
    try {
      const versions = inspect
        .prepare("SELECT component, version FROM collaboration_schema_versions ORDER BY component")
        .all();
      expect(versions).toEqual([
        { component: "core", version: 3 },
        { component: "worktree", version: 3 },
      ]);
      const tables = inspect
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'collaboration_%' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual([
        "collaboration_changesets",
        "collaboration_schema_versions",
        "collaboration_sheet_blocks",
        "collaboration_snapshots",
        "collaboration_units",
      ]);
    } finally {
      inspect.close();
    }
  });

  it("rejects a different core schema version", () => {
    const database = new Database(filename);
    database.exec(`
      CREATE TABLE collaboration_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO collaboration_schema_versions (component, version) VALUES ('core', 2);
      CREATE TABLE collaboration_units (unit_id TEXT PRIMARY KEY);
    `);
    database.close();

    expect(() => new SQLiteDatabaseAdapter({ filename })).toThrow(/version 2 is not supported/);
  });

  it("persists deletion state across reopen and blocks stale connections after delete", async () => {
    const type = UniverType.UNIVER_SLIDE;
    const softID = "soft-deleted-unit";
    const hardID = "hard-deleted-unit";
    const stale = new SQLiteDatabaseAdapter({ filename });
    const adapter = new SQLiteDatabaseAdapter({ filename });
    for (const unitID of [softID, hardID]) {
      await adapter.createUnit(context, {
        record: createUnitRecord(unitID, type),
        snapshot: createSnapshot(unitID, type, 1),
      });
    }
    await adapter.deleteUnits(context, { unitIDs: [softID], hardDelete: false });
    await adapter.deleteUnits(context, { unitIDs: [hardID], hardDelete: true });
    await adapter.dispose();

    // A connection opened before the delete must still see the deletion in its next transaction.
    try {
      await expect(
        stale.commitChangeset(context, {
          changeset: createChangeset({ unitID: hardID, type, revision: 2, sid: "stale", reqId: 1 }),
        }),
      ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });
      await expect(
        stale.saveSnapshot(context, { snapshot: createSnapshot(softID, type, 1) }),
      ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });
    } finally {
      await stale.dispose();
    }

    const reopened = new SQLiteDatabaseAdapter({ filename });
    try {
      await expect(reopened.getUnit(context, softID)).resolves.toBeNull();
      await expect(reopened.recoverUnits(context, { unitIDs: [softID] })).resolves.toEqual({
        units: [{ unitID: softID, status: "recovered" }],
      });
      await expect(reopened.getUnit(context, softID)).resolves.toEqual(createUnitRecord(softID, type));

      await expect(reopened.recoverUnits(context, { unitIDs: [hardID] })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      await expect(
        reopened.createUnit(context, {
          record: createUnitRecord(hardID, type),
          snapshot: createSnapshot(hardID, type, 1),
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(reopened.deleteUnits(context, { unitIDs: [hardID], hardDelete: true })).resolves.toEqual({
        units: [{ unitID: hardID, status: "already-hard-deleted" }],
      });
    } finally {
      await reopened.dispose();
    }

    // Hard deletion removes all content rows but keeps the Unit row as the permanent marker.
    const database = new Database(filename);
    try {
      const counts = database
        .prepare(`
          SELECT
            (SELECT COUNT(*) FROM collaboration_snapshots WHERE unit_id = ?) AS snapshots,
            (SELECT COUNT(*) FROM collaboration_units WHERE unit_id = ? AND deleted_status = 'hard') AS markers
        `)
        .get(hardID, hardID);
      expect(counts).toMatchObject({ snapshots: 0, markers: 1 });
    } finally {
      database.close();
    }
  });
});
