import type { Pool } from "pg";
import { transaction } from "./transaction.js";

const SCHEMA_VERSION = 1;
const COMMENT_SCHEMA_SQL = `
  CREATE TABLE collaboration.comments (
    unit_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    reply_id TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    mentions TEXT[] NOT NULL,
    solved INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    generation UUID NOT NULL,
    PRIMARY KEY (unit_id, reply_id)
  );
  CREATE INDEX comments_thread_lookup ON collaboration.comments(unit_id, thread_id);
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
      "SELECT version FROM collaboration.schema_versions WHERE component = 'comment'"
    );
    if (rows[0]?.version === SCHEMA_VERSION) return;
    if (rows[0]) throw new Error(`Comment schema version ${rows[0].version} is not supported (expected ${SCHEMA_VERSION})`);

    await client.query(COMMENT_SCHEMA_SQL);
    await client.query("INSERT INTO collaboration.schema_versions (component, version) VALUES ('comment', $1)", [
      SCHEMA_VERSION,
    ]);
  });
}
