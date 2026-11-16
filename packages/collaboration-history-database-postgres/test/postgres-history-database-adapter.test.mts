import { randomUUID } from "node:crypto";
import { PostgresDatabaseAdapter } from "@univerjs-pro/collaboration-database-postgres";
import { createHistoryRecord, createHistoryDatabaseContext, historyDatabaseAdapterContract } from "@univerjs-pro/collaboration-history-database-testkit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresHistoryDatabaseAdapter } from "../src/index.js";

// The adapter always uses the fixed `collaboration` schema, so these tests run in a database of their
// own: the core adapter's tests use the configured database at the same time.
const url = process.env.UNIVER_COLLAB_POSTGRES_URL;

if (url === undefined) {
  describe("PostgreSQL IHistoryDatabaseAdapter contract", () => {
    it.skip("requires UNIVER_COLLAB_POSTGRES_URL to point at a PostgreSQL server", () => {});
  });
} else {
  const database = `collaboration_history_test_${randomUUID().replace(/-/g, "")}`;
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

  historyDatabaseAdapterContract("PostgreSQL", async () => {
    await resetSchema();
    const adapter = await PostgresHistoryDatabaseAdapter.create({ pool });
    return { adapter, dispose: () => adapter.dispose() };
  });

  describe("PostgresHistoryDatabaseAdapter", () => {
    it("initializes once when several nodes start together and leaves the pool open", async () => {
      await resetSchema();
      const adapters = await Promise.all(Array.from({ length: 4 }, () => PostgresHistoryDatabaseAdapter.create({ pool })));
      const versions = await pool.query("SELECT component, version FROM collaboration.schema_versions");
      expect(versions.rows).toEqual([{ component: "history", version: 1 }]);
      await Promise.all(adapters.map((adapter) => adapter.dispose()));
      expect((await pool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
    });

    it("shares the collaboration schema and its version table with the core adapter", async () => {
      await resetSchema();
      await Promise.all([
        PostgresDatabaseAdapter.create({ pool }),
        PostgresHistoryDatabaseAdapter.create({ pool }),
      ]);
      const versions = await pool.query(
        "SELECT component, version FROM collaboration.schema_versions ORDER BY component"
      );
      expect(versions.rows).toEqual([
        { component: "core", version: 2 },
        { component: "history", version: 1 },
      ]);
    });

    it("rejects a different history schema version", async () => {
      await resetSchema();
      await PostgresHistoryDatabaseAdapter.create({ pool });
      await pool.query("UPDATE collaboration.schema_versions SET version = 2 WHERE component = 'history'");
      await expect(PostgresHistoryDatabaseAdapter.create({ pool })).rejects.toThrow(/version 2 is not supported/);
    });

    it("allows only one first append with different revisions racing on an empty Unit", async () => {
      await resetSchema();
      const adapters = await Promise.all([0, 1].map(() => PostgresHistoryDatabaseAdapter.create({ pool })));
      const results = await Promise.all(adapters.map((adapter, index) =>
        adapter.appendRecord(createHistoryDatabaseContext(), createHistoryRecord(index + 1), {
          expectedLatestStartRevision: null,
        })
      ));
      expect(results.map((result) => result.status).sort()).toEqual(["appended", "conflict"]);
    });
  });
}
