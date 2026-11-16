import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import { expect, it, vi } from "vitest";
import { createChangeset, createDatabaseContext, createWorktreeRecord, createWorktreeUnitRecord, createWorktreeUnitSeed } from "@univerjs-pro/collaboration-worktree-database-testkit";
import { SQLiteWorktreeDatabaseAdapter, migrateSQLiteWorktreeV2ToV3, migrateSQLiteWorktreeV3ToV4 } from "../../src/index.js";

it.each([undefined, 0, 1700000000])("uses resolved changeset time regardless of payload time %s across rollback and retry", async (createTime) => {
  const directory = await mkdtemp(join(tmpdir(), "worktree-migration-"));
  const filename = join(directory, "db.sqlite");
  const context = createDatabaseContext();
  try {
    const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });
    await adapter.createWorktree(context, { record: createWorktreeRecord("w"), units: [] });
    for (const unitID of ["a", "b"]) {
      await adapter.createUnit(context, { unit: createWorktreeUnitRecord({ worktreeID: "w", unitID, source: "worktree" }), seed: createWorktreeUnitSeed(unitID) });
    }
    const unit = createWorktreeUnitRecord({ worktreeID: "w", unitID: "a", source: "worktree" });
    await adapter.commitDraftChangeset(context, { unitMetadata: {}, worktreeID: "w", changeset: createChangeset({ unitID: "a", type: unit.type, revision: 2, sid: "s", reqId: 1 }) });
    await adapter.dispose();
    const legacy = new Database(filename);
    legacy.exec(`ALTER TABLE collaboration_worktree_changesets DROP COLUMN created_at_ms; ALTER TABLE collaboration_worktree_changesets DROP COLUMN metadata_json;
    ALTER TABLE collaboration_worktree_units DROP COLUMN creator_id;
      ALTER TABLE collaboration_worktree_units DROP COLUMN created_at_ms;
      ALTER TABLE collaboration_worktree_units DROP COLUMN metadata_json;
      UPDATE collaboration_schema_versions SET version = 2 WHERE component = 'worktree';`);
    const row = legacy.prepare("SELECT payload_json FROM collaboration_worktree_changesets").get() as { payload_json: string };
    legacy.prepare("UPDATE collaboration_worktree_changesets SET payload_json = ?").run(JSON.stringify({ ...JSON.parse(row.payload_json), createTime }));
    legacy.close();
    await expect(migrateSQLiteWorktreeV2ToV3({ filename, resolveChangesetCreatedAt: () => 1700000000123, resolveUnitCreation: async (_worktreeID, unitID) => {
      if (unitID === "b") throw new Error("missing creator");
      return { creatorID: "creator", createdAt: 1700000000123 };
    } })).rejects.toThrow("missing creator");
    for (const value of [undefined, null, -1, 1.5, NaN, Infinity, "throw"]) {
      await expect(migrateSQLiteWorktreeV2ToV3({
        filename,
        resolveUnitCreation: () => ({ creatorID: "creator", createdAt: 1 }),
        resolveChangesetCreatedAt: async (worktreeID, unitID, revision) => {
          expect([worktreeID, unitID, revision]).toEqual(["w", "a", 2]);
          if (value === "throw") throw new Error("missing history");
          return value as number;
        },
      })).rejects.toThrow();
    }
    const check = new Database(filename);
    expect(check.prepare("SELECT version FROM collaboration_schema_versions WHERE component = 'worktree'").get()).toMatchObject({ version: 2 });
    expect(check.prepare("PRAGMA table_info(collaboration_worktree_units)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "creator_id" })]));
    expect(check.prepare("SELECT COUNT(*) AS n FROM collaboration_worktree_unit_seeds").get()).toMatchObject({ n: 2 });
    check.close();
    await migrateSQLiteWorktreeV2ToV3({ filename, resolveChangesetCreatedAt: () => 1700000000123, resolveUnitCreation: (worktreeID, unitID) => ({ creatorID: `${worktreeID}-${unitID}`, createdAt: 1700000000123 }) });
    migrateSQLiteWorktreeV3ToV4({ filename });
    const reopened = new SQLiteWorktreeDatabaseAdapter({ filename });
    expect(await reopened.getUnitSeed(context, "w", "b")).toEqual(createWorktreeUnitSeed("b"));
    expect(await reopened.getWorktreeUnit(context, "w", "b")).toMatchObject({ creatorID: "w-b", createdAt: 1700000000123 });
    const changesets = await reopened.getDraftChangesets(context, "w", "a", { from: 1 });
    expect(changesets?.[0].createTime).toBe(1700000000);
    await reopened.dispose();
    const storedDatabase = new Database(filename);
    const stored = storedDatabase.prepare("SELECT created_at_ms, payload_json FROM collaboration_worktree_changesets").get() as { created_at_ms: number | null; payload_json: string };
    expect(stored.created_at_ms).toBe(1700000000123);
    expect(JSON.parse(stored.payload_json).createTime).toBe(Math.floor(stored.created_at_ms! / 1000));
    expect(() => storedDatabase.exec("UPDATE collaboration_worktree_changesets SET created_at_ms = NULL")).toThrow();
    storedDatabase.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(["trunk", "worktree"] as const)("defaults creation facts for %s without confusing draft and trunk revisions", async (source) => {
  const directory = await mkdtemp(join(tmpdir(), "worktree-default-migration-"));
  const filename = join(directory, "db.sqlite");
  const context = createDatabaseContext();
  try {
    const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });
    const unit = createWorktreeUnitRecord({ worktreeID: "w", unitID: "a", source });
    await adapter.createWorktree(context, { record: createWorktreeRecord("w"), units: source === "trunk" ? [unit] : [] });
    if (source === "worktree") await adapter.createUnit(context, { unit, seed: createWorktreeUnitSeed("a") });
    await adapter.commitDraftChangeset(context, { unitMetadata: {}, worktreeID: "w", changeset: createChangeset({ unitID: "a", type: unit.type, revision: 2, sid: "s", reqId: 1 }) });
    await adapter.dispose();
    const legacy = new Database(filename);
    legacy.exec(`ALTER TABLE collaboration_worktree_changesets DROP COLUMN created_at_ms; ALTER TABLE collaboration_worktree_changesets DROP COLUMN metadata_json;
      ALTER TABLE collaboration_worktree_units DROP COLUMN creator_id;
      ALTER TABLE collaboration_worktree_units DROP COLUMN created_at_ms;
      ALTER TABLE collaboration_worktree_units DROP COLUMN metadata_json;
      UPDATE collaboration_schema_versions SET version = 2 WHERE component = 'worktree';
      UPDATE collaboration_worktree_changesets SET payload_json = json_remove(payload_json, '$.createTime');
      CREATE TABLE collaboration_history_revisions (unit_id TEXT, revision INTEGER, user_id TEXT, committed_at INTEGER);
      INSERT INTO collaboration_history_revisions VALUES ('a', 1, 'trunk-creator', 1000), ('a', 2, 'editor', 2000);`);
    legacy.close();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1700000000123);
    try { await migrateSQLiteWorktreeV2ToV3({ filename }); } finally { clock.mockRestore(); }
    const migrated = new Database(filename);
    expect(migrated.prepare("SELECT creator_id, created_at_ms FROM collaboration_worktree_units").get()).toMatchObject(source === "trunk"
      ? { creator_id: "trunk-creator", created_at_ms: 1000 }
      : { creator_id: "anonymous", created_at_ms: 1700000000123 });
    expect(migrated.prepare("SELECT created_at_ms FROM collaboration_worktree_changesets").get()).toMatchObject({ created_at_ms: 1700000000123 });
    migrated.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
