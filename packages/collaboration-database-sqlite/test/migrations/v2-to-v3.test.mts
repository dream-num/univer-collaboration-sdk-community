import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import {
  createChangeset,
  createDatabaseContext,
  createSheetBlock,
  createSnapshot,
} from "@univerjs-pro/collaboration-database-testkit";
import { UniverType } from "@univerjs/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteDatabaseAdapter, migrateSQLiteCoreV2ToV3 } from "../../src/index.js";
import { addApplicationObjects, createV1Database, createV2Database, dumpDatabase, encodeLegacy, exec, query } from "./fixtures.mjs";

describe("migrateSQLiteCoreV2ToV3", () => {
  let directory: string;
  let filename: string;
  const context = createDatabaseContext();
  const type = UniverType.UNIVER_SHEET;
  const latestSnapshot = createSnapshot("active", type, 2);
  const changeset = { ...createChangeset({ unitID: "active", type, revision: 2, sid: "s", reqId: 1 }), createTime: 1700000000 };
  const block = { ...createSheetBlock("block-1", 1), data: Uint8Array.from([0, 128, 255]) };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "univer-collab-v2-"));
    filename = join(directory, "collaboration.sqlite");
    createV2Database(filename);
    const database = new Database(filename);
    try {
      database.exec(`
        INSERT INTO collaboration_units VALUES
          ('active', ${type}, 2, 'alice', 1000, NULL),
          ('soft', ${type}, 1, 'bob', 2000, 2500);
        INSERT INTO collaboration_unit_tombstones VALUES ('gone', 3000);
      `);
      const snapshot = database.prepare("INSERT INTO collaboration_snapshots VALUES (?, ?, ?, ?)");
      snapshot.run("active", 1, type, encodeLegacy(createSnapshot("active", type, 1)));
      snapshot.run("active", 2, type, encodeLegacy(latestSnapshot));
      snapshot.run("soft", 1, type, encodeLegacy(createSnapshot("soft", type, 1)));
      database
        .prepare("INSERT INTO collaboration_changesets VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("active", 2, 1, "s", 1, 1700000000000, encodeLegacy(changeset));
      database.prepare("INSERT INTO collaboration_sheet_blocks VALUES (?, ?, ?)").run("active", "block-1", encodeLegacy(block));
    } finally {
      database.close();
    }
    addApplicationObjects(filename);
    exec(filename, "INSERT INTO application_unit_links VALUES ('active');");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("is named by the adapter error for a v2 database, which stays unchanged", () => {
    const before = dumpDatabase(filename);
    expect(() => new SQLiteDatabaseAdapter({ filename })).toThrow(
      /version 2 is not supported .* run migrateSQLiteCore first/,
    );
    expect(dumpDatabase(filename)).toEqual(before);
  });

  it("re-encodes payloads, folds tombstones into marker rows and keeps application objects", async () => {
    await migrateSQLiteCoreV2ToV3({ filename });

    expect(query(filename, "SELECT * FROM collaboration_schema_versions ORDER BY component")).toEqual([
      { component: "core", version: 3 },
      { component: "other", version: 7 },
    ]);
    expect(query(filename, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")).toEqual([
      { name: "application_unit_links" },
      { name: "collaboration_changesets" },
      { name: "collaboration_schema_versions" },
      { name: "collaboration_sheet_blocks" },
      { name: "collaboration_snapshots" },
      { name: "collaboration_units" },
    ]);
    expect(query(filename, "SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL")).toEqual([
      { name: "application_unit_type" },
    ]);
    expect(query(filename, "SELECT * FROM collaboration_units ORDER BY unit_id")).toEqual([
      { unit_id: "active", type, head_revision: 2, creator_id: "alice", created_at_ms: 1000, deleted_at_ms: null, deleted_status: null },
      { unit_id: "gone", type, head_revision: 1, creator_id: "anonymous", created_at_ms: 3000, deleted_at_ms: 3000, deleted_status: "hard" },
      { unit_id: "soft", type, head_revision: 1, creator_id: "bob", created_at_ms: 2000, deleted_at_ms: 2500, deleted_status: "soft" },
    ]);
    expect(query<{ name: string }>(filename, "PRAGMA table_info(collaboration_snapshots)").map((column) => column.name)).toEqual([
      "unit_id", "revision", "payload",
    ]);
    expect(query(filename, "SELECT unit_id, revision, base_revision, sid, req_id, created_at_ms FROM collaboration_changesets")).toEqual([
      { unit_id: "active", revision: 2, base_revision: 1, sid: "s", req_id: 1, created_at_ms: 1700000000000 },
    ]);
    expect(query(filename, "SELECT * FROM application_units ORDER BY unit_id")).toEqual([
      { unit_id: "active" }, { unit_id: "gone" }, { unit_id: "soft" },
    ]);
    expect(query(filename, "SELECT * FROM application_unit_links")).toEqual([{ unit_id: "active" }]);
    expect(query(filename, "PRAGMA foreign_key_check")).toEqual([]);
    expect(query(filename, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);

    const adapter = new SQLiteDatabaseAdapter({ filename });
    try {
      await expect(adapter.getUnit(context, "active")).resolves.toEqual({
        unitID: "active", type, headRevision: 2, creatorID: "alice", createdAt: 1000,
      });
      await expect(adapter.getSnapshot(context, "active")).resolves.toEqual(latestSnapshot);
      await expect(adapter.getSnapshot(context, "active", { revision: 1 })).resolves.toEqual(createSnapshot("active", type, 1));
      await expect(adapter.getChangesets(context, "active", { from: 1 })).resolves.toEqual([changeset]);
      const stored = await adapter.getSheetBlock(context, "active", "block-1");
      expect(stored?.data).toBeInstanceOf(Uint8Array);
      expect(stored).toEqual(block);

      await expect(adapter.getUnit(context, "soft")).resolves.toBeNull();
      await expect(adapter.recoverUnits(context, { unitIDs: ["soft"] })).resolves.toEqual({
        units: [{ unitID: "soft", status: "recovered" }],
      });
      await expect(adapter.getUnit(context, "soft")).resolves.toMatchObject({ creatorID: "bob", createdAt: 2000 });

      await expect(adapter.getUnit(context, "gone")).resolves.toBeNull();
      await expect(adapter.recoverUnits(context, { unitIDs: ["gone"] })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(
        adapter.createUnit(context, {
          record: { unitID: "gone", type, headRevision: 1, creatorID: "carol", createdAt: 4000 },
          snapshot: createSnapshot("gone", type, 1),
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(adapter.deleteUnits(context, { unitIDs: ["gone"], hardDelete: true })).resolves.toEqual({
        units: [{ unitID: "gone", status: "already-hard-deleted" }],
      });
    } finally {
      await adapter.dispose();
    }

    await expect(migrateSQLiteCoreV2ToV3({ filename })).rejects.toThrow("requires core schema version 2");
  });

  it("rejects a v1 database", async () => {
    const v1 = join(directory, "v1.sqlite");
    createV1Database(v1);
    const before = dumpDatabase(v1);
    await expect(migrateSQLiteCoreV2ToV3({ filename: v1 })).rejects.toThrow("requires core schema version 2");
    expect(dumpDatabase(v1)).toEqual(before);
  });

  it("rolls back everything when the version update fails", async () => {
    exec(filename, `CREATE TRIGGER reject_core_upgrade BEFORE UPDATE ON collaboration_schema_versions
      WHEN OLD.component = 'core' BEGIN SELECT RAISE(ABORT, 'reject version'); END;`);
    const before = dumpDatabase(filename);
    await expect(migrateSQLiteCoreV2ToV3({ filename })).rejects.toThrow("reject version");
    expect(dumpDatabase(filename)).toEqual(before);
  });

  it("rolls back everything when a payload is not valid JSON", async () => {
    exec(filename, "UPDATE collaboration_sheet_blocks SET payload_json = '{broken'");
    const before = dumpDatabase(filename);
    await expect(migrateSQLiteCoreV2ToV3({ filename })).rejects.toThrow();
    expect(dumpDatabase(filename)).toEqual(before);
  });

  it("copies every row across pages for 205 Units", async () => {
    const database = new Database(filename);
    try {
      database.exec("BEGIN IMMEDIATE");
      const unit = database.prepare("INSERT INTO collaboration_units VALUES (?, ?, 4, 'creator', 1, NULL)");
      const snapshot = database.prepare("INSERT INTO collaboration_snapshots VALUES (?, 1, ?, ?)");
      const change = database.prepare("INSERT INTO collaboration_changesets VALUES (?, ?, ?, 'sid', ?, 5, ?)");
      for (let index = 0; index < 205; index++) {
        const unitID = `unit-'${String(index).padStart(4, "0")}`;
        unit.run(unitID, type);
        snapshot.run(unitID, type, encodeLegacy(createSnapshot(unitID, type, 1)));
        for (const revision of [2, 3, 4]) {
          change.run(unitID, revision, revision - 1, revision, encodeLegacy(
            createChangeset({ unitID, type, revision, sid: "sid", reqId: revision }),
          ));
        }
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    await migrateSQLiteCoreV2ToV3({ filename });
    expect(query(filename, "SELECT COUNT(*) AS count FROM collaboration_units")).toEqual([{ count: 208 }]);
    expect(query(filename, "SELECT COUNT(*) AS count FROM collaboration_snapshots")).toEqual([{ count: 208 }]);
    expect(query(filename, "SELECT COUNT(*) AS count FROM collaboration_changesets")).toEqual([{ count: 616 }]);

    const adapter = new SQLiteDatabaseAdapter({ filename });
    try {
      const unitID = "unit-'0204";
      await expect(adapter.getSnapshot(context, unitID)).resolves.toEqual(createSnapshot(unitID, type, 1));
      const changesets = await adapter.getChangesets(context, unitID, { from: 1 });
      expect(changesets?.map((item) => item.revision)).toEqual([2, 3, 4]);
    } finally {
      await adapter.dispose();
    }
  });
});
