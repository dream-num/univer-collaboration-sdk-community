import type { Pool } from "pg";
import { transaction } from "./transaction.js";

const SCHEMA_COMPONENT = "file";
const SCHEMA_VERSION = 1;
const FILE_SCHEMA_SQL = `
  CREATE TABLE collaboration.files (
    -- Bytewise ordering keeps keyset cursors independent of the database locale.
    file_id TEXT COLLATE "C" PRIMARY KEY,
    name TEXT NOT NULL,
    size BIGINT NOT NULL,
    content_type TEXT NOT NULL,
    source INTEGER NOT NULL,
    assign TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX files_source_created ON collaboration.files(source, created_at, file_id);
  CREATE INDEX files_source_assign_created ON collaboration.files(source, assign, created_at, file_id);
  -- Shared content can have several file records for one blob key.
  CREATE INDEX files_blob_key ON collaboration.files(blob_key);
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
      "SELECT version FROM collaboration.schema_versions WHERE component = $1",
      [SCHEMA_COMPONENT],
    );
    const version = rows[0]?.version;
    if (version === SCHEMA_VERSION) return;
    if (version !== undefined) {
      throw new Error(`File schema version ${version} is not supported by this adapter (expected ${SCHEMA_VERSION})`);
    }

    await client.query(FILE_SCHEMA_SQL);
    await client.query("INSERT INTO collaboration.schema_versions (component, version) VALUES ($1, $2)", [
      SCHEMA_COMPONENT,
      SCHEMA_VERSION,
    ]);
  });
}
