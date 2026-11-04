import {
  FileError,
  type DeleteFileDatabaseResult,
  type FileDatabaseContext,
  type FileRecord,
  type IFileDatabaseAdapter,
  type ListFilesQuery,
  type ListFilesResult,
} from "@univerjs-pro/collaboration-file-service";

/**
 * In-memory metadata adapter for tests and demos: one record per `fileID`, no sharing.
 * @public
 */
export class MemoryFileDatabaseAdapter implements IFileDatabaseAdapter {
  private readonly _records = new Map<string, FileRecord>();

  async create(record: FileRecord, _context: FileDatabaseContext): Promise<void> {
    if (this._records.has(record.fileID)) {
      throw new FileError("INVALID_REQUEST", `File ${record.fileID} already exists`);
    }
    this._records.set(record.fileID, record);
  }

  async get(fileID: string, _context: FileDatabaseContext): Promise<FileRecord | null> {
    return this._records.get(fileID) ?? null;
  }

  // One-to-one storage: deleting a record releases its own blobKey.
  async delete(fileID: string, _context: FileDatabaseContext): Promise<DeleteFileDatabaseResult | null> {
    const record = this._records.get(fileID);
    if (!record) return null;
    this._records.delete(fileID);
    return { record, releasedBlobKey: record.blobKey };
  }

  // Filters everything, sorts by (createdAt, fileID) and takes limit records after the cursor. No
  // indexes: this reference implementation favors readability.
  async list(query: ListFilesQuery, _context: FileDatabaseContext): Promise<ListFilesResult> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const matched = [...this._records.values()]
      .filter((record) => record.source === query.source)
      .filter((record) => query.assign === undefined || record.assign === query.assign)
      .filter((record) => query.createdBefore === undefined || record.createdAt < query.createdBefore)
      .filter((record) => after === undefined || compareKey(record, after) > 0)
      .sort(compareKey);
    const records = matched.slice(0, query.limit);
    const last = records.at(-1);
    return {
      records,
      nextCursor: matched.length > query.limit && last ? encodeCursor(last) : null,
    };
  }

  async dispose(): Promise<void> {
    this._records.clear();
  }
}

interface CursorKey {
  readonly createdAt: number;
  readonly fileID: string;
}

function compareKey(a: CursorKey, b: CursorKey): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.fileID < b.fileID ? -1 : a.fileID > b.fileID ? 1 : 0;
}

// The cursor is the (createdAt, fileID) of the previous page's last record as base64url JSON; opaque to callers.
function encodeCursor(record: FileRecord): string {
  return Buffer.from(JSON.stringify([record.createdAt, record.fileID])).toString("base64url");
}

function decodeCursor(cursor: string): CursorKey {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      typeof value[1] === "string"
    ) {
      return { createdAt: value[0] as number, fileID: value[1] };
    }
  } catch {
    // Falls through to the single error below.
  }
  throw new FileError("INVALID_REQUEST", "Invalid list cursor");
}
