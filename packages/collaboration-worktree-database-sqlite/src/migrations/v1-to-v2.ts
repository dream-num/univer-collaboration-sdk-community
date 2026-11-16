import Database from "libsql";
import { CollabError } from "@univerjs-pro/collaboration-service";

/**
 * Upgrades Worktree v1 to v2. Stop writers and back up the file first.
 * @public
 */
export function migrateSQLiteWorktreeV1ToV2(options: { readonly filename: string }): void {
  const database = new Database(options.filename, { fileMustExist: true });
  let transaction = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transaction = true;
    const row = database.prepare("SELECT version FROM collaboration_schema_versions WHERE component = 'worktree'").get() as { version: number } | undefined;
    if (row?.version !== 1) throw new CollabError("INVALID_REQUEST", "Worktree v1-to-v2 migration requires schema version 1");
    database.exec(`
      ALTER TABLE collaboration_worktree_units ADD COLUMN removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1));
      UPDATE collaboration_schema_versions SET version = 2 WHERE component = 'worktree';
      COMMIT;
    `);
    transaction = false;
  } finally {
    try { if (transaction) database.exec("ROLLBACK;"); }
    finally { database.close(); }
  }
}
