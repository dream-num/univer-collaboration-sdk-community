import { HISTORY_INDEX_SQL, HISTORY_SCHEMA_COMPONENT, HISTORY_TABLE_SQL } from "../schema.js";
import { readComponentVersion, runMigration } from "./shared.js";

export interface SQLiteHistoryV1ToV2MigrationOptions {
  readonly filename: string;
}

/**
 * Explicit, atomic migration from history schema v1 to v2. V1 stored every revision; v2 keeps only
 * segment boundaries. Stop writers before calling, and migrate the core and Worktree schemas of the
 * same file first: their migrations read creation facts from the v1 history rows.
 */
export async function migrateSQLiteHistoryV1ToV2(options: SQLiteHistoryV1ToV2MigrationOptions): Promise<void> {
  runMigration(options.filename, (database) => {
    if (readComponentVersion(database, HISTORY_SCHEMA_COMPONENT) !== 1) {
      throw new Error("migrateSQLiteHistoryV1ToV2 requires history schema version 1");
    }
    if (readComponentVersion(database, "core") === 1) {
      throw new Error("Migrate SQLite Core v1 before History so creation facts remain available");
    }
    const worktree = readComponentVersion(database, "worktree");
    if (worktree !== undefined && worktree < 3) {
      throw new Error("Migrate SQLite Worktree before History so creation facts remain available");
    }
    // Every segment must start at a row that is its own boundary and carries valid facts.
    const invalid = database
      .prepare(
        `SELECT 1 FROM collaboration_history_revisions AS r
         LEFT JOIN collaboration_history_revisions AS first
           ON first.unit_id = r.unit_id AND first.revision = r.history_revision
         WHERE r.history_revision > r.revision OR first.revision IS NULL
            OR first.history_revision != first.revision OR first.user_id = ''
            OR typeof(first.committed_at) != 'integer'
            OR first.committed_at < 0 OR first.committed_at > 9007199254740991
         LIMIT 1`,
      )
      .get();
    if (invalid) {
      throw new Error("History v1 contains a missing or invalid segment starting revision");
    }
    database.exec(HISTORY_TABLE_SQL);
    database.exec(`
      INSERT INTO collaboration_history_records
        (unit_id, start_revision, user_id, created_at_ms, origin, additional_fields)
      SELECT unit_id, revision, user_id, committed_at, origin, additional_fields
      FROM collaboration_history_revisions WHERE revision = history_revision;
      DROP TABLE collaboration_history_revisions;
    `);
    database.exec(HISTORY_INDEX_SQL);
    database
      .prepare("UPDATE collaboration_schema_versions SET version = 2 WHERE component = ?")
      .run(HISTORY_SCHEMA_COMPONENT);
  });
}
