import { existsSync } from "node:fs";
import Database from "libsql";
import { HISTORY_SCHEMA_COMPONENT, HISTORY_SCHEMA_VERSION } from "../schema.js";
import { readComponentVersion } from "./shared.js";
import { migrateSQLiteHistoryV1ToV2 } from "./v1-to-v2.js";

export interface SQLiteHistoryMigrationOptions {
  readonly filename: string;
  /** Where the backup is written before any change. Defaults to `<filename>.history-v<from>.backup`. */
  readonly backupFilename?: string;
}

export interface SQLiteHistoryMigrationResult {
  /** History schema version found in the file. */
  readonly from: number;
  /** History schema version after the call; always the version this package writes. */
  readonly to: number;
  /** Backup written before migrating; undefined when the file already had the current version. */
  readonly backupFilename?: string;
}

// Step N upgrades history schema version N to N + 1.
const STEPS: readonly ((options: { readonly filename: string }) => Promise<void>)[] = [migrateSQLiteHistoryV1ToV2];

/**
 * Brings a database to the history schema version this package writes. The file is backed up first,
 * then every missing step runs in its own transaction. Run the core migration of a shared file
 * before this one. Stop writers before calling.
 */
export async function migrateSQLiteHistory(options: SQLiteHistoryMigrationOptions): Promise<SQLiteHistoryMigrationResult> {
  const from = readHistoryVersion(options.filename);
  if (from === HISTORY_SCHEMA_VERSION) return { from, to: from };
  if (from > HISTORY_SCHEMA_VERSION) {
    throw new Error(`History schema version ${from} is newer than this package supports (${HISTORY_SCHEMA_VERSION})`);
  }

  const backupFilename = options.backupFilename ?? `${options.filename}.history-v${from}.backup`;
  backup(options.filename, backupFilename);
  for (const step of STEPS.slice(from - 1)) {
    await step(options);
  }
  return { from, to: HISTORY_SCHEMA_VERSION, backupFilename };
}

function readHistoryVersion(filename: string): number {
  const database = new Database(filename, { fileMustExist: true });
  try {
    const version = readComponentVersion(database, HISTORY_SCHEMA_COMPONENT);
    if (version === undefined || !Number.isInteger(version) || version < 1) {
      throw new Error("The database has no history schema version to migrate from");
    }
    return version;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The database has no history")) throw error;
    throw new Error("The database has no history schema version to migrate from");
  } finally {
    database.close();
  }
}

// VACUUM INTO writes a consistent single-file copy from a live connection, in WAL mode too.
function backup(filename: string, backupFilename: string): void {
  if (existsSync(backupFilename)) {
    throw new Error(`Backup target already exists: ${backupFilename}`);
  }
  const database = new Database(filename, { fileMustExist: true });
  try {
    database.prepare("VACUUM INTO ?").run(backupFilename);
  } finally {
    database.close();
  }
}
