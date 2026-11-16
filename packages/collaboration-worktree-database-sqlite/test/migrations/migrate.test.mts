import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateSQLiteWorktree, SQLiteWorktreeDatabaseAdapter } from "../../src/index.js";

describe("migrateSQLiteWorktree", () => {
  let directory: string;
  let filename: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "worktree-upgrade-"));
    filename = join(directory, "db.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function exec(sql: string): void {
    const database = new Database(filename);
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
  }

  it("resumes at the last committed step and preserves existing backups", async () => {
    await new SQLiteWorktreeDatabaseAdapter({ filename }).dispose();
    exec(`
      ALTER TABLE collaboration_worktree_units DROP COLUMN creator_id;
      ALTER TABLE collaboration_worktree_units DROP COLUMN created_at_ms;
      ALTER TABLE collaboration_worktree_units DROP COLUMN metadata_json;
      ALTER TABLE collaboration_worktree_changesets DROP COLUMN created_at_ms;
      ALTER TABLE collaboration_worktree_changesets DROP COLUMN metadata_json;
      UPDATE collaboration_schema_versions SET version = 2 WHERE component = 'worktree';
      CREATE TRIGGER reject_v4 BEFORE UPDATE ON collaboration_schema_versions WHEN NEW.version = 4
      BEGIN SELECT RAISE(ABORT, 'reject v4'); END;
    `);
    await expect(migrateSQLiteWorktree({ filename })).rejects.toThrow("reject v4");
    const backupFilename = join(directory, "retry.sqlite");
    await writeFile(backupFilename, "keep me");
    exec("DROP TRIGGER reject_v4");
    await expect(migrateSQLiteWorktree({ filename, backupFilename })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(backupFilename, "utf8")).toBe("keep me");
    const retryBackup = join(directory, "before-v4.sqlite");
    await expect(migrateSQLiteWorktree({ filename, backupFilename: retryBackup })).resolves.toEqual({
      from: 3, to: 4, backupFilename: retryBackup,
    });
    for (const [path, version] of [[`${filename}.worktree-v2.backup`, 2], [retryBackup, 3]] as const) {
      const backup = new Database(path, { readonly: true });
      try {
        expect(backup.prepare("SELECT version FROM collaboration_schema_versions WHERE component = 'worktree'").get()).toMatchObject({ version });
      } finally {
        backup.close();
      }
    }
  });

  it("skips the backup for a current database", async () => {
    await new SQLiteWorktreeDatabaseAdapter({ filename }).dispose();
    await expect(migrateSQLiteWorktree({ filename })).resolves.toEqual({ from: 4, to: 4 });
    expect(await readdir(directory)).toEqual(["db.sqlite"]);
  });

  it("rejects a missing file or Worktree version and refuses newer schemas", async () => {
    await expect(migrateSQLiteWorktree({ filename })).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    exec("CREATE TABLE unrelated(id INTEGER)");
    await expect(migrateSQLiteWorktree({ filename })).rejects.toThrow("no Worktree schema version");
    exec("CREATE TABLE collaboration_schema_versions(component TEXT PRIMARY KEY, version INTEGER); INSERT INTO collaboration_schema_versions VALUES ('core', 4)");
    await expect(migrateSQLiteWorktree({ filename })).rejects.toThrow("no Worktree schema version");
    exec("INSERT INTO collaboration_schema_versions VALUES ('worktree', 5)");
    await expect(migrateSQLiteWorktree({ filename })).rejects.toThrow("newer than this package supports");
    expect(await readdir(directory)).toEqual(["db.sqlite"]);
  });
});
