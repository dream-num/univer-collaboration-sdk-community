import { historyDatabaseAdapterContract } from "@univerjs-pro/collaboration-history-database-testkit";
import { MemoryHistoryDatabaseAdapter } from "../src/index.js";

historyDatabaseAdapterContract("Memory", () => {
  const adapter = new MemoryHistoryDatabaseAdapter();
  return { adapter, dispose: () => adapter.dispose() };
});
