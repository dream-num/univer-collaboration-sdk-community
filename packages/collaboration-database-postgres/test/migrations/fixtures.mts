import type { Pool } from "pg";

// Frozen core v1 DDL. Migration tests must start from the schema that was actually released.
export async function createV1Schema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE SCHEMA collaboration;
    CREATE TABLE collaboration.schema_versions (
      component TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version >= 1)
    );
    CREATE TABLE collaboration.units (
      unit_id TEXT PRIMARY KEY,
      type INTEGER NOT NULL,
      head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
      creator_id TEXT NOT NULL,
      created_at_ms BIGINT NOT NULL,
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
      PRIMARY KEY (unit_id, revision),
      UNIQUE (unit_id, sid, req_id)
    );
    CREATE TABLE collaboration.sheet_blocks (
      unit_id TEXT NOT NULL REFERENCES collaboration.units(unit_id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      payload BYTEA NOT NULL,
      PRIMARY KEY (unit_id, block_id)
    );
    INSERT INTO collaboration.schema_versions (component, version)
    VALUES ('core', 1);
  `);
}
