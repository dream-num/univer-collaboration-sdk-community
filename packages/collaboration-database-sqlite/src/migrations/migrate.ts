import { existsSync } from "node:fs";
import Database from "libsql";
import { CollabError } from "@univerjs-pro/collaboration-service";
import { CORE_SCHEMA_VERSION } from "../schema.js";
import { migrateSQLiteCoreV1ToV2, type SQLiteCoreV1ToV2MigrationOptions } from "./v1-to-v2.js";
import { migrateSQLiteCoreV2ToV3 } from "./v2-to-v3.js";

export interface SQLiteCoreMigrationOptions extends SQLiteCoreV1ToV2MigrationOptions {
  /** Where the backup is written before any change. Defaults to `<filename>.v<from>.backup`. */
  readonly backupFilename?: string;
}

export interface SQLiteCoreMigrationResult {
  /** Core schema version found in the file. */
  readonly from: number;
  /** Core schema version after the call; always the version this package writes. */
  readonly to: number;
  /** Backup written before migrating; undefined when the file already had the current version. */
  readonly backupFilename?: string;
}

// Step N upgrades core schema version N to N + 1.
const STEPS: readonly ((options: SQLiteCoreV1ToV2MigrationOptions) => Promise<void>)[] = [
  migrateSQLiteCoreV1ToV2,
  migrateSQLiteCoreV2ToV3,
];

/**
 * Brings a database to the core schema version this package writes. The file is backed up first,
 * then every missing step runs in its own transaction. A failed step leaves the file at the last
 * complete version, so the call can be repeated after the cause is fixed. Stop writers before calling.
 */
export async function migrateSQLiteCore(options: SQLiteCoreMigrationOptions): Promise<SQLiteCoreMigrationResult> {
  const from = readCoreVersion(options.filename);
  if (from === CORE_SCHEMA_VERSION) return { from, to: from };
  if (from > CORE_SCHEMA_VERSION) {
    throw new CollabError(
      "INVALID_REQUEST",
      `Core schema version ${from} is newer than this package supports (${CORE_SCHEMA_VERSION})`,
    );
  }

  const backupFilename = options.backupFilename ?? `${options.filename}.v${from}.backup`;
  backup(options.filename, backupFilename);
  for (const step of STEPS.slice(from - 1)) {
    await step(options);
  }
  return { from, to: CORE_SCHEMA_VERSION, backupFilename };
}

function readCoreVersion(filename: string): number {
  const database = new Database(filename, { fileMustExist: true });
  try {
    const row = database
      .prepare("SELECT version FROM collaboration_schema_versions WHERE component = 'core'")
      .get() as { version: number } | undefined;
    if (!row || !Number.isInteger(row.version) || row.version < 1) {
      throw new CollabError("INVALID_REQUEST", "The database has no core schema version to migrate from");
    }
    return row.version;
  } catch (error) {
    if (error instanceof CollabError) throw error;
    throw new CollabError("INVALID_REQUEST", "The database has no core schema version to migrate from");
  } finally {
    database.close();
  }
}

// VACUUM INTO writes a consistent single-file copy from a live connection, in WAL mode too.
function backup(filename: string, backupFilename: string): void {
  if (existsSync(backupFilename)) {
    throw new CollabError("INVALID_REQUEST", `Backup target already exists: ${backupFilename}`);
  }
  const database = new Database(filename, { fileMustExist: true });
  try {
    database.prepare("VACUUM INTO ?").run(backupFilename);
  } finally {
    database.close();
  }
}
