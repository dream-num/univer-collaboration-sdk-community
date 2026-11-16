import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeDatabaseAdapterContract } from "@univerjs-pro/collaboration-worktree-database-testkit";
import { SQLiteWorktreeDatabaseAdapter } from "../src/index.js";

worktreeDatabaseAdapterContract("SQLite Worktree", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "univer-worktree-sqlite-contract-")
  );
  const adapter = new SQLiteWorktreeDatabaseAdapter({
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
