import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentDatabaseAdapterContract } from "@univerjs-pro/collaboration-comment-database-testkit";
import { SQLiteCommentDatabaseAdapter } from "../src/index.js";

commentDatabaseAdapterContract("SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "univer-collab-comment-sqlite-"));
  const adapter = new SQLiteCommentDatabaseAdapter({ filename: join(directory, "comments.sqlite") });
  return {
    adapter,
    async dispose() {
      await adapter.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
