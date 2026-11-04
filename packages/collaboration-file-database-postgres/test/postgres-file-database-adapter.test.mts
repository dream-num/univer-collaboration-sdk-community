import { randomUUID } from "node:crypto";
import { fileDatabaseAdapterContract } from "@univerjs-pro/collaboration-file-database-testkit";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { PostgresFileDatabaseAdapter } from "../src/index.js";

// Every harness gets its own PostgreSQL schema through search_path and drops it afterwards.
const url = process.env.UNIVER_COLLAB_POSTGRES_URL;

async function isolatedPool() {
  const schema = `file_test_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  return {
    pool,
    async dispose() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

if (url === undefined) {
  describe("PostgreSQL IFileDatabaseAdapter contract", () => {
    it.skip("requires UNIVER_COLLAB_POSTGRES_URL to point at a PostgreSQL server", () => {});
  });
} else {
  fileDatabaseAdapterContract("PostgreSQL", async () => {
    const isolated = await isolatedPool();
    const adapter = await PostgresFileDatabaseAdapter.create({ pool: isolated.pool });
    return { adapter, dispose: () => isolated.dispose() };
  });

  describe("PostgresFileDatabaseAdapter", () => {
    it("initializes once when several nodes start together and leaves the pool open", async () => {
      const isolated = await isolatedPool();
      try {
        await Promise.all(Array.from({ length: 4 }, () => PostgresFileDatabaseAdapter.create({ pool: isolated.pool })));
        const versions = await isolated.pool.query("SELECT component, version FROM collaboration_schema_versions");
        expect(versions.rows).toEqual([{ component: "file", version: 1 }]);
        expect((await isolated.pool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
      } finally {
        await isolated.dispose();
      }
    });

    it("rejects a different file schema version", async () => {
      const isolated = await isolatedPool();
      try {
        await PostgresFileDatabaseAdapter.create({ pool: isolated.pool });
        await isolated.pool.query("UPDATE collaboration_schema_versions SET version = 2 WHERE component = 'file'");
        await expect(PostgresFileDatabaseAdapter.create({ pool: isolated.pool })).rejects.toThrow(/version 2 is not supported/);
      } finally {
        await isolated.dispose();
      }
    });

    it("orders fileIDs by byte value regardless of the database locale", async () => {
      const isolated = await isolatedPool();
      try {
        const adapter = await PostgresFileDatabaseAdapter.create({ pool: isolated.pool });
        const context = { userID: "u", customData: {}, request: { fileID: "f" } };
        for (const fileID of ["b", "B", "a", "_"]) {
          await adapter.create({ fileID, name: fileID, size: 0, contentType: "x/y", source: 1, assign: "u", blobKey: fileID, createdAt: 1 }, context);
        }
        const page = await adapter.list({ source: 1, limit: 10 }, context);
        expect(page.records.map((item) => item.fileID)).toEqual(["B", "_", "a", "b"]);
      } finally {
        await isolated.dispose();
      }
    });
  });
}
