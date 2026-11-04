import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseAdapterContract } from "@univerjs-pro/collaboration-database-testkit";
import { SQLiteDatabaseAdapter } from "../src/index.js";

databaseAdapterContract("SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "univer-collab-sqlite-contract-"));
  const adapter = new SQLiteDatabaseAdapter({
    filename: join(directory, "collaboration.sqlite"),
  });

  return {
    adapter,
    async dispose() {
      await adapter.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
