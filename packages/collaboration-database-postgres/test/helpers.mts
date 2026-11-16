import { expect } from "vitest";
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

export async function expectRequiredMetadataColumns(pool: Pool, unitID: string): Promise<void> {
  for (const table of ["units", "changesets"]) {
    await expect(pool.query(
      `UPDATE collaboration.${table} SET metadata = NULL WHERE unit_id = $1`, [unitID],
    )).rejects.toMatchObject({ code: "23502" });
    // The object shape belongs to the caller contract, not the database schema.
    const { rows } = await pool.query(
      `UPDATE collaboration.${table} SET metadata = '[]'::jsonb WHERE unit_id = $1 RETURNING metadata`, [unitID],
    );
    expect(rows).toEqual([{ metadata: [] }]);
  }
}
