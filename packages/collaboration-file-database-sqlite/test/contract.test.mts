import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDatabaseAdapterContract } from "@univerjs-pro/collaboration-file-database-testkit";
import { SQLiteFileDatabaseAdapter } from "../src/index.js";

fileDatabaseAdapterContract("SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "univer-collab-file-sqlite-"));
  const adapter = new SQLiteFileDatabaseAdapter({ filename: join(directory, "files.sqlite") });
  return {
    adapter,
    async dispose() {
      await adapter.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
