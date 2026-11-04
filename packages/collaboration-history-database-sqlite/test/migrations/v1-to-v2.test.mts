import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistoryDatabaseContext } from "@univerjs-pro/collaboration-history-database-testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateSQLiteHistoryV1ToV2, SQLiteHistoryDatabaseAdapter } from "../../src/index.js";
import { createV1Database, dumpDatabase, exec, query } from "./fixtures.mjs";

const context = createHistoryDatabaseContext();

describe("migrateSQLiteHistoryV1ToV2", () => {
  let directory: string;
  let filename: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "univer-collab-history-v1-"));
    filename = join(directory, "history.sqlite");
    createV1Database(filename);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("is named by the adapter error for a v1 database, which stays unchanged", () => {
    const before = dumpDatabase(filename);
    expect(() => new SQLiteHistoryDatabaseAdapter({ filename })).toThrow(/version 1 is not supported .* run migrateSQLiteHistory first/);
    expect(dumpDatabase(filename)).toEqual(before);
  });

  it("keeps segment boundaries with their facts and leaves other components alone", async () => {
    await migrateSQLiteHistoryV1ToV2({ filename });
    const adapter = new SQLiteHistoryDatabaseAdapter({ filename });
    try {
      const page = await adapter.listRecords(context, "u", { throughRevision: 20, length: 10 });
      expect(page.records.map(({ record, endRevision }) => [record.startRevision, endRevision, record.userID, record.createdAt])).toEqual([
        [4, 20, "bot", 4004],
        [2, 3, "a", 2002],
        [1, 1, "creator", 1001],
      ]);
      expect(page.records[0]?.record.additionalFields).toBe('{"origin":2}');
    } finally {
      await adapter.dispose();
    }
    expect(query(filename, "SELECT * FROM application_data")).toEqual([{ id: "keep" }]);
    expect(query(filename, "PRAGMA user_version")).toEqual([{ user_version: 17 }]);
    expect(query(filename, "SELECT component, version FROM collaboration_schema_versions ORDER BY component")).toEqual([
      { component: "application", version: 7 },
      { component: "core", version: 3 },
      { component: "history", version: 2 },
    ]);
    expect(query(filename, "SELECT name FROM sqlite_schema WHERE name = 'collaboration_history_revisions'")).toEqual([]);
    await expect(migrateSQLiteHistoryV1ToV2({ filename })).rejects.toThrow("requires history schema version 1");
  });

  it("preserves origin values without interpreting them", async () => {
    exec(filename, "UPDATE collaboration_history_revisions SET origin = 12 WHERE revision = 4");
    await migrateSQLiteHistoryV1ToV2({ filename });
    const adapter = new SQLiteHistoryDatabaseAdapter({ filename });
    try {
      expect(await adapter.getLatestRecord(context, "u")).toMatchObject({ origin: 12 });
    } finally {
      await adapter.dispose();
    }
  });

  it.each([
    ["a segment's starting revision is missing", "DELETE FROM collaboration_history_revisions WHERE revision = 2", "starting revision"],
    ["a persisted time is not an integer", "UPDATE collaboration_history_revisions SET committed_at = 1.5 WHERE revision = 2", "invalid segment"],
    ["the same file still has core schema v1", "UPDATE collaboration_schema_versions SET version = 1 WHERE component = 'core'", "Core v1 before History"],
    ["the same file still has an old Worktree schema", "INSERT INTO collaboration_schema_versions VALUES ('worktree', 2)", "Worktree before History"],
    ["an index name is already taken", "CREATE INDEX collaboration_history_origin_lookup ON application_data(id)", "already exists"],
  ])("rolls back everything when %s", async (_name, sql, message) => {
    exec(filename, sql);
    const before = dumpDatabase(filename);
    await expect(migrateSQLiteHistoryV1ToV2({ filename })).rejects.toThrow(message);
    expect(dumpDatabase(filename)).toEqual(before);
  });
});
