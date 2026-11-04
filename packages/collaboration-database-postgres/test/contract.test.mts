import { databaseAdapterContract } from "@univerjs-pro/collaboration-database-testkit";
import { describe, it } from "vitest";
import { PostgresDatabaseAdapter } from "../src/index.js";
import { createTestPool, dropSchema, POSTGRES_URL } from "./helpers.mjs";

if (POSTGRES_URL === undefined) {
  describe("PostgreSQL IDatabaseAdapter contract", () => {
    it.skip("requires UNIVER_COLLAB_POSTGRES_URL to point at a PostgreSQL server", () => {});
  });
} else {
  databaseAdapterContract("PostgreSQL", async () => {
    const pool = createTestPool();
    await dropSchema(pool);
    const adapter = await PostgresDatabaseAdapter.create({ pool });
    return {
      adapter,
      async dispose() {
        await pool.end();
      },
    };
  });
}
