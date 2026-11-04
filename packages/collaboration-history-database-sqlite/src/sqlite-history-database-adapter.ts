import Database from "libsql";
import type {
  AppendHistoryRecordResult,
  HistoryCreatorIndex,
  HistoryDatabaseContext,
  HistoryOrigin,
  HistoryRecord,
  IHistoryDatabaseAdapter,
  ListHistoryRecordsOptions,
  ListHistoryRecordsResult,
} from "@univerjs-pro/collaboration-history-service";
import {
  HISTORY_INDEX_SQL,
  HISTORY_SCHEMA_COMPONENT,
  HISTORY_SCHEMA_VERSION,
  HISTORY_TABLE_SQL,
} from "./schema.js";

interface HistoryRow {
  readonly unit_id: string;
  readonly start_revision: number;
  readonly user_id: string;
  readonly created_at_ms: number;
  readonly origin: HistoryOrigin;
  readonly additional_fields: string | null;
}

export interface SQLiteHistoryDatabaseAdapterOptions {
  /** SQLite filename or `:memory:`. The parent directory must already exist. */
  readonly filename: string;
  /** How long SQLite waits for another writer before reporting SQLITE_BUSY. Defaults to 5000. */
  readonly busyTimeoutMs?: number;
}

/**
 * SQLite implementation of the History persistence contract, built on the synchronous `libsql`
 * API. It can share a database file with the other Univer collaboration SQLite adapters.
 *
 * The constructor initializes an empty database and rejects a database whose history schema
 * version differs from the one this adapter writes; migrations are always explicit.
 */
export class SQLiteHistoryDatabaseAdapter implements IHistoryDatabaseAdapter {
  private readonly _database: Database.Database;
  private _disposed = false;

  constructor(options: SQLiteHistoryDatabaseAdapterOptions) {
    if (!options.filename) {
      throw new TypeError("SQLiteHistoryDatabaseAdapter requires a filename");
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    this._database = new Database(options.filename, { timeout: busyTimeoutMs });
    try {
      this._database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
      this._initializeSchema();
    } catch (error) {
      this._database.close();
      throw error;
    }
  }

  async getLatestRecord(_context: HistoryDatabaseContext, unitID: string): Promise<HistoryRecord | null> {
    this._assertOpen();
    const row = this._latest(unitID);
    return row ? toRecord(row) : null;
  }

  /** Appends when the stored latest start revision equals the expected one; otherwise reports a conflict. */
  async appendRecord(
    _context: HistoryDatabaseContext,
    record: HistoryRecord,
    options: { readonly expectedLatestStartRevision: number | null },
  ): Promise<AppendHistoryRecordResult> {
    this._assertOpen();
    validateRecord(record);
    return this._transaction(() => {
      const existing = this._database
        .prepare("SELECT * FROM collaboration_history_records WHERE unit_id = ? AND start_revision = ?")
        .get(record.unitID, record.startRevision) as HistoryRow | undefined;
      if (existing) {
        const same =
          existing.user_id === record.userID &&
          existing.created_at_ms === record.createdAt &&
          existing.origin === record.origin &&
          existing.additional_fields === (record.additionalFields ?? null);
        return { status: same ? "already-exists" : "conflict" };
      }
      const latest = this._latest(record.unitID)?.start_revision ?? null;
      if (latest !== options.expectedLatestStartRevision || record.startRevision <= (latest ?? 0)) {
        return { status: "conflict" };
      }
      this._database
        .prepare(
          `INSERT INTO collaboration_history_records
           (unit_id, start_revision, user_id, created_at_ms, origin, additional_fields)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.unitID,
          record.startRevision,
          record.userID,
          record.createdAt,
          record.origin,
          record.additionalFields ?? null,
        );
      return { status: "appended" };
    });
  }

  /** Pages boundaries newest first; end revisions use the unfiltered successor, capped at throughRevision. */
  async listRecords(
    _context: HistoryDatabaseContext,
    unitID: string,
    options: ListHistoryRecordsOptions,
  ): Promise<ListHistoryRecordsResult> {
    this._assertOpen();
    const parameters: (string | number)[] = [options.throughRevision, options.throughRevision, unitID, options.throughRevision];
    const filters: string[] = [];
    if (options.beforeRevision !== undefined) {
      filters.push("r.start_revision < ?");
      parameters.push(options.beforeRevision);
    }
    if (options.origin) {
      filters.push("r.origin = ?");
      parameters.push(options.origin);
    }
    if (options.userIDs?.length) {
      filters.push(`r.user_id IN (${options.userIDs.map(() => "?").join(", ")})`);
      parameters.push(...options.userIDs);
    }
    parameters.push(options.length + 1);
    // The successor subquery must not inherit the page's creator and origin filters.
    const rows = this._database
      .prepare(`
        SELECT r.*, MIN(?, COALESCE((
          SELECT next.start_revision - 1 FROM collaboration_history_records AS next
          WHERE next.unit_id = r.unit_id AND next.start_revision > r.start_revision
          ORDER BY next.start_revision ASC LIMIT 1
        ), ?)) AS end_revision
        FROM collaboration_history_records AS r
        WHERE r.unit_id = ? AND r.start_revision <= ?
          ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
        ORDER BY r.start_revision DESC LIMIT ?
      `)
      .all(...parameters) as (HistoryRow & { end_revision: number })[];
    return {
      records: rows.slice(0, options.length).map((row) => ({ record: toRecord(row), endRevision: row.end_revision })),
      hasMore: rows.length > options.length,
    };
  }

  async listCreators(
    _context: HistoryDatabaseContext,
    unitID: string,
    options: { readonly throughRevision: number },
  ): Promise<readonly HistoryCreatorIndex[]> {
    this._assertOpen();
    const rows = this._database
      .prepare(
        `SELECT DISTINCT user_id, origin FROM collaboration_history_records
         WHERE unit_id = ? AND start_revision <= ? ORDER BY user_id, origin`,
      )
      .all(unitID, options.throughRevision) as { user_id: string; origin: HistoryOrigin }[];
    const creators = new Map<string, HistoryOrigin[]>();
    for (const row of rows) {
      const origins = creators.get(row.user_id) ?? [];
      origins.push(row.origin);
      creators.set(row.user_id, origins);
    }
    return [...creators].map(([userID, origins]) => ({ userID, origins }));
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._database.close();
  }

  private _latest(unitID: string): HistoryRow | undefined {
    return this._database
      .prepare("SELECT * FROM collaboration_history_records WHERE unit_id = ? ORDER BY start_revision DESC LIMIT 1")
      .get(unitID) as HistoryRow | undefined;
  }

  private _initializeSchema(): void {
    this._transaction(() => {
      this._database.exec(`
        CREATE TABLE IF NOT EXISTS collaboration_schema_versions (
          component TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version >= 1)
        );
      `);
      const version = this._readSchemaVersion();
      if (version === HISTORY_SCHEMA_VERSION) return;
      if (version !== undefined) throw unsupportedSchemaVersion(version);
      this._database.exec(`
        ${HISTORY_TABLE_SQL}
        ${HISTORY_INDEX_SQL}
        INSERT INTO collaboration_schema_versions (component, version)
        VALUES ('${HISTORY_SCHEMA_COMPONENT}', ${HISTORY_SCHEMA_VERSION});
      `);
    });
  }

  private _readSchemaVersion(): number | undefined {
    const row = this._database
      .prepare("SELECT version FROM collaboration_schema_versions WHERE component = ?")
      .get(HISTORY_SCHEMA_COMPONENT) as { version: number } | undefined;
    return row?.version;
  }

  // The check and the write of every operation share one immediate transaction.
  private _transaction<T>(work: () => T): T {
    this._database.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this._database.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this._database.exec("ROLLBACK;");
      } catch {
        // The original error is the one worth reporting.
      }
      throw error;
    }
  }

  private _assertOpen(): void {
    if (this._disposed) throw new Error("SQLite History Database Adapter is disposed");
  }
}

function validateRecord(record: HistoryRecord): void {
  if (
    !record.unitID ||
    !record.userID ||
    !Number.isSafeInteger(record.startRevision) ||
    record.startRevision < 1 ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0
  ) {
    throw new TypeError("History record is invalid");
  }
}

function unsupportedSchemaVersion(version: number): Error {
  const remedy = version < HISTORY_SCHEMA_VERSION ? "run migrateSQLiteHistory first" : "upgrade the adapter";
  return new Error(
    `History schema version ${version} is not supported by this adapter (expected ${HISTORY_SCHEMA_VERSION}); ${remedy}`,
  );
}

function toRecord(row: HistoryRow): HistoryRecord {
  return {
    unitID: row.unit_id,
    startRevision: row.start_revision,
    userID: row.user_id,
    createdAt: row.created_at_ms,
    origin: row.origin,
    ...(row.additional_fields === null ? {} : { additionalFields: row.additional_fields }),
  };
}
