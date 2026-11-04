import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SQLiteDatabaseAdapter, migrateSQLiteCoreV1ToV2 } from "../../src/index.js";
import { addApplicationObjects, createV1Database, dumpDatabase, exec, query } from "./fixtures.mjs";

describe("migrateSQLiteCoreV1ToV2", () => {
  let directory: string;
  let filename: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "univer-collab-v1-"));
    filename = join(directory, "collaboration.sqlite");
    createV1Database(filename);
    exec(filename, `
      INSERT INTO collaboration_units VALUES ('active', 1, 2, NULL), ('deleted', 1, 1, 123);
      INSERT INTO collaboration_snapshots VALUES
        ('active', 1, 1, '{"unitID":"active","rev":1}'),
        ('deleted', 1, 1, '{"unitID":"deleted","rev":1}');
      INSERT INTO collaboration_changesets VALUES ('active', 2, 1, 's', 1, '{"unitID":"active","revision":2}');
    `);
    addApplicationObjects(filename);
    exec(filename, "INSERT INTO application_unit_links VALUES ('active');");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const resolvers = {
    resolveUnitCreation: () => ({ creatorID: "creator", createdAt: 1700000000000 }),
    resolveChangesetCreatedAt: () => 1700000000123,
  };

  it("is named by the adapter error for a v1 database, which stays unchanged", () => {
    const before = dumpDatabase(filename);
    expect(() => new SQLiteDatabaseAdapter({ filename })).toThrow(
      /version 1 is not supported .* run migrateSQLiteCore first/,
    );
    expect(dumpDatabase(filename)).toEqual(before);
  });

  it("fills every Unit from the resolvers and preserves content, references and other components", async () => {
    const resolveUnitCreation = vi.fn(async (unitID: string) => ({ creatorID: `creator-${unitID}`, createdAt: 1700000000000 }));
    await migrateSQLiteCoreV1ToV2({ filename, resolveUnitCreation, resolveChangesetCreatedAt: () => 1700000000123 });
    expect(resolveUnitCreation.mock.calls).toEqual([["active"], ["deleted"]]);

    expect(query(filename, "SELECT * FROM collaboration_schema_versions ORDER BY component")).toEqual([
      { component: "core", version: 2 },
      { component: "other", version: 7 },
    ]);
    expect(query(filename, "SELECT * FROM collaboration_units ORDER BY unit_id")).toEqual([
      { unit_id: "active", type: 1, head_revision: 2, creator_id: "creator-active", created_at_ms: 1700000000000, soft_deleted_at_ms: null },
      { unit_id: "deleted", type: 1, head_revision: 1, creator_id: "creator-deleted", created_at_ms: 1700000000000, soft_deleted_at_ms: 123 },
    ]);
    expect(query(filename, "SELECT created_at_ms, payload_json FROM collaboration_changesets")).toEqual([
      { created_at_ms: 1700000000123, payload_json: '{"unitID":"active","revision":2,"createTime":1700000000}' },
    ]);
    expect(query(filename, "SELECT unit_id FROM collaboration_snapshots ORDER BY unit_id")).toHaveLength(2);
    expect(query(filename, "PRAGMA foreign_key_check")).toEqual([]);
    expect(query(filename, "SELECT * FROM application_units ORDER BY unit_id")).toEqual([{ unit_id: "active" }, { unit_id: "deleted" }]);
    expect(query(filename, "SELECT * FROM application_unit_links")).toEqual([{ unit_id: "active" }]);
    expect(query(filename, "SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")).toEqual([
      { name: "application_unit_type" },
      { name: "collaboration_changesets_revision_range" },
      { name: "collaboration_snapshots_nearest_revision" },
    ]);
    expect(() => exec(filename, "UPDATE collaboration_units SET creator_id = NULL")).toThrow();
    expect(() => exec(filename, "UPDATE collaboration_changesets SET created_at_ms = NULL")).toThrow();

    const repeated = vi.fn();
    await expect(migrateSQLiteCoreV1ToV2({ filename, ...resolvers, resolveUnitCreation: repeated })).rejects.toThrow(
      "requires core schema version 1",
    );
    expect(repeated).not.toHaveBeenCalled();
  });

  it.each(["throw", "missing", "invalid"])("rolls back everything when the Unit resolver is %s", async (mode) => {
    const before = dumpDatabase(filename);
    await expect(
      migrateSQLiteCoreV1ToV2({
        filename,
        resolveChangesetCreatedAt: () => 1700000000123,
        resolveUnitCreation: async (unitID) => {
          if (unitID === "active") return { creatorID: "valid", createdAt: 1700000000000 };
          if (mode === "throw") throw new Error("Cannot resolve creator");
          return (mode === "missing" ? undefined : { creatorID: "", createdAt: -1 }) as never;
        },
      }),
    ).rejects.toThrow();
    expect(dumpDatabase(filename)).toEqual(before);
  });

  it.each([undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "throw"])(
    "rolls back everything when the changeset time is %s",
    async (value) => {
      const before = dumpDatabase(filename);
      await expect(
        migrateSQLiteCoreV1ToV2({
          filename,
          resolveUnitCreation: () => ({ creatorID: "creator", createdAt: 1 }),
          resolveChangesetCreatedAt: async (unitID, revision) => {
            expect([unitID, revision]).toEqual(["active", 2]);
            if (value === "throw") throw new Error("missing history");
            return value as number;
          },
        }),
      ).rejects.toThrow();
      expect(dumpDatabase(filename)).toEqual(before);
    },
  );

  it("rolls back the rebuilt tables when the version update fails", async () => {
    exec(filename, `CREATE TRIGGER reject_core_upgrade BEFORE UPDATE ON collaboration_schema_versions
      WHEN OLD.component = 'core' BEGIN SELECT RAISE(ABORT, 'reject version'); END;`);
    const before = dumpDatabase(filename);
    await expect(migrateSQLiteCoreV1ToV2({ filename, ...resolvers })).rejects.toThrow("reject version");
    expect(dumpDatabase(filename)).toEqual(before);
  });

  it.each([undefined, 0, 1700000000])("prefers the resolver over the legacy payload time %s", async (createTime) => {
    exec(filename, `UPDATE collaboration_changesets SET payload_json = ${
      createTime === undefined ? "json_remove(payload_json, '$.createTime')" : `json_set(payload_json, '$.createTime', ${createTime})`
    }`);
    await migrateSQLiteCoreV1ToV2({ filename, ...resolvers });
    const [stored] = query<{ created_at_ms: number; payload_json: string }>(
      filename, "SELECT created_at_ms, payload_json FROM collaboration_changesets",
    );
    expect(stored!.created_at_ms).toBe(1700000000123);
    expect(JSON.parse(stored!.payload_json).createTime).toBe(1700000000);
  });

  it.each([undefined, 0, 123, -1, "invalid"])("defaults to the payload time %s before History", async (createTime) => {
    exec(filename, `
      CREATE TABLE collaboration_history_revisions (
        unit_id TEXT NOT NULL, revision INTEGER NOT NULL, user_id TEXT, committed_at INTEGER,
        PRIMARY KEY (unit_id, revision));
      INSERT INTO collaboration_history_revisions VALUES ('active', 1, 'history-creator', 1000), ('active', 2, 'editor', 2500);
      UPDATE collaboration_changesets SET payload_json = ${
        createTime === undefined ? "json_remove(payload_json, '$.createTime')" : `json_set(payload_json, '$.createTime', ${typeof createTime === "string" ? `'${createTime}'` : createTime})`
      };
    `);
    const history = query(filename, "SELECT * FROM collaboration_history_revisions");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1700000000123);
    try {
      await migrateSQLiteCoreV1ToV2({ filename });
    } finally {
      clock.mockRestore();
    }
    expect(query(filename, "SELECT unit_id, creator_id, created_at_ms FROM collaboration_units ORDER BY unit_id")).toEqual([
      { unit_id: "active", creator_id: "history-creator", created_at_ms: 1000 },
      { unit_id: "deleted", creator_id: "anonymous", created_at_ms: 1700000000123 },
    ]);
    const expected = typeof createTime === "number" && createTime >= 0 ? createTime * 1000 : 2500;
    const [stored] = query<{ created_at_ms: number; payload_json: string }>(
      filename, "SELECT created_at_ms, payload_json FROM collaboration_changesets",
    );
    expect(stored!.created_at_ms).toBe(expected);
    expect(JSON.parse(stored!.payload_json).createTime).toBe(Math.floor(expected / 1000));
    expect(query(filename, "SELECT * FROM collaboration_history_revisions")).toEqual(history);
  });

  it("uses one migration timestamp for everything when History is absent", async () => {
    exec(filename, "UPDATE collaboration_changesets SET payload_json = json_remove(payload_json, '$.createTime')");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1700000000123);
    try {
      await migrateSQLiteCoreV1ToV2({ filename });
    } finally {
      clock.mockRestore();
    }
    expect(query(filename, "SELECT creator_id, created_at_ms FROM collaboration_units")).toEqual([
      { creator_id: "anonymous", created_at_ms: 1700000000123 },
      { creator_id: "anonymous", created_at_ms: 1700000000123 },
    ]);
    expect(query(filename, "SELECT created_at_ms FROM collaboration_changesets")).toEqual([{ created_at_ms: 1700000000123 }]);
  });

  it.each([0, 100, 205])("visits every row exactly once across pages for %i Units", async (count) => {
    exec(filename, "DELETE FROM application_unit_links; DELETE FROM collaboration_changesets; DELETE FROM collaboration_snapshots; DELETE FROM collaboration_units;");
    const database = new Database(filename);
    try {
      database.exec("BEGIN IMMEDIATE");
      const unit = database.prepare("INSERT INTO collaboration_units VALUES (?, 2, 4, ?)");
      const change = database.prepare(
        "INSERT INTO collaboration_changesets (unit_id, revision, base_revision, sid, req_id, payload_json) VALUES (?, ?, ?, 's', ?, ?)",
      );
      for (let index = 0; index < count; index++) {
        const unitID = index === 0 ? "" : `unit-'${String(index).padStart(4, "0")}`;
        unit.run(unitID, index % 2 ? 123 : null);
        for (const revision of [2, 3, 4]) {
          change.run(unitID, revision, revision - 1, revision, JSON.stringify({ unitID, revision, createTime: 10, custom: `preserve-${index}-${revision}` }));
        }
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const before = dumpDatabase(filename);
    const visitedUnits: string[] = [];
    const visitedChangesets: [string, number][] = [];
    await migrateSQLiteCoreV1ToV2({
      filename,
      resolveUnitCreation: async (unitID) => {
        visitedUnits.push(unitID);
        return { creatorID: "creator", createdAt: 1234 };
      },
      resolveChangesetCreatedAt: async (unitID, revision) => {
        visitedChangesets.push([unitID, revision]);
        return 2345;
      },
    });
    const units = before.rows.collaboration_units as { unit_id: string }[];
    const changesets = before.rows.collaboration_changesets as { unit_id: string; revision: number; payload_json: string }[];
    expect(visitedUnits).toEqual(units.map((row) => row.unit_id));
    expect(visitedChangesets).toEqual(changesets.map((row) => [row.unit_id, row.revision]));
    expect(query(filename, "SELECT * FROM collaboration_units ORDER BY unit_id")).toEqual(
      units.map((row) => ({ ...row, creator_id: "creator", created_at_ms: 1234 })),
    );
    expect(query(filename, "SELECT * FROM collaboration_changesets ORDER BY unit_id, revision")).toEqual(
      changesets.map((row) => ({
        ...row,
        created_at_ms: 2345,
        payload_json: JSON.stringify({ ...JSON.parse(row.payload_json), createTime: 2 }),
      })),
    );
    expect(query(filename, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });
});
