import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import { expect, it } from "vitest";
import {
  createChangeset,
  createDatabaseContext,
  createWorktreeRecord,
  createWorktreeUnitRecord,
} from "@univerjs-pro/collaboration-worktree-database-testkit";
import { SQLiteWorktreeDatabaseAdapter, migrateSQLiteWorktreeV3ToV4 } from "../../src/index.js";

it("migrates Unit and historical changeset metadata atomically and preserves it across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worktree-metadata-migration-"));
  const filename = join(directory, "db.sqlite");
  const context = createDatabaseContext();
  try {
    const unit = createWorktreeUnitRecord({ worktreeID: "w", unitID: "u" });
    const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });
    await adapter.createWorktree(context, { record: createWorktreeRecord("w"), units: [unit] });
    await adapter.commitDraftChangeset(context, {
      unitMetadata: {},
      worktreeID: "w", changeset: createChangeset({ unitID: "u", type: unit.type, revision: 2, sid: "s", reqId: 1 }),
    });
    await adapter.dispose();
    const legacy = new Database(filename);
    const originalPayload = (legacy.prepare("SELECT payload_json FROM collaboration_worktree_changesets").get() as { payload_json: string }).payload_json;
    legacy.exec(`
      ALTER TABLE collaboration_worktree_units DROP COLUMN metadata_json;
      ALTER TABLE collaboration_worktree_changesets DROP COLUMN metadata_json;
      UPDATE collaboration_schema_versions SET version = 3 WHERE component = 'worktree';
      CREATE TRIGGER reject_metadata_migration BEFORE UPDATE ON collaboration_schema_versions
      BEGIN SELECT RAISE(ABORT, 'migration failure'); END;
    `);
    legacy.close();
    expect(() => migrateSQLiteWorktreeV3ToV4({ filename })).toThrow("migration failure");
    const check = new Database(filename);
    expect(check.prepare("PRAGMA table_info(collaboration_worktree_units)").all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "metadata_json" })])
    );
    expect(check.prepare("PRAGMA table_info(collaboration_worktree_changesets)").all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "metadata_json" })])
    );
    expect(check.prepare("SELECT version FROM collaboration_schema_versions WHERE component = 'worktree'").get()).toMatchObject({ version: 3 });
    expect(check.prepare("SELECT payload_json FROM collaboration_worktree_changesets").get()).toMatchObject({ payload_json: originalPayload });
    check.exec("DROP TRIGGER reject_metadata_migration;");
    check.close();
    migrateSQLiteWorktreeV3ToV4({ filename });
    const storage = new Database(filename);
    expect(storage.prepare("SELECT payload_json FROM collaboration_worktree_changesets").get()).toMatchObject({ payload_json: originalPayload });
    expect(storage.prepare("SELECT metadata_json FROM collaboration_worktree_changesets").get()).toMatchObject({ metadata_json: "{}" });
    for (const table of ["collaboration_worktree_changesets", "collaboration_worktree_units"]) {
      const updateMetadata = storage.prepare(`UPDATE ${table} SET metadata_json = ?`);
      for (const valid of ["[]", "null", "1", '"text"', "true"]) {
        updateMetadata.run(valid);
        expect(storage.prepare(`SELECT metadata_json FROM ${table}`).get()).toMatchObject({ metadata_json: valid });
      }
      for (const invalid of ["not-json", null]) {
        expect(() => updateMetadata.run(invalid)).toThrow();
      }
      updateMetadata.run("{}");
    }
    storage.close();
    const migrated = new SQLiteWorktreeDatabaseAdapter({ filename });
    expect((await migrated.getWorktreeUnit(context, "w", "u"))!.metadata).toEqual({});
    expect((await migrated.getDraftChangesets(context, "w", "u", { from: 1 }))![0].metadata).toEqual({});
    await migrated.commitDraftChangeset(context, {
      worktreeID: "w",
      changeset: createChangeset({ unitID: "u", type: unit.type, revision: 3, sid: "s", reqId: 2, metadata: { reason: "edited" } }),
      unitMetadata: { name: "Persistent" },
    });
    await migrated.dispose();
    const reopened = new SQLiteWorktreeDatabaseAdapter({ filename });
    expect((await reopened.getWorktreeUnit(context, "w", "u"))!.metadata).toEqual({ name: "Persistent" });
    expect((await reopened.getDraftChangesets(context, "w", "u", { from: 2 }))![0].metadata).toEqual({ reason: "edited" });
    await reopened.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
