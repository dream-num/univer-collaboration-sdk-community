import { readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChangeset, createDatabaseContext, createSnapshot } from "@univerjs-pro/collaboration-database-testkit";
import { UniverType } from "@univerjs/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateSQLiteCore, SQLiteDatabaseAdapter } from "../../src/index.js";
import { createV1Database, createV2Database, dumpDatabase, encodeLegacy, exec, query } from "./fixtures.mjs";

describe("migrateSQLiteCore", () => {
  let directory: string;
  let filename: string;
  const context = createDatabaseContext();
  const type = UniverType.UNIVER_DOC;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "univer-collab-migrate-"));
    filename = join(directory, "collaboration.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function seedV2(): void {
    createV2Database(filename);
    exec(filename, `
      INSERT INTO collaboration_units VALUES ('active', ${type}, 2, 'alice', 1000, NULL);
      INSERT INTO collaboration_snapshots VALUES ('active', 1, ${type}, '${encodeLegacy(createSnapshot("active", type, 1))}');
      INSERT INTO collaboration_changesets VALUES
        ('active', 2, 1, 's', 1, 1700000000000, '${encodeLegacy({ ...createChangeset({ unitID: "active", type, revision: 2, sid: "s", reqId: 1 }), createTime: 1700000000 })}');
    `);
  }

  it("backs up a v1 database and migrates it through every step", async () => {
    createV1Database(filename);
    exec(filename, `
      INSERT INTO collaboration_units VALUES ('active', ${type}, 1, NULL);
      INSERT INTO collaboration_snapshots VALUES ('active', 1, ${type}, '${encodeLegacy(createSnapshot("active", type, 1))}');
    `);
    const original = await readFile(filename);
    const before = dumpDatabase(filename);

    const result = await migrateSQLiteCore({
      filename,
      resolveUnitCreation: () => ({ creatorID: "creator", createdAt: 1700000000000 }),
    });

    expect(result).toEqual({ from: 1, to: 3, backupFilename: `${filename}.v1.backup` });
    // The backup is a consistent copy of the v1 file, not a byte copy of a possibly dirty one.
    expect(dumpDatabase(result.backupFilename!)).toEqual(before);
    expect((await stat(result.backupFilename!)).size).toBe(original.length);
    expect(query(filename, "SELECT version FROM collaboration_schema_versions WHERE component = 'core'")).toEqual([{ version: 3 }]);

    const adapter = new SQLiteDatabaseAdapter({ filename });
    try {
      await expect(adapter.getUnit(context, "active")).resolves.toEqual({
        unitID: "active", type, headRevision: 1, creatorID: "creator", createdAt: 1700000000000,
      });
    } finally {
      await adapter.dispose();
    }
  });

  it("migrates a v2 database to the backup path the caller chose", async () => {
    seedV2();
    const backupFilename = join(directory, "before-upgrade.sqlite");
    await expect(migrateSQLiteCore({ filename, backupFilename })).resolves.toEqual({ from: 2, to: 3, backupFilename });
    expect(query(backupFilename, "SELECT version FROM collaboration_schema_versions")).toEqual([{ version: 2 }]);
    const adapter = new SQLiteDatabaseAdapter({ filename });
    try {
      await expect(adapter.getChangesets(context, "active", { from: 1 })).resolves.toMatchObject([{ revision: 2, createTime: 1700000000 }]);
    } finally {
      await adapter.dispose();
    }
  });

  it("does nothing and writes no backup for a current database", async () => {
    await new SQLiteDatabaseAdapter({ filename }).dispose();
    const before = dumpDatabase(filename);
    await expect(migrateSQLiteCore({ filename })).resolves.toEqual({ from: 3, to: 3 });
    expect(dumpDatabase(filename)).toEqual(before);
    await expect(stat(`${filename}.v3.backup`)).rejects.toThrow();
  });

  it("refuses to overwrite an existing backup and leaves the database unchanged", async () => {
    seedV2();
    await writeFile(`${filename}.v2.backup`, "keep me");
    const before = dumpDatabase(filename);
    await expect(migrateSQLiteCore({ filename })).rejects.toThrow("Backup target already exists");
    expect(dumpDatabase(filename)).toEqual(before);
    expect(await readFile(`${filename}.v2.backup`, "utf8")).toBe("keep me");
  });

  it("stops at the last complete version when a later step fails and continues on the next call", async () => {
    createV1Database(filename);
    exec(filename, `
      INSERT INTO collaboration_units VALUES ('active', ${type}, 1, NULL);
      INSERT INTO collaboration_snapshots VALUES ('active', 1, ${type}, '{broken');
    `);
    const resolvers = { resolveUnitCreation: () => ({ creatorID: "creator", createdAt: 1 }) };
    // V1 to v2 never reads snapshot payloads, v2 to v3 re-encodes them, so the second step fails.
    await expect(migrateSQLiteCore({ filename, ...resolvers })).rejects.toThrow();
    expect(query(filename, "SELECT version FROM collaboration_schema_versions WHERE component = 'core'")).toEqual([{ version: 2 }]);
    expect(query(`${filename}.v1.backup`, "SELECT version FROM collaboration_schema_versions WHERE component = 'core'")).toEqual([{ version: 1 }]);

    exec(filename, `UPDATE collaboration_snapshots SET payload_json = '${encodeLegacy(createSnapshot("active", type, 1))}'`);
    await expect(migrateSQLiteCore({ filename, ...resolvers })).resolves.toEqual({
      from: 2, to: 3, backupFilename: `${filename}.v2.backup`,
    });
  });

  it.each([
    ["no version table", "CREATE TABLE unrelated (id INTEGER)"],
    ["no core row", "CREATE TABLE collaboration_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL)"],
  ])("rejects a database with %s", async (_name, sql) => {
    exec(filename, sql);
    await expect(migrateSQLiteCore({ filename })).rejects.toThrow("no core schema version");
  });

  it("rejects a database written by a newer package", async () => {
    exec(filename, `
      CREATE TABLE collaboration_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO collaboration_schema_versions VALUES ('core', 4);
    `);
    await expect(migrateSQLiteCore({ filename })).rejects.toThrow("newer than this package supports");
  });

  it("rejects a missing file", async () => {
    await expect(migrateSQLiteCore({ filename: join(directory, "missing.sqlite") })).rejects.toThrow();
  });
});
