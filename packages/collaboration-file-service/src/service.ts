import { randomUUID } from "node:crypto";
import { FileSource } from "@univerjs/protocol";
import type { Disposable, FileCallContext, FileContext, FileCustomData } from "./common.js";
import { FileCleanupScheduler, CLEANUP_DEFAULTS, CLEANUP_SOURCES, type FileCleanupOptions } from "./cleanup.js";
import type { IFileBlobStore } from "./blob-store.js";
import type { IFileDatabaseAdapter } from "./database-adapter.js";
import { FileError, fileNotFound, invalidRequest, permissionDenied, storageFailure } from "./errors.js";
import { FileMiddlewareRegistry, type FileMiddlewareAction, type FileMiddlewareMap } from "./middleware.js";
import type {
  CleanupInput,
  CleanupRequest,
  CleanupResult,
  CreateFileInput,
  CreateFileRequest,
  DeleteFileRequest,
  DownloadInput,
  DownloadRequest,
  FileRecord,
  FileRequest,
  GetFileRequest,
  ListFilesInput,
  ListFilesRequest,
  ListFilesResult,
  OpenDownloadResult,
  OpenFileRequest,
  OpenFileResult,
  SignUrlInput,
  SignUrlRequest,
  SignUrlResult,
  UploadInput,
  UploadRequest,
} from "./types.js";

/** @public */
export interface UniverFileServiceOptions {
  readonly database: IFileDatabaseAdapter;
  readonly blobStore: IFileBlobStore;
  /**
   * The built-in cleanup timer runs by default. Pass options to tune it, or `false` to run
   * `cleanupExpiredFiles` from the application's own scheduler.
   */
  readonly cleanup?: FileCleanupOptions | false;
  /** Receives cleanup failures and content-delete failures that leave orphan objects. */
  readonly logger?: FileServiceLogger;
}

/**
 * Minimal logger surface; defaults to `console`.
 * @public
 */
export interface FileServiceLogger {
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/**
 * The File Service contract. Checked operations run the built-in ownership check and middleware;
 * direct operations read and write files for server code (Exchange, the application) and run neither.
 * @public
 */
export interface IUniverFileService {
  use<K extends FileMiddlewareAction>(action: K, middleware: FileMiddlewareMap[K]): Disposable;

  // Checked operations
  upload(input: UploadInput, context: FileCallContext): Promise<FileRecord>;
  signUrl(input: SignUrlInput, context: FileCallContext): Promise<SignUrlResult>;
  openDownload(input: DownloadInput, context: FileCallContext): Promise<OpenDownloadResult>;

  // Direct operations
  createFile(input: CreateFileInput, context: FileCallContext): Promise<FileRecord>;
  getFile(fileID: string, context: FileCallContext): Promise<FileRecord | null>;
  openFile(fileID: string, context: FileCallContext): Promise<OpenFileResult>;
  deleteFile(fileID: string, context: FileCallContext): Promise<boolean>;
  listFiles(input: ListFilesInput, context: FileCallContext): Promise<ListFilesResult>;
  cleanupExpiredFiles(input: CleanupInput, context: FileCallContext): Promise<CleanupResult>;

  dispose(): Promise<void>;
}

/**
 * Orchestrates metadata and content: write order, delete order, built-in ownership rules,
 * middleware and expiry cleanup. Adapters never see these rules.
 * @public
 */
export class UniverFileService implements IUniverFileService {
  private readonly _database: IFileDatabaseAdapter;
  private readonly _blobStore: IFileBlobStore;
  private readonly _logger: FileServiceLogger;
  private readonly _middleware = new FileMiddlewareRegistry();
  private readonly _cleanupScheduler: FileCleanupScheduler | undefined;
  private readonly _calls = new Set<Promise<unknown>>();
  // A round still running in this process skips the next one; across nodes, idempotent deletes make
  // concurrent rounds safe without a lock.
  private _cleanupInProgress = false;
  private _state: "running" | "disposing" | "disposed" = "running";
  private _disposePromise: Promise<void> | undefined;

  constructor(options: UniverFileServiceOptions) {
    if (!options?.database) throw new TypeError("UniverFileService requires a database");
    if (!options?.blobStore) throw new TypeError("UniverFileService requires a blobStore");
    this._database = options.database;
    this._blobStore = options.blobStore;
    this._logger = options.logger ?? console;
    if (options.cleanup !== false) {
      this._cleanupScheduler = new FileCleanupScheduler(
        options.cleanup ?? {},
        (context, input) => this.cleanupExpiredFiles(input, context),
        (error) => this._logger.error("File cleanup round failed", { error })
      );
      this._cleanupScheduler.start();
    }
  }

  use<K extends FileMiddlewareAction>(action: K, middleware: FileMiddlewareMap[K]): Disposable {
    this._assertRunning();
    return this._middleware.use(action, middleware);
  }

  // ---------------------------------------------------------- Checked operations

  upload(input: UploadInput, context: FileCallContext): Promise<FileRecord> {
    return this._call(async () => {
      const source = normalizeSource(input.source);
      // HttpImport / HttpExport force assign to the uploader; UnitEmbedded requires a unitID.
      const assign =
        source === FileSource.HttpImport || source === FileSource.HttpExport ? context.userID : input.assign;
      if (source === FileSource.UnitEmbedded && !assign) {
        throw invalidRequest("UnitEmbedded upload requires assign (unitID)");
      }
      const request: UploadRequest = Object.freeze({
        name: input.name,
        contentType: input.contentType,
        ...(input.size === undefined ? {} : { size: input.size }),
        source,
        assign,
        flate: input.flate,
      });
      const ctx = this._resolve(context, request);
      let record: FileRecord | undefined;
      await this._middleware.run("upload", ctx, async () => {
        record = await this._store(
          { name: request.name, contentType: request.contentType, source, assign, content: input.content },
          ctx
        );
      });
      return record!;
    });
  }

  signUrl(input: SignUrlInput, context: FileCallContext): Promise<SignUrlResult> {
    return this._call(async () => {
      const request: SignUrlRequest = Object.freeze({ fileID: requireFileID(input.fileID) });
      const ctx = this._resolve(context, request);
      const record = await this._getAuthorized(request.fileID, ctx);
      let result: SignUrlResult | undefined;
      await this._middleware.run("signUrl", { ...ctx, record }, async () => {
        const direct = this._blobStore.signUrl
          ? await this._storage("signUrl", () =>
              this._blobStore.signUrl!({ blobKey: record.blobKey, record }, ctx)
            )
          : null;
        result = direct ? { record, direct } : { record };
      });
      return result!;
    });
  }

  openDownload(input: DownloadInput, context: FileCallContext): Promise<OpenDownloadResult> {
    return this._call(async () => {
      const request: DownloadRequest = Object.freeze({ fileID: requireFileID(input.fileID) });
      const ctx = this._resolve(context, request);
      const record = await this._getAuthorized(request.fileID, ctx);
      let result: OpenDownloadResult | undefined;
      await this._middleware.run("download", { ...ctx, record }, async () => {
        const content = await this._storage("open", () => this._blobStore.open(record.blobKey, ctx));
        result = { record, content };
      });
      return result!;
    });
  }

  // ----------------------------------------------------------- Direct operations

  createFile(input: CreateFileInput, context: FileCallContext): Promise<FileRecord> {
    return this._call(() => {
      const request: CreateFileRequest = Object.freeze({
        name: input.name,
        contentType: input.contentType,
        source: normalizeSource(input.source),
        assign: input.assign,
      });
      return this._store({ ...request, content: input.content }, this._resolve(context, request));
    });
  }

  getFile(fileID: string, context: FileCallContext): Promise<FileRecord | null> {
    return this._call(() => {
      const request: GetFileRequest = Object.freeze({ fileID: requireFileID(fileID) });
      const ctx = this._resolve(context, request);
      return this._storage("get", () => this._database.get(request.fileID, ctx));
    });
  }

  openFile(fileID: string, context: FileCallContext): Promise<OpenFileResult> {
    return this._call(async () => {
      const request: OpenFileRequest = Object.freeze({ fileID: requireFileID(fileID) });
      const ctx = this._resolve(context, request);
      const record = await this._storage("get", () => this._database.get(request.fileID, ctx));
      if (!record) throw fileNotFound(request.fileID);
      const content = await this._storage("open", () => this._blobStore.open(record.blobKey, ctx));
      return { record, content };
    });
  }

  deleteFile(fileID: string, context: FileCallContext): Promise<boolean> {
    return this._call(() => {
      const request: DeleteFileRequest = Object.freeze({ fileID: requireFileID(fileID) });
      return this._delete(request.fileID, this._resolve(context, request));
    });
  }

  listFiles(input: ListFilesInput, context: FileCallContext): Promise<ListFilesResult> {
    return this._call(() => {
      if (!Number.isInteger(input.limit) || input.limit <= 0) throw invalidRequest("limit must be a positive integer");
      const request: ListFilesRequest = Object.freeze({ ...input, source: normalizeSource(input.source) });
      const ctx = this._resolve(context, request);
      return this._storage("list", () => this._database.list(request, ctx));
    });
  }

  cleanupExpiredFiles(input: CleanupInput, context: FileCallContext): Promise<CleanupResult> {
    return this._call(async () => {
      const request: CleanupRequest = Object.freeze({
        sources: CLEANUP_SOURCES,
        createdBefore: Date.now() - integerOption(input.retentionMs, "retentionMs", 0, CLEANUP_DEFAULTS.retentionMs),
        batchSize: integerOption(input.batchSize, "batchSize", 1, CLEANUP_DEFAULTS.batchSize),
        maxPerRun: integerOption(input.maxPerRun, "maxPerRun", 1, CLEANUP_DEFAULTS.maxPerRun),
        batchGapMs: integerOption(input.batchGapMs, "batchGapMs", 0, CLEANUP_DEFAULTS.batchGapMs),
      });
      const ctx = this._resolve(context, request);
      if (this._cleanupInProgress) return { scanned: 0, deleted: 0, failed: 0 };
      this._cleanupInProgress = true;
      try {
        return await this._cleanupRound(ctx);
      } finally {
        this._cleanupInProgress = false;
      }
    });
  }

  dispose(): Promise<void> {
    if (this._disposePromise) return this._disposePromise;
    this._state = "disposing";
    this._disposePromise = (async () => {
      await this._cleanupScheduler?.stop();
      await Promise.allSettled([...this._calls]);
      this._middleware.clear();
      this._state = "disposed";
      // Adapters passed in belong to the caller and are not disposed here.
    })();
    return this._disposePromise;
  }

  // ---------------------------------------------------------------- Orchestration

  // Write order: content first, then metadata. When the metadata write fails, the content just
  // written is deleted on a best-effort basis.
  private async _store(
    input: { name: string; contentType: string; source: number; assign: string; content: AsyncIterable<Uint8Array> },
    ctx: FileContext
  ): Promise<FileRecord> {
    const fileID = randomUUID();
    const put = await this._storage("put", () =>
      this._blobStore.put({ fileID, contentType: input.contentType, content: input.content }, ctx)
    );
    const record: FileRecord = Object.freeze({
      fileID,
      name: input.name,
      size: put.size,
      contentType: input.contentType,
      source: input.source,
      assign: input.assign,
      blobKey: put.blobKey,
      createdAt: Date.now(),
    });
    try {
      await this._storage("create", () => this._database.create(record, ctx));
    } catch (error) {
      await this._blobStore.delete(put.blobKey, ctx).catch((cause) =>
        this._logger.warn("Orphan content left after metadata write failed", { fileID, blobKey: put.blobKey, cause })
      );
      throw error;
    }
    return record;
  }

  // Delete order: metadata first, then the content once the metadata layer reports it unreferenced.
  // A failed content delete is only logged.
  private async _delete(fileID: string, ctx: FileContext): Promise<boolean> {
    const deleted = await this._storage("delete", () => this._database.delete(fileID, ctx));
    if (!deleted) return false;
    if (deleted.releasedBlobKey !== null) {
      await this._blobStore.delete(deleted.releasedBlobKey, ctx).catch((cause) =>
        this._logger.warn("Orphan content left after content delete failed", {
          fileID,
          blobKey: deleted.releasedBlobKey,
          cause,
        })
      );
    }
    return true;
  }

  // Built-in ownership check: HttpImport / HttpExport are readable only when assign === userID;
  // everything else is left to middleware.
  private async _getAuthorized(fileID: string, ctx: FileContext): Promise<FileRecord> {
    const record = await this._storage("get", () => this._database.get(fileID, ctx));
    if (!record) throw fileNotFound(fileID);
    if (
      (record.source === FileSource.HttpImport || record.source === FileSource.HttpExport) &&
      record.assign !== ctx.userID
    ) {
      throw permissionDenied("File belongs to another user");
    }
    return record;
  }

  // Each temporary source is listed in cursor pages and deleted record by record. The cursor continues
  // from the previous page instead of restarting, so records whose delete failed are skipped rather
  // than blocking the head of the queue. A round ends when scanned reaches maxPerRun, the cursor is
  // exhausted or the Service starts disposing.
  private async _cleanupRound(ctx: FileContext<CleanupRequest>): Promise<CleanupResult> {
    const { sources, createdBefore, batchSize, maxPerRun, batchGapMs } = ctx.request;
    let scanned = 0;
    let deleted = 0;
    let failed = 0;
    let firstBatch = true;
    for (const source of sources) {
      let cursor: string | undefined;
      while (scanned < maxPerRun && this._state === "running") {
        if (!firstBatch && batchGapMs > 0) await delay(batchGapMs);
        firstBatch = false;
        const limit = Math.min(batchSize, maxPerRun - scanned);
        const page = await this._storage("list", () =>
          this._database.list({ source, createdBefore, limit, ...(cursor === undefined ? {} : { cursor }) }, ctx)
        );
        for (const record of page.records) {
          scanned += 1;
          try {
            if (await this._delete(record.fileID, ctx)) deleted += 1;
          } catch (error) {
            failed += 1;
            this._logger.warn("File cleanup failed to delete an expired file", { fileID: record.fileID, error });
          }
        }
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
    }
    return { scanned, deleted, failed };
  }

  // ---------------------------------------------------------------- Infrastructure

  private _resolve<TRequest extends FileRequest>(context: FileCallContext, request: TRequest): FileContext<TRequest> {
    if (typeof context?.userID !== "string" || context.userID.length === 0) {
      throw invalidRequest("context.userID is required");
    }
    const customData: FileCustomData = context.customData ?? Object.create(null);
    return { userID: context.userID, customData, request };
  }

  private async _storage<T>(stage: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw storageFailure(stage, error);
    }
  }

  // Every method reports failures as a rejected Promise, including calls after dispose and
  // synchronous argument validation.
  private _call<T>(work: () => Promise<T>): Promise<T> {
    let call: Promise<T>;
    try {
      this._assertRunning();
      call = work();
    } catch (error) {
      return Promise.reject(error);
    }
    this._calls.add(call);
    void call.finally(() => this._calls.delete(call)).catch(() => undefined);
    return call;
  }

  private _assertRunning(): void {
    if (this._state !== "running") throw new FileError("SERVICE_DISPOSED", `File Service is ${this._state}`);
  }
}

function integerOption(value: number | undefined, name: string, min: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min) throw invalidRequest(`${name} must be an integer >= ${min}`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireFileID(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw invalidRequest("fileID is required");
  return value;
}

// A source that is not an int32 integer is stored as 0, matching the Univer server.
function normalizeSource(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) return 0;
  return value;
}
