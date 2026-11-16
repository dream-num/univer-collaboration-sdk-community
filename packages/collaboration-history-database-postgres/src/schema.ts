import type { Pool } from "pg";
import { transaction } from "./transaction.js";

const SCHEMA_VERSION = 1;
const HISTORY_SCHEMA_SQL = `
  CREATE TABLE collaboration.history_records (
    unit_id TEXT NOT NULL,
    start_revision BIGINT NOT NULL CHECK (start_revision >= 1),
    user_id TEXT NOT NULL,
    created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
    origin INTEGER NOT NULL,
    additional_fields TEXT,
    PRIMARY KEY (unit_id, start_revision)
  );
  CREATE INDEX history_origin_lookup ON collaboration.history_records(unit_id, origin, start_revision);
  CREATE INDEX history_creator_lookup ON collaboration.history_records(unit_id, user_id, start_revision);
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
      "SELECT version FROM collaboration.schema_versions WHERE component = 'history'"
    );
    if (rows[0]?.version === SCHEMA_VERSION) return;
    if (rows[0]) throw new Error(`History schema version ${rows[0].version} is not supported (expected ${SCHEMA_VERSION})`);

    await client.query(HISTORY_SCHEMA_SQL);
    await client.query("INSERT INTO collaboration.schema_versions (component, version) VALUES ('history', $1)", [
      SCHEMA_VERSION,
    ]);
  });
}
