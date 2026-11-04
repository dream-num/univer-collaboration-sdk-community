import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistoryDatabaseContext } from "@univerjs-pro/collaboration-history-database-testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateSQLiteHistory, SQLiteHistoryDatabaseAdapter } from "../../src/index.js";
import { createV1Database, dumpDatabase, exec, query } from "./fixtures.mjs";

const context = createHistoryDatabaseContext();

describe("migrateSQLiteHistory", () => {
  let directory: string;
  let filename: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "univer-collab-history-migrate-"));
    filename = join(directory, "history.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("backs up a v1 database and migrates it", async () => {
    createV1Database(filename);
    const before = dumpDatabase(filename);
    const result = await migrateSQLiteHistory({ filename });
    expect(result).toEqual({ from: 1, to: 2, backupFilename: `${filename}.history-v1.backup` });
    expect(dumpDatabase(result.backupFilename!)).toEqual(before);
    const adapter = new SQLiteHistoryDatabaseAdapter({ filename });
    try {
      expect(await adapter.getLatestRecord(context, "u")).toMatchObject({ startRevision: 4, userID: "bot" });
    } finally {
      await adapter.dispose();
    }
  });

  it("writes the backup to the path the caller chose", async () => {
    createV1Database(filename);
    const backupFilename = join(directory, "before-upgrade.sqlite");
    await expect(migrateSQLiteHistory({ filename, backupFilename })).resolves.toEqual({ from: 1, to: 2, backupFilename });
    expect(query(backupFilename, "SELECT version FROM collaboration_schema_versions WHERE component = 'history'")).toEqual([{ version: 1 }]);
  });

  it("does nothing and writes no backup for a current database", async () => {
    await new SQLiteHistoryDatabaseAdapter({ filename }).dispose();
    const before = dumpDatabase(filename);
    await expect(migrateSQLiteHistory({ filename })).resolves.toEqual({ from: 2, to: 2 });
    expect(dumpDatabase(filename)).toEqual(before);
    await expect(stat(`${filename}.history-v2.backup`)).rejects.toThrow();
  });

  it("refuses to overwrite an existing backup and leaves the database unchanged", async () => {
    createV1Database(filename);
    await writeFile(`${filename}.history-v1.backup`, "keep me");
    const before = dumpDatabase(filename);
    await expect(migrateSQLiteHistory({ filename })).rejects.toThrow("Backup target already exists");
    expect(dumpDatabase(filename)).toEqual(before);
    expect(await readFile(`${filename}.history-v1.backup`, "utf8")).toBe("keep me");
  });

  it("keeps the backup when a step fails", async () => {
    createV1Database(filename);
    exec(filename, "UPDATE collaboration_schema_versions SET version = 1 WHERE component = 'core'");
    await expect(migrateSQLiteHistory({ filename })).rejects.toThrow("Core v1 before History");
    expect(query(filename, "SELECT version FROM collaboration_schema_versions WHERE component = 'history'")).toEqual([{ version: 1 }]);
    expect(query(`${filename}.history-v1.backup`, "SELECT version FROM collaboration_schema_versions WHERE component = 'history'")).toEqual([{ version: 1 }]);
  });

  it.each([
    ["no version table", "CREATE TABLE unrelated (id INTEGER)"],
    ["no history row", "CREATE TABLE collaboration_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL)"],
  ])("rejects a database with %s", async (_name, sql) => {
    exec(filename, sql);
    await expect(migrateSQLiteHistory({ filename })).rejects.toThrow("no history schema version");
  });

  it("rejects a database written by a newer package", async () => {
    exec(filename, `
      CREATE TABLE collaboration_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO collaboration_schema_versions VALUES ('history', 3);
    `);
    await expect(migrateSQLiteHistory({ filename })).rejects.toThrow("newer than this package supports");
  });
});
