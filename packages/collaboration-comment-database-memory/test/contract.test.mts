import { commentDatabaseAdapterContract } from "@univerjs-pro/collaboration-comment-database-testkit";
import { MemoryCommentDatabaseAdapter } from "../src/index.js";

commentDatabaseAdapterContract("Memory", () => {
  const adapter = new MemoryCommentDatabaseAdapter();
  return { adapter, dispose: () => adapter.dispose() };
});
