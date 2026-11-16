import type { Pool } from "pg";
import {
  FileError,
  type DeleteFileDatabaseResult,
  type FileDatabaseContext,
  type FileRecord,
  type IFileDatabaseAdapter,
  type ListFilesQuery,
  type ListFilesResult,
} from "@univerjs-pro/collaboration-file-service";
import { initializeSchema } from "./schema.js";

interface FileRow {
  readonly file_id: string;
  readonly name: string;
  readonly size: string | number;
  readonly content_type: string;
  readonly source: number;
  readonly assign: string;
  readonly blob_key: string;
  readonly created_at: string | number;
}

/** @public */
export interface PostgresFileDatabaseAdapterOptions {
  /** Application-owned pool. The adapter never ends it. */
  readonly pool: Pool;
}

/**
 * Postgres metadata adapter for single-node and multi-node deployments. One record per `fileID`,
 * so `delete` always releases the record's own `blobKey`. Create it with
 * `PostgresFileDatabaseAdapter.create()`, which creates the schema on first use and records it in
 * `collaboration.schema_versions` under the `file` component.
 * @public
 */
export class PostgresFileDatabaseAdapter implements IFileDatabaseAdapter {
  private constructor(private readonly _pool: Pool) {}

  /** Validates or creates the schema, then returns a ready adapter. */
  static async create(options: PostgresFileDatabaseAdapterOptions): Promise<PostgresFileDatabaseAdapter> {
    const pool = options?.pool;
    if (!pool) throw new TypeError("PostgresFileDatabaseAdapter requires a pool");
    await initializeSchema(pool);
    return new PostgresFileDatabaseAdapter(pool);
  }

  async create(record: FileRecord, _context: FileDatabaseContext): Promise<void> {
    try {
      await this._pool.query(
        `INSERT INTO collaboration.files
         (file_id, name, size, content_type, source, assign, blob_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          record.fileID,
          record.name,
          record.size,
          record.contentType,
          record.source,
          record.assign,
          record.blobKey,
          record.createdAt,
        ]
      );
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "23505") {
        throw new FileError("INVALID_REQUEST", `File ${record.fileID} already exists`);
      }
      throw error;
    }
  }

  async get(fileID: string, _context: FileDatabaseContext): Promise<FileRecord | null> {
    const result = await this._pool.query<FileRow>(`${SELECT_COLUMNS} WHERE file_id = $1`, [fileID]);
    const row = result.rows[0];
    return row ? rowToRecord(row) : null;
  }

  // One DELETE ... RETURNING removes and returns the record atomically; one-to-one storage releases its own blobKey.
  async delete(fileID: string, _context: FileDatabaseContext): Promise<DeleteFileDatabaseResult | null> {
    const result = await this._pool.query<FileRow>(
      `DELETE FROM collaboration.files WHERE file_id = $1 RETURNING ${COLUMNS}`,
      [fileID]
    );
    const row = result.rows[0];
    if (!row) return null;
    const record = rowToRecord(row);
    return { record, releasedBlobKey: record.blobKey };
  }

  // Keyset paging: one extra row tells whether another page exists; the cursor is the (createdAt, fileID)
  // of the previous page's last record.
  async list(query: ListFilesQuery, _context: FileDatabaseContext): Promise<ListFilesResult> {
    const where = ["source = $1"];
    const params: Array<string | number> = [query.source];
    if (query.assign !== undefined) {
      params.push(query.assign);
      where.push(`assign = $${params.length}`);
    }
    if (query.createdBefore !== undefined) {
      params.push(query.createdBefore);
      where.push(`created_at < $${params.length}`);
    }
    if (query.cursor !== undefined) {
      const after = decodeCursor(query.cursor);
      params.push(after.createdAt, after.fileID);
      where.push(`(created_at, file_id) > ($${params.length - 1}, $${params.length})`);
    }
    params.push(query.limit + 1);
    const result = await this._pool.query<FileRow>(
      `${SELECT_COLUMNS} WHERE ${where.join(" AND ")} ORDER BY created_at, file_id LIMIT $${params.length}`,
      params
    );
    const records = result.rows.slice(0, query.limit).map(rowToRecord);
    const last = records.at(-1);
    return { records, nextCursor: result.rows.length > query.limit && last ? encodeCursor(last) : null };
  }

  /** The pool belongs to the application and stays open. */
  async dispose(): Promise<void> {}
}

const COLUMNS = "file_id, name, size, content_type, source, assign, blob_key, created_at";
const SELECT_COLUMNS = `SELECT ${COLUMNS} FROM collaboration.files`;

// BIGINT columns arrive as strings from node-postgres.
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
