import type { FileContext } from "./common.js";
import type { DirectUrl, FileContent, FileRecord, FileRequest } from "./types.js";

/** @public */
export type FileBlobContext<TRequest extends FileRequest = FileRequest> = FileContext<TRequest>;

/** @public */
export interface PutBlobInput {
  readonly fileID: string;
  readonly contentType: string;
  readonly content: FileContent;
}

/**
 * `size` is the number of bytes actually written.
 * @public
 */
export interface PutBlobResult {
  readonly blobKey: string;
  readonly size: number;
}

/** @public */
export interface SignDirectUrlInput {
  readonly blobKey: string;
  readonly record: FileRecord;
}

/**
 * Blob storage contract. Stores know nothing about `source`, ownership or expiry; they map an
 * opaque `blobKey` to bytes and optionally sign direct links.
 * @public
 */
export interface IFileBlobStore {
  /** Writes the stream and returns its locator. Must clean up partial writes on failure. */
  put(input: PutBlobInput, context: FileBlobContext): Promise<PutBlobResult>;
  /** Throws `FileError("FILE_NOT_FOUND")` when the key does not exist. */
  open(blobKey: string, context: FileBlobContext): Promise<FileContent>;
  /** Missing keys are treated as success. */
  delete(blobKey: string, context: FileBlobContext): Promise<void>;
  /**
   * Optional. Returns a direct link, or `null` when the store is not configured to sign one; the
   * expiry is the store's own configuration. Without it the Service serves through the proxy route.
   */
  signUrl?(input: SignDirectUrlInput, context: FileBlobContext): Promise<DirectUrl | null>;
  /** Releases resources the store created itself; never closes injected clients. */
  dispose(): Promise<void>;
}
