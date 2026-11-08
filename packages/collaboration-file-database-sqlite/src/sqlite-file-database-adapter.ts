import Database from "libsql";
import {
  FileError,
  type DeleteFileDatabaseResult,
  type FileDatabaseContext,
  type FileRecord,
  type IFileDatabaseAdapter,
  type ListFilesQuery,
  type ListFilesResult,
} from "@univerjs-pro/collaboration-file-service";

const SCHEMA_COMPONENT = "file";
const SCHEMA_VERSION = 1;

interface FileRow {
  readonly file_id: string;
  readonly name: string;
  readonly size: number;
  readonly content_type: string;
  readonly source: number;
  readonly assign: string;
  readonly blob_key: string;
  readonly created_at: number;
}

/** @public */
export interface SQLiteFileDatabaseAdapterOptions {
  /** SQLite filename or `:memory:`. The parent directory must already exist. */
  readonly filename: string;
  /** How long SQLite waits for another writer before reporting SQLITE_BUSY. Defaults to 5000. */
  readonly busyTimeoutMs?: number;
}

/**
 * SQLite metadata adapter for single-node deployments. One record per `fileID`, so `delete`
 * always releases the record's own `blobKey`. The schema is created on first use and recorded in
 * `collaboration_schema_versions` under the `file` component.
 * @public
 */
export class SQLiteFileDatabaseAdapter implements IFileDatabaseAdapter {
  private readonly _database: Database.Database;
  private _disposed = false;

  constructor(options: SQLiteFileDatabaseAdapterOptions) {
    if (!options.filename) throw new TypeError("SQLiteFileDatabaseAdapter requires a filename");
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

  async create(record: FileRecord, _context: FileDatabaseContext): Promise<void> {
    this._assertOpen();
    try {
      this._database
        .prepare(
          `INSERT INTO collaboration_files
           (file_id, name, size, content_type, source, assign, blob_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.fileID,
          record.name,
          record.size,
          record.contentType,
          record.source,
          record.assign,
          record.blobKey,
          record.createdAt
        );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new FileError("INVALID_REQUEST", `File ${record.fileID} already exists`);
      }
      throw error;
    }
  }

  async get(fileID: string, _context: FileDatabaseContext): Promise<FileRecord | null> {
    this._assertOpen();
    return this._get(fileID);
  }

  // One-to-one storage: the record is read and deleted in one transaction and releases its own blobKey.
  async delete(fileID: string, _context: FileDatabaseContext): Promise<DeleteFileDatabaseResult | null> {
    this._assertOpen();
    return this._transaction(() => {
      const record = this._get(fileID);
      if (!record) return null;
      this._database.prepare("DELETE FROM collaboration_files WHERE file_id = ?").run(fileID);
      return { record, releasedBlobKey: record.blobKey };
    });
  }

  // Keyset paging: one extra row tells whether another page exists; the cursor is the (createdAt, fileID)
  // of the previous page's last record.
  async list(query: ListFilesQuery, _context: FileDatabaseContext): Promise<ListFilesResult> {
    this._assertOpen();
    const where = ["source = ?"];
    const params: Array<string | number> = [query.source];
    if (query.assign !== undefined) {
      where.push("assign = ?");
      params.push(query.assign);
    }
    if (query.createdBefore !== undefined) {
      where.push("created_at < ?");
      params.push(query.createdBefore);
    }
    if (query.cursor !== undefined) {
      const after = decodeCursor(query.cursor);
      where.push("(created_at > ? OR (created_at = ? AND file_id > ?))");
      params.push(after.createdAt, after.createdAt, after.fileID);
    }
    const rows = this._database
      .prepare(`${SELECT_COLUMNS} WHERE ${where.join(" AND ")} ORDER BY created_at, file_id LIMIT ?`)
      .all(...params, query.limit + 1) as FileRow[];
    const records = rows.slice(0, query.limit).map(rowToRecord);
    const last = records.at(-1);
    return { records, nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null };
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._database.close();
  }

  private _get(fileID: string): FileRecord | null {
    const row = this._database.prepare(`${SELECT_COLUMNS} WHERE file_id = ?`).get(fileID) as FileRow | undefined;
    return row ? rowToRecord(row) : null;
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
      if (version === SCHEMA_VERSION) return;
      if (version !== undefined) {
        throw new Error(`File schema version ${version} is not supported by this adapter (expected ${SCHEMA_VERSION})`);
      }
      this._createSchema();
    });
  }

  private _readSchemaVersion(): number | undefined {
    const row = this._database
      .prepare("SELECT version FROM collaboration_schema_versions WHERE component = ?")
      .get(SCHEMA_COMPONENT) as { version: number } | undefined;
    return row?.version;
  }

  // The two source indexes serve cleanup (by source) and listing a Unit's files (by source and assign);
  // both end with (created_at, file_id) for keyset paging. No query uses the blob_key index yet: it is in
  // version 1 so content sharing needs no schema migration, and it stays non-unique because shared
  // content means several rows with one blob_key.
  private _createSchema(): void {
    this._database.exec(`
      CREATE TABLE collaboration_files (
        file_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        source INTEGER NOT NULL,
        assign TEXT NOT NULL,
        blob_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX collaboration_files_source_created
        ON collaboration_files(source, created_at, file_id);
      CREATE INDEX collaboration_files_source_assign_created
        ON collaboration_files(source, assign, created_at, file_id);
      CREATE INDEX collaboration_files_blob_key
        ON collaboration_files(blob_key);
      INSERT INTO collaboration_schema_versions (component, version)
      VALUES ('${SCHEMA_COMPONENT}', ${SCHEMA_VERSION});
    `);
  }

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
    if (this._disposed) throw new Error("SQLite File Database Adapter is disposed");
  }
}

const SELECT_COLUMNS = `SELECT file_id, name, size, content_type, source, assign, blob_key, created_at
  FROM collaboration_files`;

function rowToRecord(row: FileRow): FileRecord {
  return {
    fileID: row.file_id,
    name: row.name,
    size: Number(row.size),
    contentType: row.content_type,
    source: Number(row.source),
    assign: row.assign,
    blobKey: row.blob_key,
    createdAt: Number(row.created_at),
  };
}

function encodeCursor(record: FileRecord): string {
  return Buffer.from(JSON.stringify([record.createdAt, record.fileID])).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: number; fileID: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && Number.isSafeInteger(value[0]) && typeof value[1] === "string") {
      return { createdAt: value[0] as number, fileID: value[1] };
    }
  } catch {
    // Falls through to the single error below.
  }
  throw new FileError("INVALID_REQUEST", "Invalid list cursor");
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}
