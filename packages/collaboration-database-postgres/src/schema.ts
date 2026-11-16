import type { PoolClient } from "pg";

export const SCHEMA_COMPONENT = "core";
export const SCHEMA_VERSION = 2;
// Every collaboration adapter that initializes the shared `collaboration` schema takes this lock, so nodes
// and components starting together create the schema and the version table once.
export const SCHEMA_LOCK_KEY = 0x636f_6c6c;

export async function readCoreVersion(client: PoolClient): Promise<number | undefined> {
  const { rows } = await client.query<{ version: number }>(
    `SELECT version FROM collaboration.schema_versions WHERE component = $1`,
    [SCHEMA_COMPONENT],
  );
  return rows[0]?.version;
}

export const SCHEMA_VERSIONS_SQL = `
  CREATE SCHEMA IF NOT EXISTS collaboration;
  CREATE TABLE IF NOT EXISTS collaboration.schema_versions (
    component TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 1)
  );
`;

export const CORE_SCHEMA_SQL = `
  CREATE TABLE collaboration.units (
    unit_id TEXT PRIMARY KEY,
    type INTEGER NOT NULL,
    head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
    creator_id TEXT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    deleted_at_ms BIGINT,
    deleted_status TEXT CHECK (deleted_status IN ('soft', 'hard')),
    CHECK ((deleted_status IS NULL) = (deleted_at_ms IS NULL))
  );
  CREATE TABLE collaboration.snapshots (
    unit_id TEXT NOT NULL REFERENCES collaboration.units(unit_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    payload BYTEA NOT NULL,
    PRIMARY KEY (unit_id, revision)
  );
  CREATE TABLE collaboration.changesets (
    unit_id TEXT NOT NULL REFERENCES collaboration.units(unit_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 2),
    base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
    sid TEXT NOT NULL,
    req_id INTEGER NOT NULL CHECK (req_id >= 1),
    created_at_ms BIGINT NOT NULL,
    payload BYTEA NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (unit_id, revision),
    UNIQUE (unit_id, sid, req_id)
  );
  CREATE TABLE collaboration.sheet_blocks (
    unit_id TEXT NOT NULL REFERENCES collaboration.units(unit_id) ON DELETE CASCADE,
    block_id TEXT NOT NULL,
    payload BYTEA NOT NULL,
    PRIMARY KEY (unit_id, block_id)
  );
`;
