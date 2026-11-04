import { FileError, type IUniverFileService } from "@univerjs-pro/collaboration-file-service";
import type {
  NodeHttpTransportContext,
  NodeRouter,
  NodeTransportEndpoint,
} from "@univerjs-pro/collaboration-transport-node";
import { writeDownload } from "./download-response.js";
import { OK_ERROR, writeDownloadFailure, writeJson, writeJsonFailure } from "./protocol-errors.js";
import { parseUploadQuery, readUploadPart, type UploadPart } from "./upload-reader.js";

/** @public */
export interface UniverFileEndpointOptions {
  /** Defaults to `/universer-api`; absolute, no trailing slash. */
  readonly routePrefix?: string;
  /** Defaults to unlimited. Counted on bytes actually read, after inflate. */
  readonly maxUploadBytes?: number;
  /** Defaults to 10 minutes, measured from the start of request handling. */
  readonly uploadTimeoutMs?: number;
  /** `max-age` of proxy downloads in seconds. Defaults to 3600; `0` makes browsers revalidate every time. */
  readonly downloadCacheMaxAgeSeconds?: number;
}

const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_DOWNLOAD_CACHE_MAX_AGE_SECONDS = 3600;

/**
 * The file routes the Univer frontend calls, on top of the Node Transport:
 * `POST {prefix}/stream/file/upload`, `GET {prefix}/file/{fileID}/sign-url` and
 * `GET {prefix}/file/{fileID}/download`. Authentication is the Transport ingress middleware's job;
 * this Endpoint only maps HTTP to `IUniverFileService` and back.
 * @public
 */
export class UniverFileEndpoint implements NodeTransportEndpoint {
  private readonly _service: IUniverFileService;
  private readonly _routePrefix: string;
  private readonly _maxUploadBytes: number | undefined;
  private readonly _uploadTimeoutMs: number;
  private readonly _downloadCacheMaxAgeSeconds: number;
  private readonly _calls = new Set<Promise<unknown>>();
  private _disposed = false;
  private _disposePromise: Promise<void> | undefined;

  constructor(service: IUniverFileService, options: UniverFileEndpointOptions = {}) {
    if (!service) throw new TypeError("UniverFileEndpoint requires a service");
    this._service = service;
    this._routePrefix = normalizePrefix(options.routePrefix ?? "/universer-api");
    this._maxUploadBytes = positiveOrUndefined(options.maxUploadBytes, "maxUploadBytes");
    this._uploadTimeoutMs = positiveOrUndefined(options.uploadTimeoutMs, "uploadTimeoutMs") ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this._downloadCacheMaxAgeSeconds = nonNegativeIntegerOrDefault(
      options.downloadCacheMaxAgeSeconds,
      "downloadCacheMaxAgeSeconds",
      DEFAULT_DOWNLOAD_CACHE_MAX_AGE_SECONDS
    );
  }

  register(router: NodeRouter): void {
    if (this._disposed) throw new FileError("SERVICE_DISPOSED", "File Endpoint is disposed");
    router.post(`${this._routePrefix}/stream/file/upload`, (ctx) => this._track(this._handleUpload(ctx)));
    router.get(`${this._routePrefix}/file/:fileID/sign-url`, (ctx) => this._track(this._handleSignUrl(ctx)));
    router.get(`${this._routePrefix}/file/:fileID/download`, (ctx) => this._track(this._handleDownload(ctx)));
  }

  dispose(): Promise<void> {
    if (this._disposePromise) return this._disposePromise;
    this._disposed = true;
    this._disposePromise = Promise.allSettled([...this._calls]).then(() => undefined);
    return this._disposePromise;
  }

  // Upload: query parameters, then the streamed multipart part, then Service.upload. The response is
  // { error, FileId }; the JSON field is spelled FileId on the wire.
  private async _handleUpload(ctx: NodeHttpTransportContext): Promise<void> {
    let part: UploadPart | undefined;
    try {
      const userID = this._requireUser(ctx);
      const query = parseUploadQuery(requestUrl(ctx));
      part = await readUploadPart(ctx.incomingMessage, query, {
        maxBytes: this._maxUploadBytes,
        timeoutMs: this._uploadTimeoutMs,
      });
      const record = await this._service.upload(
        {
          name: part.name,
          contentType: part.contentType,
          ...(query.size === undefined ? {} : { size: query.size }),
          source: query.source,
          assign: query.assign,
          flate: query.flate,
          content: part.content,
        },
        { userID, customData: ctx.customData }
      );
      writeJson(ctx.response, 200, { error: OK_ERROR, FileId: record.fileID });
    } catch (error) {
      part?.release();
      closeUnreadRequest(ctx);
      writeJsonFailure(ctx.response, error, { FileId: "" });
    } finally {
      part?.release();
    }
  }

  // sign-url: a direct link is returned as an absolute URL; otherwise the relative path of the proxy
  // route, which the frontend resolves against downloadEndpointUrl.
  private async _handleSignUrl(ctx: NodeHttpTransportContext): Promise<void> {
    try {
      const userID = this._requireUser(ctx);
      const fileID = routeFileID(ctx);
      const result = await this._service.signUrl({ fileID }, { userID, customData: ctx.customData });
      const url = result.direct?.url ?? `${this._routePrefix}/file/${encodeURIComponent(fileID)}/download`;
      writeJson(ctx.response, 200, { error: OK_ERROR, url });
    } catch (error) {
      writeJsonFailure(ctx.response, error, { url: "" });
    }
  }

  // Proxy download: ingress identity, then Service.openDownload (built-in ownership check and download
  // middleware), then the streamed response.
  private async _handleDownload(ctx: NodeHttpTransportContext): Promise<void> {
    try {
      const userID = this._requireUser(ctx);
      const fileID = routeFileID(ctx);
      const { record, content } = await this._service.openDownload({ fileID }, { userID, customData: ctx.customData });
      await writeDownload(ctx.response, record, content, this._downloadCacheMaxAgeSeconds);
    } catch (error) {
      writeDownloadFailure(ctx.response, error);
    }
  }

  private _requireUser(ctx: NodeHttpTransportContext): string {
    if (this._disposed) throw new FileError("SERVICE_DISPOSED", "File Endpoint is disposed");
    if (!ctx.userID) throw new FileError("UNAUTHENTICATED", "HTTP user is not authenticated");
    return ctx.userID;
  }

  private _track<T>(call: Promise<T>): Promise<T> {
    this._calls.add(call);
    void call.finally(() => this._calls.delete(call)).catch(() => undefined);
    return call;
  }
}

// A rejected, oversized or timed-out upload may leave the request body unread. Draining the rest would
// defeat the size limit and the timeout, so the response closes the connection instead.
function closeUnreadRequest(ctx: NodeHttpTransportContext): void {
  if (ctx.incomingMessage.complete || ctx.response.headersSent) return;
  ctx.response.setHeader("connection", "close");
  ctx.response.once("finish", () => ctx.incomingMessage.destroy());
}

function routeFileID(ctx: NodeHttpTransportContext): string {
  const fileID = ctx.params.fileID;
  if (!fileID || fileID.includes("/")) throw new FileError("INVALID_REQUEST", "Invalid route fileID");
  return fileID;
}

function requestUrl(ctx: NodeHttpTransportContext): URL {
  return new URL(ctx.incomingMessage.url ?? "/", "http://localhost");
}

function normalizePrefix(value: string): string {
  if (!value.startsWith("/") || value === "/" || value.endsWith("/") || value.includes("//")) {
    throw new TypeError("routePrefix must be an absolute path without a trailing slash");
  }
  return value;
}

function positiveOrUndefined(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`);
  return value;
}

function nonNegativeIntegerOrDefault(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}
