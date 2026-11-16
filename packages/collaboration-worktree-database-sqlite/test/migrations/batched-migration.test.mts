import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import { expect, it } from "vitest";
import { SQLiteWorktreeDatabaseAdapter, migrateSQLiteWorktreeV2ToV3, migrateSQLiteWorktreeV3ToV4 } from "../../src/index.js";

async function fixture(count: number, run: (filename: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "worktree-migration-batches-"));
  const filename = join(directory, "db.sqlite");
  try {
    const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });
    await adapter.dispose();
    const db = new Database(filename);
    try {
      db.exec(`ALTER TABLE collaboration_worktree_units DROP COLUMN creator_id;
        ALTER TABLE collaboration_worktree_units DROP COLUMN created_at_ms;
        ALTER TABLE collaboration_worktree_units DROP COLUMN metadata_json;
        ALTER TABLE collaboration_worktree_changesets DROP COLUMN created_at_ms; ALTER TABLE collaboration_worktree_changesets DROP COLUMN metadata_json;
        UPDATE collaboration_schema_versions SET version = 2 WHERE component = 'worktree';
        BEGIN IMMEDIATE;`);

    db.exec("INSERT INTO collaboration_worktrees VALUES ('', 's0', 'draft'), ('w-雪', 's1', 'draft')");
    const unit = db.prepare(`INSERT INTO collaboration_worktree_units
      (removed, worktree_id, unit_id, unit_order, type, source, baseline_trunk_revision, draft_head_revision)
      VALUES (?, ?, ?, ?, 2, 'worktree', 1, 4)`);
    const change = db.prepare(`INSERT INTO collaboration_worktree_changesets
      (worktree_id, unit_id, revision, base_revision, sid, req_id, payload_json) VALUES (?, ?, ?, ?, 's', ?, ?)`);
    for (const worktreeID of ['', 'w-雪']) {
      for (let i = 0; i < count; i++) {
        const unitID = i === 0 ? '' : `unit-'${String(i).padStart(4, '0')}`;
        unit.run(i % 2, worktreeID, unitID, i);
        for (const revision of [2, 3, 4]) {
          change.run(worktreeID, unitID, revision, revision - 1, revision, JSON.stringify({ unitID, revision, createTime: 10, custom: `preserve-${worktreeID}-${i}-${revision}` }));
        }
      }
    }

      db.exec("COMMIT");
    } finally { db.close(); }
    await run(filename);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function inspect(filename: string) {
  const db = new Database(filename);
  try {
    return {
      schema: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(),
      versions: db.prepare("SELECT * FROM collaboration_schema_versions ORDER BY component").all(),
      units: db.prepare("SELECT * FROM collaboration_worktree_units ORDER BY worktree_id, unit_id").all() as Record<string, any>[],
      changesets: db.prepare("SELECT * FROM collaboration_worktree_changesets ORDER BY worktree_id, unit_id, revision").all() as Record<string, any>[],
    };
  } finally { db.close(); }
}

async function verifyMigration(filename: string) {
  const before = inspect(filename);
  const units: unknown[][] = [];
  const changesets: unknown[][] = [];
  await migrateSQLiteWorktreeV2ToV3({
    filename,
    resolveUnitCreation: async (...key) => {
      units.push(key);
      return { creatorID: "creator", createdAt: 1234 };
    },
    resolveChangesetCreatedAt: async (...key) => { changesets.push(key); return 2345; },
  });
  expect(units).toEqual(before.units.map(row => [row.worktree_id, row.unit_id]));
  expect(changesets).toEqual(before.changesets.map(row => [row.worktree_id, row.unit_id, row.revision]));
  const after = inspect(filename);
  expect(after.units).toEqual(before.units.map(row => ({ ...row, creator_id: "creator", created_at_ms: 1234 })));
  expect(after.changesets).toEqual(before.changesets.map(row => ({
    ...row, created_at_ms: 2345,
    payload_json: JSON.stringify({ ...JSON.parse(row.payload_json), createTime: 2 }),
  })));
  expect(after.versions).toEqual([{ component: "worktree", version: 3 }]);
  const db = new Database(filename);
  try {
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
  } finally { db.close(); }
  migrateSQLiteWorktreeV3ToV4({ filename });
  const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });
  await adapter.dispose();
}

it.each([0, 100, 205])("preserves every column and visits every composite key exactly once for %i Units", async count => {
  await fixture(count, verifyMigration);
});

it.each(["units", "changesets"])("rolls back late %s failures and permits a complete retry", async phase => {
  await fixture(205, async filename => {
    const before = inspect(filename);
    let visited = 0;
    await expect(migrateSQLiteWorktreeV2ToV3({
      filename,
      resolveUnitCreation: async () => {
        if (phase === "units" && ++visited === 105) throw new Error("late batch failure");
        return { creatorID: "creator", createdAt: 1234 };
      },
      resolveChangesetCreatedAt: async () => {
        if (phase === "changesets" && ++visited === 205) throw new Error("late batch failure");
        return 2345;
      },
    })).rejects.toThrow("late batch failure");
    expect(inspect(filename)).toEqual(before);
    await verifyMigration(filename);
  });
});
