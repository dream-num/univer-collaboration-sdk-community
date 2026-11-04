import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import {
  createHistoryDatabaseContext,
  createHistoryRecord,
} from "@univerjs-pro/collaboration-history-database-testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteHistoryDatabaseAdapter } from "../src/index.js";

const context = createHistoryDatabaseContext();

describe("SQLiteHistoryDatabaseAdapter", () => {
  let directory: string;
  let filename: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "univer-collab-history-sqlite-"));
    filename = join(directory, "history.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("requires a filename", () => {
    expect(() => new SQLiteHistoryDatabaseAdapter({ filename: "" })).toThrow(TypeError);
  });

  it("registers its schema version next to other components without touching the rest of the file", async () => {
    const database = new Database(filename);
    database.exec(`
      PRAGMA user_version = 17;
      CREATE TABLE application_data (id TEXT PRIMARY KEY);
      CREATE TABLE collaboration_schema_versions (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1)
      );
      INSERT INTO collaboration_schema_versions (component, version) VALUES ('core', 3);
    `);
    database.close();

    const adapter = new SQLiteHistoryDatabaseAdapter({ filename });
    await adapter.dispose();

    const inspect = new Database(filename);
    try {
      expect(inspect.prepare("SELECT component, version FROM collaboration_schema_versions ORDER BY component").all()).toMatchObject([
        { component: "core", version: 3 },
        { component: "history", version: 2 },
      ]);
      expect(inspect.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 17 });
      expect(inspect.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "delete" });
      expect(inspect.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'application_data'").get()).toMatchObject({
        name: "application_data",
      });
    } finally {
      inspect.close();
    }
  });

  it("rejects a different history schema version", () => {
    const database = new Database(filename);
    database.exec(`
      CREATE TABLE collaboration_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO collaboration_schema_versions (component, version) VALUES ('history', 99);
    `);
    database.close();

    expect(() => new SQLiteHistoryDatabaseAdapter({ filename })).toThrow(/version 99 is not supported .* upgrade the adapter/);
  });

  it("appends boundaries atomically across connections", async () => {
    const first = new SQLiteHistoryDatabaseAdapter({ filename });
    const second = new SQLiteHistoryDatabaseAdapter({ filename });
    try {
      expect(await first.appendRecord(context, createHistoryRecord(1), { expectedLatestStartRevision: null })).toEqual({
        status: "appended",
      });
      expect(await second.appendRecord(context, createHistoryRecord(2), { expectedLatestStartRevision: 1 })).toEqual({
        status: "appended",
      });
      const racing = await Promise.all([
        first.appendRecord(context, createHistoryRecord(3), { expectedLatestStartRevision: 2 }),
        second.appendRecord(context, createHistoryRecord(4), { expectedLatestStartRevision: 2 }),
      ]);
      expect(racing.map((result) => result.status).sort()).toEqual(["appended", "conflict"]);
      expect(await first.getLatestRecord(context, "unit-1")).toEqual(await second.getLatestRecord(context, "unit-1"));
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
