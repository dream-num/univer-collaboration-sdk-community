import type { Disposable, FileContext } from "./common.js";
import type { DownloadRequest, FileRecord, SignUrlRequest, UploadRequest } from "./types.js";

/**
 * Runs before any upload bytes are read; `request` is read-only.
 * @public
 */
export type UploadMiddlewareContext = FileContext<UploadRequest>;

/**
 * Runs after the built-in ownership check, before a URL is issued.
 * @public
 */
export interface SignUrlMiddlewareContext extends FileContext<SignUrlRequest> {
  readonly record: FileRecord;
}

/**
 * Proxy download only; runs after the built-in ownership check, before the content stream opens.
 * @public
 */
export interface DownloadMiddlewareContext extends FileContext<DownloadRequest> {
  readonly record: FileRecord;
}

/** @public */
export type FileMiddlewareNext = () => Promise<void>;
/** @public */
export type FileMiddleware<TContext> = (
  context: TContext,
  next: FileMiddlewareNext
) => void | Promise<void>;

/**
 * Lifecycle stages of the HTTP-facing Service methods. Trusted-layer methods never run middleware.
 * @public
 */
export type FileMiddlewareAction = "upload" | "signUrl" | "download";

/** @public */
export interface FileMiddlewareMap {
  readonly upload: FileMiddleware<UploadMiddlewareContext>;
  readonly signUrl: FileMiddleware<SignUrlMiddlewareContext>;
  readonly download: FileMiddleware<DownloadMiddlewareContext>;
}

type InternalMiddleware = FileMiddleware<unknown>;

// One chain per action; next() only continues within the same action.
export class FileMiddlewareRegistry {
  private readonly _middlewares = new Map<FileMiddlewareAction, InternalMiddleware[]>();

  use<K extends FileMiddlewareAction>(action: K, middleware: FileMiddlewareMap[K]): Disposable {
    const list = this._middlewares.get(action) ?? [];
    const internal = middleware as InternalMiddleware;
    list.push(internal);
    this._middlewares.set(action, list);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const index = list.indexOf(internal);
        if (index >= 0) list.splice(index, 1);
      },
    };
  }

  async run<TContext>(
    action: FileMiddlewareAction,
    context: TContext,
    terminal: () => void | Promise<void>
  ): Promise<void> {
    const chain = [...(this._middlewares.get(action) ?? [])];
    const dispatch = async (index: number): Promise<void> => {
      const middleware = chain[index];
      if (!middleware) return terminal();
      let called = false;
      let downstream: Promise<void> | undefined;
      const next = () => {
        if (called) throw new Error(`Middleware for action ${action} called next() more than once`);
        called = true;
        downstream = dispatch(index + 1);
        return downstream;
      };
      try {
        await middleware(context, next);
      } catch (error) {
        if (downstream) await downstream.catch(() => undefined);
        throw error;
      }
      if (!called) throw new Error(`Middleware for action ${action} completed without calling next()`);
      await downstream;
    };
    await dispatch(0);
  }

  clear(): void {
    this._middlewares.clear();
  }
}
