import { CollabError } from "@univerjs-pro/collaboration-service";
import type { Pool, PoolClient } from "pg";
import { transaction } from "./transaction.js";

// The tables differ from the ones `collaboration-database-postgres` creates under `core`: Sheet blocks
// are indexed here and stored in S3. A separate component keeps one from opening the other's schema.
const SCHEMA_COMPONENT = "core-s3";
const PLAIN_SCHEMA_COMPONENT = "core";
const SCHEMA_VERSION = 1;
// Every collaboration adapter that initializes the shared `collaboration` schema takes this lock, so nodes
// and components starting together create the schema and the version table once.
const SCHEMA_LOCK_KEY = 0x636f_6c6c;

const CORE_S3_SCHEMA_SQL = `
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
    -- Blocks the snapshot references, as passed to the save.
    block_ids TEXT[] NOT NULL DEFAULT '{}',
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
  -- Ledger of the block objects a Unit has in the bucket; the contents are S3 objects. A row is
  -- removed only after its object is, so the table never cascades from another delete.
  CREATE TABLE collaboration.sheet_blocks (
    unit_id TEXT NOT NULL REFERENCES collaboration.units(unit_id),
    block_id TEXT NOT NULL,
    -- NULL while a snapshot references the block; otherwise when it stopped being referenced.
    unreferenced_at_ms BIGINT,
    PRIMARY KEY (unit_id, block_id)
  );
  CREATE INDEX sheet_blocks_unreferenced ON collaboration.sheet_blocks (unreferenced_at_ms)
    WHERE unreferenced_at_ms IS NOT NULL;
`;

export async function initializeSchema(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_KEY]);
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS collaboration;
      CREATE TABLE IF NOT EXISTS collaboration.schema_versions (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1)
      );
    `);
    const version = await readSchemaVersion(client, SCHEMA_COMPONENT);
    if (version === SCHEMA_VERSION) return;
    if (version !== undefined) throw unsupportedSchemaVersion(version);
    if ((await readSchemaVersion(client, PLAIN_SCHEMA_COMPONENT)) !== undefined) {
      throw new CollabError(
        "INTERNAL_ERROR",
        "This database stores Sheet blocks in PostgreSQL (created by collaboration-database-postgres); migrate the blocks to S3 explicitly first",
      );
    }
    await client.query(CORE_S3_SCHEMA_SQL);
    await client.query("INSERT INTO collaboration.schema_versions (component, version) VALUES ($1, $2)", [
      SCHEMA_COMPONENT,
      SCHEMA_VERSION,
    ]);
  });
}

async function readSchemaVersion(client: PoolClient, component: string): Promise<number | undefined> {
  const { rows } = await client.query<{ version: number }>(
    `SELECT version FROM collaboration.schema_versions WHERE component = $1`,
    [component],
  );
  return rows[0]?.version;
}

function unsupportedSchemaVersion(version: number): CollabError {
  return new CollabError(
    "INTERNAL_ERROR",
    `Core S3 schema version ${version} is not supported by this adapter (expected ${SCHEMA_VERSION})`,
  );
}
