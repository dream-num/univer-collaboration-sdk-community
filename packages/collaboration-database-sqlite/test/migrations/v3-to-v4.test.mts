import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode } from "@msgpack/msgpack";
import Database from "libsql";
import { createChangeset, createDatabaseContext } from "@univerjs-pro/collaboration-database-testkit";
import { UniverType } from "@univerjs/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateSQLiteCore, migrateSQLiteCoreV3ToV4, SQLiteDatabaseAdapter } from "../../src/index.js";
import { CORE_SCHEMA_V3_SQL } from "../../src/migrations/schema-v3.js";
import { dumpDatabase, exec, query } from "./fixtures.mjs";

describe("SQLite core metadata migration", () => {
  let directory: string;
  let filename: string;
  const context = createDatabaseContext();
  const type = UniverType.UNIVER_DOC;
  const changeset = createChangeset({ unitID: "active", type, revision: 2, sid: "s", reqId: 1 });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "univer-collab-v3-"));
    filename = join(directory, "collaboration.sqlite");
    const database = new Database(filename);
    try {
      database.exec(`
        CREATE TABLE collaboration_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
        INSERT INTO collaboration_schema_versions VALUES ('core', 3), ('other', 7);
        ${CORE_SCHEMA_V3_SQL}
        INSERT INTO collaboration_units VALUES
          ('active', ${type}, 2, 'alice', 1000, NULL, NULL),
          ('soft', ${type}, 1, 'bob', 2000, 2500, 'soft'),
          ('gone', ${type}, 1, 'carol', 3000, 3500, 'hard');
        CREATE VIEW application_units AS SELECT unit_id FROM collaboration_units;
      `);
      database.prepare("INSERT INTO collaboration_changesets VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("active", 2, 1, "s", 1, 1700000000000, encode(
          Object.fromEntries(Object.entries(changeset).filter(([key]) => key !== "metadata")),
        ));
    } finally {
      database.close();
    }
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("requires an explicit upgrade and preserves existing content with empty metadata", async () => {
    const before = dumpDatabase(filename);
    expect(() => new SQLiteDatabaseAdapter({ filename })).toThrow(/expected 4.*migrateSQLiteCore/);
    expect(dumpDatabase(filename)).toEqual(before);

    await expect(migrateSQLiteCore({ filename })).resolves.toEqual({
      from: 3, to: 4, backupFilename: `${filename}.v3.backup`,
    });
    expect(dumpDatabase(`${filename}.v3.backup`)).toEqual(before);
    expect(query(filename, "SELECT component, version FROM collaboration_schema_versions ORDER BY component"))
      .toEqual([{ component: "core", version: 4 }, { component: "other", version: 7 }]);
    expect(query(filename, "SELECT metadata FROM collaboration_units")).toEqual([
      { metadata: "{}" }, { metadata: "{}" }, { metadata: "{}" },
    ]);
    expect(query(filename, "SELECT metadata FROM collaboration_changesets")).toEqual([{ metadata: "{}" }]);
    expect(query(filename, "SELECT payload FROM collaboration_changesets"))
      .toEqual(query(`${filename}.v3.backup`, "SELECT payload FROM collaboration_changesets"));
    expect(query(filename, "SELECT * FROM application_units ORDER BY unit_id"))
      .toEqual([{ unit_id: "active" }, { unit_id: "gone" }, { unit_id: "soft" }]);
    const adapter = new SQLiteDatabaseAdapter({ filename });
    try {
      await expect(adapter.getUnit(context, "active")).resolves.toMatchObject({ headRevision: 2, metadata: {} });
      await expect(adapter.getChangesets(context, "active", { from: 1 })).resolves.toEqual([
        { ...changeset, metadata: {} },
      ]);
      await expect(adapter.getUnit(context, "soft")).resolves.toBeNull();
      await adapter.recoverUnits(context, { unitIDs: ["soft"] });
      await expect(adapter.getUnit(context, "soft")).resolves.toMatchObject({ metadata: {} });
      await expect(adapter.getUnit(context, "gone")).resolves.toBeNull();
    } finally {
      await adapter.dispose();
    }
  });

  it("rolls back both metadata columns if the schema version cannot be advanced", async () => {
    exec(filename, `CREATE TRIGGER reject_core_upgrade BEFORE UPDATE ON collaboration_schema_versions
      WHEN OLD.component = 'core' BEGIN SELECT RAISE(ABORT, 'reject version'); END;`);
    const before = dumpDatabase(filename);
    await expect(migrateSQLiteCore({ filename })).rejects.toThrow("reject version");
    expect(dumpDatabase(filename)).toEqual(before);
  });

  it("requires non-null JSON metadata without restricting its type in fresh and migrated databases", async () => {
    await migrateSQLiteCoreV3ToV4({ filename });
    const fresh = join(directory, "fresh.sqlite");
    await new SQLiteDatabaseAdapter({ filename: fresh }).dispose();
    for (const table of ["collaboration_units", "collaboration_changesets"]) {
      expect(query(filename, `PRAGMA table_info(${table})`)).toEqual(query(fresh, `PRAGMA table_info(${table})`));
    }
    exec(fresh, `INSERT INTO collaboration_units (unit_id, type, head_revision, creator_id, created_at_ms)
      VALUES ('fresh', ${type}, 2, 'alice', 1000);
      INSERT INTO collaboration_changesets (unit_id, revision, base_revision, sid, req_id, created_at_ms, payload)
      VALUES ('fresh', 2, 1, 's', 1, 1000, X'80');`);
    for (const database of [filename, fresh]) {
      for (const table of ["collaboration_units", "collaboration_changesets"]) {
        // Object shape is a Service contract; SQL only requires non-null JSON.
        expect(() => exec(database, `UPDATE ${table} SET metadata = '[]'`)).not.toThrow();
        expect(query(database, `SELECT metadata FROM ${table}`)).toEqual(
          expect.arrayContaining([{ metadata: "[]" }]),
        );
        expect(() => exec(database, `UPDATE ${table} SET metadata = NULL`)).toThrow(/NOT NULL/);
        expect(() => exec(database, `UPDATE ${table} SET metadata = '{broken'`)).toThrow(/CHECK/);
      }
    }
  });
});
