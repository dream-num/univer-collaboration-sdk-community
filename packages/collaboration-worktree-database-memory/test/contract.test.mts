import { worktreeDatabaseAdapterContract } from "@univerjs-pro/collaboration-worktree-database-testkit";
import { MemoryWorktreeDatabaseAdapter } from "../src/memory-worktree-database-adapter.js";

worktreeDatabaseAdapterContract("MemoryWorktreeDatabaseAdapter", () => {
  const adapter = new MemoryWorktreeDatabaseAdapter();
  return {
    adapter,
    dispose: () => adapter.dispose(),
  };
});
