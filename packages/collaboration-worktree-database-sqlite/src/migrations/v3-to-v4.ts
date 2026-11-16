import Database from "libsql";
import { CollabError } from "@univerjs-pro/collaboration-service";

/**
 * Adds empty Unit and changeset metadata to a v3 database. Stop writers before migrating.
 * All metadata and the schema version are published atomically.
 * @public
 */
export function migrateSQLiteWorktreeV3ToV4(options: { readonly filename: string }): void {
  const database = new Database(options.filename, { fileMustExist: true });
  try {
    database.exec("BEGIN IMMEDIATE;");
    const version = database.prepare(
      "SELECT version FROM collaboration_schema_versions WHERE component = 'worktree'"
    ).get() as { version: number } | undefined;
    if (version?.version !== 3) {
      throw new CollabError("INVALID_REQUEST", "Worktree v3-to-v4 migration requires schema version 3");
    }
    database.exec(`
      ALTER TABLE collaboration_worktree_units
        ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(metadata_json));
      ALTER TABLE collaboration_worktree_changesets
        ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(metadata_json));
      UPDATE collaboration_schema_versions SET version = 4 WHERE component = 'worktree';
      COMMIT;
    `);
  } finally {
    try {
      if (database.inTransaction) database.exec("ROLLBACK;");
    } finally {
      database.close();
    }
  }
}
