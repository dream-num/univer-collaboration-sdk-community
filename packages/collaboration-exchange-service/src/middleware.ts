import type { Disposable } from "@univerjs-pro/collaboration-service";
import type { ExchangeContext, ExchangeSnapshot, ExportRequest, ImportRequest } from "./types.js";

/** Runs after request validation and the source file ownership check, before the task is created. @public */
export type ImportMiddlewareContext = ExchangeContext<ImportRequest>;

/**
 * Runs before the task is created: after the Unit is read for a `unitID` export, after the snapshot
 * is decoded for a `jsonID` export. `snapshot` is present only for `jsonID` exports.
 * @public
 */
export interface ExportMiddlewareContext extends ExchangeContext<ExportRequest> {
  readonly snapshot?: ExchangeSnapshot;
}

/** @public */
export type ExchangeMiddlewareNext = () => Promise<void>;
/** @public */
export type ExchangeMiddleware<TContext> = (context: TContext, next: ExchangeMiddlewareNext) => void | Promise<void>;

/** @public */
export type ExchangeMiddlewareAction = "import" | "export";

/** @public */
export interface ExchangeMiddlewareMap {
  readonly import: ExchangeMiddleware<ImportMiddlewareContext>;
  readonly export: ExchangeMiddleware<ExportMiddlewareContext>;
}

type InternalMiddleware = ExchangeMiddleware<unknown>;

// One chain per action; next() only continues within the same action.
export class ExchangeMiddlewareRegistry {
  private readonly _middlewares = new Map<ExchangeMiddlewareAction, InternalMiddleware[]>();

  use<K extends ExchangeMiddlewareAction>(action: K, middleware: ExchangeMiddlewareMap[K]): Disposable {
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

  async run<TContext>(action: ExchangeMiddlewareAction, context: TContext): Promise<void> {
    const chain = [...(this._middlewares.get(action) ?? [])];
    const dispatch = async (index: number): Promise<void> => {
      const middleware = chain[index];
      if (!middleware) return;
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
