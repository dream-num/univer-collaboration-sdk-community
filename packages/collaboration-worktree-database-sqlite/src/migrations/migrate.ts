import { accessSync, closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import Database from "libsql";
import { CollabError } from "@univerjs-pro/collaboration-service";
import { SCHEMA_COMPONENT, SCHEMA_VERSION } from "../schema.js";
import { migrateSQLiteWorktreeV1ToV2 } from "./v1-to-v2.js";
import { migrateSQLiteWorktreeV2ToV3, type SQLiteWorktreeV2ToV3MigrationOptions } from "./v2-to-v3.js";
import { migrateSQLiteWorktreeV3ToV4 } from "./v3-to-v4.js";

/** Options for upgrading an existing SQLite Worktree database. @public */
export interface SQLiteWorktreeMigrationOptions extends SQLiteWorktreeV2ToV3MigrationOptions {
  /** Defaults to `<filename>.worktree-v<from>.backup`. The destination must be a new file. */
  readonly backupFilename?: string;
}

/** Worktree schema versions before and after migration. @public */
export interface SQLiteWorktreeMigrationResult {
  readonly from: number;
  readonly to: number;
  /** Present when the file was backed up before upgrading. */
  readonly backupFilename?: string;
}

const STEPS = [migrateSQLiteWorktreeV1ToV2, migrateSQLiteWorktreeV2ToV3, migrateSQLiteWorktreeV3ToV4] as const;

/**
 * Backs up the database and applies each missing Worktree migration in its own transaction.
 * Stop writers first. A current schema returns immediately without creating a backup.
 * @public
 */
export async function migrateSQLiteWorktree(options: SQLiteWorktreeMigrationOptions): Promise<SQLiteWorktreeMigrationResult> {
  // libsql opens missing paths in create mode. Migration only accepts an existing file.
  accessSync(options.filename);
  const database = new Database(options.filename);
  let from: number;
  let backupFilename: string;
  try {
    from = readWorktreeVersion(database);
    if (from === SCHEMA_VERSION) return { from, to: from };
    if (from > SCHEMA_VERSION) {
      throw new CollabError("INVALID_REQUEST", `Worktree schema version ${from} is newer than this package supports (${SCHEMA_VERSION})`);
    }

    backupFilename = options.backupFilename ?? `${options.filename}.worktree-v${from}.backup`;
    // VACUUM INTO accepts an empty file. Reserve it exclusively to protect existing backups.
    closeSync(openSync(backupFilename, "wx", 0o600));
    database.prepare("VACUUM INTO ?").run(resolve(backupFilename));
  } finally {
    database.close();
  }

  for (const step of STEPS.slice(from - 1)) {
    await step(options);
  }
  return { from, to: SCHEMA_VERSION, backupFilename };
}

function readWorktreeVersion(database: Database.Database): number {
  const table = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'collaboration_schema_versions'").get();
  const row = table
    ? database.prepare("SELECT version FROM collaboration_schema_versions WHERE component = ?")
        .get(SCHEMA_COMPONENT) as { version: number } | undefined
    : undefined;
  if (!row || !Number.isInteger(row.version) || row.version < 1) {
    throw new CollabError("INVALID_REQUEST", "The database has no Worktree schema version to migrate from");
  }
  return row.version;
}
