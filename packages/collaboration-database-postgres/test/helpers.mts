import { Pool } from "pg";

/** Connection string for the test server; CI and local runs set it explicitly. */
export const POSTGRES_URL = process.env.UNIVER_COLLAB_POSTGRES_URL;

export function createTestPool(): Pool {
  return new Pool({ connectionString: POSTGRES_URL, max: 4 });
}

/** Removes the `collaboration` schema so every test starts from an empty database. */
export async function dropSchema(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS collaboration CASCADE");
}
