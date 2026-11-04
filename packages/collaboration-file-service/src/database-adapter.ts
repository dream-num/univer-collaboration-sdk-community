import type { FileContext } from "./common.js";
import type { FileRecord, FileRequest, ListFilesInput, ListFilesResult } from "./types.js";

/** @public */
export type FileDatabaseContext<TRequest extends FileRequest = FileRequest> = FileContext<TRequest>;

/** @public */
export interface ListFilesQuery extends ListFilesInput {}

/**
 * `releasedBlobKey` tells the Service whether the content is no longer referenced by any record.
 * One-to-one adapters always return the record's own key; adapters that share content between
 * records count references and return `null` while others remain.
 * @public
 */
export interface DeleteFileDatabaseResult {
  readonly record: FileRecord;
  readonly releasedBlobKey: string | null;
}

/**
 * Metadata storage contract. Adapters store `FileRecord`s and nothing else: no content access,
 * no authorization, no cleanup policy. The Service owns write and delete ordering.
 * @public
 */
export interface IFileDatabaseAdapter {
  /** Throws `FileError("INVALID_REQUEST")` when `fileID` already exists. */
  create(record: FileRecord, context: FileDatabaseContext): Promise<void>;
  /** Returns `null` when the record does not exist. */
  get(fileID: string, context: FileDatabaseContext): Promise<FileRecord | null>;
  /** Returns `null` when the record does not exist. */
  delete(fileID: string, context: FileDatabaseContext): Promise<DeleteFileDatabaseResult | null>;
  /**
   * Ordered by `(createdAt, fileID)` ascending. The adapter encodes `nextCursor` from the last record of
   * the page (opaque to callers) and throws `FileError("INVALID_REQUEST")` for a cursor it cannot decode.
   */
  list(query: ListFilesQuery, context: FileDatabaseContext): Promise<ListFilesResult>;
  /** Releases resources the adapter created itself; never closes injected connections. */
  dispose(): Promise<void>;
}
