import type { Pool } from "pg";
import { transaction } from "./transaction.js";

const SCHEMA_VERSION = 1;
const WORKTREE_SCHEMA_SQL = `
  CREATE TABLE collaboration.worktrees (
    worktree_id TEXT PRIMARY KEY,
    sid TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft','ready','merging','merged','discarded'))
  );
  CREATE TABLE collaboration.worktree_units (
    worktree_id TEXT NOT NULL REFERENCES collaboration.worktrees ON DELETE CASCADE,
    unit_id TEXT NOT NULL,
    unit_order INTEGER NOT NULL CHECK (unit_order >= 0),
    type INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('trunk','worktree')),
    baseline_trunk_revision BIGINT CHECK (baseline_trunk_revision >= 1),
    draft_head_revision BIGINT NOT NULL CHECK (draft_head_revision >= COALESCE(baseline_trunk_revision, 1)),
    ready_draft_head_revision BIGINT,
    removed BOOLEAN NOT NULL DEFAULT FALSE,
    merge_result JSONB,
    metadata JSONB NOT NULL,
    creator_id TEXT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    seed BYTEA,
    merge_artifact BYTEA,
    CHECK ((source = 'trunk') = (baseline_trunk_revision IS NOT NULL)),
    CHECK ((source = 'worktree') = (seed IS NOT NULL)),
    PRIMARY KEY (worktree_id, unit_id),
    UNIQUE (worktree_id, unit_order)
  );
  CREATE TABLE collaboration.worktree_changesets (
    worktree_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 2),
    base_revision BIGINT NOT NULL CHECK (base_revision >= 1),
    sid TEXT NOT NULL,
    req_id BIGINT NOT NULL CHECK (req_id >= 1),
    created_at_ms BIGINT NOT NULL,
    payload BYTEA NOT NULL,
    metadata JSONB NOT NULL,
    PRIMARY KEY (worktree_id, unit_id, revision),
    UNIQUE (worktree_id, unit_id, sid, req_id),
    FOREIGN KEY (worktree_id, unit_id) REFERENCES collaboration.worktree_units ON DELETE CASCADE
  );
`;

export async function initializeSchema(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    // All collaboration adapters share this lock when creating the schema and version table.
    await client.query("SELECT pg_advisory_xact_lock($1)", [0x636f_6c6c]);
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS collaboration;
      CREATE TABLE IF NOT EXISTS collaboration.schema_versions (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1)
      )
    `);
    const { rows } = await client.query<{ version: number }>(
      "SELECT version FROM collaboration.schema_versions WHERE component = 'worktree'"
    );
    if (rows[0]?.version === SCHEMA_VERSION) return;
    if (rows[0]) throw new Error(`Worktree schema version ${rows[0].version} is not supported (expected ${SCHEMA_VERSION})`);

    await client.query(WORKTREE_SCHEMA_SQL);
    await client.query("INSERT INTO collaboration.schema_versions (component, version) VALUES ('worktree', $1)", [
      SCHEMA_VERSION,
    ]);
  });
}
