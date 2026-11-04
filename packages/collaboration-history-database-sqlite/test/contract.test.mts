import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyDatabaseAdapterContract } from "@univerjs-pro/collaboration-history-database-testkit";
import { SQLiteHistoryDatabaseAdapter } from "../src/index.js";

historyDatabaseAdapterContract("SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "univer-collab-history-sqlite-"));
  const adapter = new SQLiteHistoryDatabaseAdapter({ filename: join(directory, "history.sqlite") });
  return {
    adapter,
    async dispose() {
      await adapter.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
