import { ExchangeServiceError, type IUniverExchangeService } from "@univerjs-pro/collaboration-exchange-service";
import type {
  NodeHttpTransportContext,
  NodeRouter,
  NodeTransportEndpoint,
} from "@univerjs-pro/collaboration-transport-node";
import type { CollabContext } from "@univerjs-pro/collaboration-service";
import { parseExportBody, parseImportBody, parseRouteType, taskResponseBody } from "./protocol.js";
import { OK_ERROR, protocolError, writeJson } from "./protocol-errors.js";

/** @public */
export interface UniverExchangeEndpointOptions {
  /** Defaults to `/universer-api`; absolute, no trailing slash. */
  readonly routePrefix?: string;
}

/**
 * The exchange routes the Univer frontend calls, on top of the Node Transport:
 * `POST {prefix}/exchange/{type}/import`, `POST {prefix}/exchange/{type}/export` and
 * `GET {prefix}/exchange/task/{taskID}`. Authentication is the Transport ingress middleware's job;
 * every business error is answered with HTTP 200 and the protocol code in `error.code`.
 * @public
 */
export class UniverExchangeEndpoint implements NodeTransportEndpoint {
  private readonly _service: IUniverExchangeService;
  private readonly _routePrefix: string;
  private readonly _calls = new Set<Promise<unknown>>();
  private _disposed = false;
  private _disposePromise: Promise<void> | undefined;

  constructor(service: IUniverExchangeService, options: UniverExchangeEndpointOptions = {}) {
    if (!service) throw new TypeError("UniverExchangeEndpoint requires a service");
    this._service = service;
    this._routePrefix = normalizePrefix(options.routePrefix ?? "/universer-api");
  }

  register(router: NodeRouter): void {
    if (this._disposed) throw disposedError();
    router.post(`${this._routePrefix}/exchange/:type/import`, (ctx) => this._track(this._handleImport(ctx)));
    router.post(`${this._routePrefix}/exchange/:type/export`, (ctx) => this._track(this._handleExport(ctx)));
    router.get(`${this._routePrefix}/exchange/task/:taskID`, (ctx) => this._track(this._handleTask(ctx)));
  }

  // The Endpoint does not dispose the Service; it only waits for requests already in flight to finish their responses.
  dispose(): Promise<void> {
    if (this._disposePromise) return this._disposePromise;
    this._disposed = true;
    this._disposePromise = Promise.allSettled([...this._calls]).then(() => undefined);
    return this._disposePromise;
  }

  private async _handleImport(ctx: NodeHttpTransportContext): Promise<void> {
    try {
      const context = this._context(ctx);
      const input = parseImportBody(parseRouteType(ctx.params.type), await ctx.readJson());
      const taskID = await this._service.createImportTask(input, context);
      writeJson(ctx.response, { error: OK_ERROR, taskID });
    } catch (error) {
      writeJson(ctx.response, { error: protocolError(error), taskID: "" });
    }
  }

  private async _handleExport(ctx: NodeHttpTransportContext): Promise<void> {
    try {
      const context = this._context(ctx);
      const input = parseExportBody(parseRouteType(ctx.params.type), await ctx.readJson());
      const taskID = await this._service.createExportTask(input, context);
      writeJson(ctx.response, { error: OK_ERROR, taskID });
    } catch (error) {
      writeJson(ctx.response, { error: protocolError(error), taskID: "" });
    }
  }

  private async _handleTask(ctx: NodeHttpTransportContext): Promise<void> {
    const taskID = ctx.params.taskID ?? "";
    try {
      const task = await this._service.getTask(taskID, this._context(ctx));
      writeJson(ctx.response, taskResponseBody(task, protocolError));
    } catch (error) {
      writeJson(ctx.response, { error: protocolError(error), taskID, status: "failed" });
    }
  }

  private _context(ctx: NodeHttpTransportContext): CollabContext {
    if (this._disposed) throw disposedError();
    if (!ctx.userID) throw new ExchangeServiceError("UNAUTHENTICATED", "HTTP user is not authenticated");
    return { userID: ctx.userID, customData: ctx.customData };
  }

  private _track<T>(call: Promise<T>): Promise<T> {
    this._calls.add(call);
    void call.finally(() => this._calls.delete(call)).catch(() => undefined);
    return call;
  }
}

function disposedError(): ExchangeServiceError {
  return new ExchangeServiceError("SERVICE_DISPOSED", "Exchange Endpoint is disposed");
}

function normalizePrefix(value: string): string {
  if (!value.startsWith("/") || value === "/" || value.endsWith("/") || value.includes("//")) {
    throw new TypeError("routePrefix must be an absolute path without a trailing slash");
  }
  return value;
}
