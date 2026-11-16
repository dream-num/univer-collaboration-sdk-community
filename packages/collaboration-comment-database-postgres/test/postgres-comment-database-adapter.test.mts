import { randomUUID } from "node:crypto";
import { PostgresDatabaseAdapter } from "@univerjs-pro/collaboration-database-postgres";
import { commentDatabaseAdapterContract } from "@univerjs-pro/collaboration-comment-database-testkit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCommentDatabaseAdapter } from "../src/index.js";

// The adapter always uses the fixed `collaboration` schema, so these tests run in a database of their
// own: the core adapter's tests use the configured database at the same time.
const url = process.env.UNIVER_COLLAB_POSTGRES_URL;

if (url === undefined) {
  describe("PostgreSQL ICommentDatabaseAdapter contract", () => {
    it.skip("requires UNIVER_COLLAB_POSTGRES_URL to point at a PostgreSQL server", () => {});
  });
} else {
  const database = `collaboration_comment_test_${randomUUID().replace(/-/g, "")}`;
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
    await pool?.end();
    try {
      await admin?.query(`DROP DATABASE IF EXISTS ${database}`);
    } finally {
      await admin?.end();
    }
  });

  async function resetSchema(): Promise<void> {
    await pool.query("DROP SCHEMA IF EXISTS collaboration CASCADE");
  }

  commentDatabaseAdapterContract("PostgreSQL", async () => {
    await resetSchema();
    const adapter = await PostgresCommentDatabaseAdapter.create({ pool });
    return { adapter, dispose: () => adapter.dispose() };
  });

  describe("PostgresCommentDatabaseAdapter", () => {
    it("initializes once when several nodes start together and leaves the pool open", async () => {
      await resetSchema();
      const adapters = await Promise.all(Array.from({ length: 4 }, () => PostgresCommentDatabaseAdapter.create({ pool })));
      const versions = await pool.query("SELECT component, version FROM collaboration.schema_versions");
      expect(versions.rows).toEqual([{ component: "comment", version: 1 }]);
      await Promise.all(adapters.map((adapter) => adapter.dispose()));
      expect((await pool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
    });

    it("shares the collaboration schema and its version table with the core adapter", async () => {
      await resetSchema();
      await Promise.all([
        PostgresDatabaseAdapter.create({ pool }),
        PostgresCommentDatabaseAdapter.create({ pool }),
      ]);
      const versions = await pool.query(
        "SELECT component, version FROM collaboration.schema_versions ORDER BY component"
      );
      expect(versions.rows).toEqual([
        { component: "comment", version: 1 },
        { component: "core", version: 2 },
      ]);
    });

    it("rejects a different comment schema version", async () => {
      await resetSchema();
      await PostgresCommentDatabaseAdapter.create({ pool });
      await pool.query("UPDATE collaboration.schema_versions SET version = 2 WHERE component = 'comment'");
      await expect(PostgresCommentDatabaseAdapter.create({ pool })).rejects.toThrow(/version 2 is not supported/);
    });

  });
}
