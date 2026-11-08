import { randomUUID } from "node:crypto";
import { PostgresDatabaseAdapter } from "@univerjs-pro/collaboration-database-postgres";
import { fileDatabaseAdapterContract } from "@univerjs-pro/collaboration-file-database-testkit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresFileDatabaseAdapter } from "../src/index.js";

// The adapter always uses the fixed `collaboration` schema, so these tests run in a database of their
// own: the core adapter's tests use the configured database at the same time.
const url = process.env.UNIVER_COLLAB_POSTGRES_URL;

if (url === undefined) {
  describe("PostgreSQL IFileDatabaseAdapter contract", () => {
    it.skip("requires UNIVER_COLLAB_POSTGRES_URL to point at a PostgreSQL server", () => {});
  });
} else {
  const database = `collaboration_file_test_${randomUUID().replace(/-/g, "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${database}`);
    const connection = new URL(url);
    connection.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: connection.toString(), max: 4 });
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  });

  async function resetSchema(): Promise<void> {
    await pool.query("DROP SCHEMA IF EXISTS collaboration CASCADE");
  }

  fileDatabaseAdapterContract("PostgreSQL", async () => {
    await resetSchema();
    const adapter = await PostgresFileDatabaseAdapter.create({ pool });
    return { adapter, dispose: () => adapter.dispose() };
  });

  describe("PostgresFileDatabaseAdapter", () => {
    it("initializes once when several nodes start together and leaves the pool open", async () => {
      await resetSchema();
      await Promise.all(Array.from({ length: 4 }, () => PostgresFileDatabaseAdapter.create({ pool })));
      const versions = await pool.query("SELECT component, version FROM collaboration.schema_versions");
      expect(versions.rows).toEqual([{ component: "file", version: 1 }]);
      expect((await pool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
    });

    it("shares the collaboration schema and its version table with the core adapter", async () => {
      await resetSchema();
      await Promise.all([
        PostgresDatabaseAdapter.create({ pool }),
        PostgresFileDatabaseAdapter.create({ pool }),
      ]);
      const versions = await pool.query(
        "SELECT component, version FROM collaboration.schema_versions ORDER BY component"
      );
      expect(versions.rows).toEqual([
        { component: "core", version: 1 },
        { component: "file", version: 1 },
      ]);
      const tables = await pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'collaboration' ORDER BY table_name"
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "changesets",
        "files",
        "schema_versions",
        "sheet_blocks",
        "snapshots",
        "units",
      ]);
    });

    it("rejects a different file schema version", async () => {
      await resetSchema();
      await PostgresFileDatabaseAdapter.create({ pool });
      await pool.query("UPDATE collaboration.schema_versions SET version = 2 WHERE component = 'file'");
      await expect(PostgresFileDatabaseAdapter.create({ pool })).rejects.toThrow(/version 2 is not supported/);
    });

    it("indexes blob_key without requiring it to be unique", async () => {
      await resetSchema();
      const adapter = await PostgresFileDatabaseAdapter.create({ pool });
      const context = { userID: "u", customData: {}, request: { fileID: "f" } };
      for (const fileID of ["a", "b"]) {
        await adapter.create({ fileID, name: fileID, size: 0, contentType: "x/y", source: 1, assign: "u", blobKey: "shared", createdAt: 1 }, context);
      }
      const indexes = await pool.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'collaboration' AND indexname = 'files_blob_key'"
      );
      expect(indexes.rows).toHaveLength(1);
    });

    it("orders fileIDs by byte value regardless of the database locale", async () => {
      await resetSchema();
      const adapter = await PostgresFileDatabaseAdapter.create({ pool });
      const context = { userID: "u", customData: {}, request: { fileID: "f" } };
      for (const fileID of ["b", "B", "a", "_"]) {
        await adapter.create({ fileID, name: fileID, size: 0, contentType: "x/y", source: 1, assign: "u", blobKey: fileID, createdAt: 1 }, context);
      }
      const page = await adapter.list({ source: 1, limit: 10 }, context);
      expect(page.records.map((item) => item.fileID)).toEqual(["B", "_", "a", "b"]);
    });
  });
}
