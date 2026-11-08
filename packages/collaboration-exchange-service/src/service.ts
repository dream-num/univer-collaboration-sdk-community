import type { IUniverFileService } from "@univerjs-pro/collaboration-file-service";
import type { CollabContext, CustomData, Disposable, ILogger } from "@univerjs-pro/collaboration-service";
import { ExchangeServiceError, invalidRequest, taskNotFound } from "./errors.js";
import { runExportJob, type ExportSource } from "./export-job.js";
import { ExchangeFiles } from "./files.js";
import { exportFormatOf, importFormatOf, requireSupportedType } from "./formats.js";
import { runImportJob, type ImportSource } from "./import-job.js";
import type { JobEnvironment } from "./job-environment.js";
import { ExchangeMiddlewareRegistry, type ExchangeMiddlewareAction, type ExchangeMiddlewareMap } from "./middleware.js";
import { toExportOptions, toImportOptions } from "./options.js";
import { decodeSnapshotJson } from "./snapshot-json.js";
import { ExchangeTaskStore } from "./task-store.js";
import { IMPORT_OUTPUT_TYPE } from "./import-output-type.js";
import type { ExchangeTask, ExportInput, ExportRequest, ImportInput, ImportOutputType, ImportRequest } from "./types.js";
import { ExchangeUnits, type ExchangeRuntimeConfig, type IExchangeCollabService } from "./units.js";

/** @public */
export interface UniverExchangeServiceOptions {
  /** Creates imported Units and reads exported ones; its middleware applies unchanged. */
  readonly collabService: IExchangeCollabService;
  /** Source uploads, files split out of imported Units, and results are stored here. */
  readonly fileService: IUniverFileService;
  /** Receives failures the Service swallows, such as early file deletes. Without it, warn and error go to the console. */
  readonly logger?: ILogger;
  /** Where `unitID` exports materialize snapshots. Defaults to the collaboration Runtime's Worker execution. */
  readonly runtime?: ExchangeRuntimeConfig;
}

/**
 * The Exchange Service contract. `createImportTask` and `createExportTask` validate and authorize in
 * the request, then convert in the background; a rejected request creates no task.
 * @public
 */
export interface IUniverExchangeService {
  use<K extends ExchangeMiddlewareAction>(action: K, middleware: ExchangeMiddlewareMap[K]): Disposable;
  /** Resolves to the taskID. */
  createImportTask(input: ImportInput, context: CollabContext): Promise<string>;
  /** Resolves to the taskID. */
  createExportTask(input: ExportInput, context: CollabContext): Promise<string>;
  /** Only the task's creator can read it; other callers get `TASK_NOT_FOUND`. */
  getTask(taskID: string, context: CollabContext): Promise<ExchangeTask>;
  dispose(): Promise<void>;
}

interface ResolvedContext {
  readonly userID: string;
  readonly customData: CustomData;
}

/**
 * Runs Office/PDF import and export with `@univerjs-pro/exchange-node` inside this process. Tasks live
 * in memory on this instance only.
 * @public
 */
export class UniverExchangeService implements IUniverExchangeService {
  private readonly _files: ExchangeFiles;
  private readonly _units: ExchangeUnits;
  private readonly _tasks = new ExchangeTaskStore();
  private readonly _middleware = new ExchangeMiddlewareRegistry();
  private readonly _environment: JobEnvironment;
  private _disposePromise: Promise<void> | undefined;

  constructor(options: UniverExchangeServiceOptions) {
    if (!options?.collabService) throw new TypeError("UniverExchangeService requires a collabService");
    if (!options?.fileService) throw new TypeError("UniverExchangeService requires a fileService");
    this._files = new ExchangeFiles(options.fileService, options.logger ?? CONSOLE_LOGGER);
    this._units = new ExchangeUnits(options.collabService, options.runtime);
    this._environment = { files: this._files, units: this._units, isRunning: () => !this._disposePromise };
  }

  use<K extends ExchangeMiddlewareAction>(action: K, middleware: ExchangeMiddlewareMap[K]): Disposable {
    this._assertRunning();
    return this._middleware.use(action, middleware);
  }

  // Request stage: validation, source file ownership, import middleware, then the task. Any failure
  // means no task is created.
  createImportTask(input: ImportInput, context: CollabContext): Promise<string> {
    return this._call(async () => {
      const ctx = resolveContext(context);
      const request = importRequest(input);
      const { fileID, sourceUnitID } = request;
      let source: ImportSource;
      let fileName: string;
      if (sourceUnitID === undefined) {
        fileName = (await this._files.requireUpload(fileID, ctx)).name;
        source = { kind: "upload", fileID };
      } else {
        fileName = (await this._files.requireAttachment(fileID, sourceUnitID, ctx)).name;
        source = { kind: "attachment", fileID, unitID: sourceUnitID };
      }
      const format = importFormatOf(request.type, fileName);
      const options = toImportOptions(request.type, format, request.options);
      await this._middleware.run("import", { ...ctx, request });
      this._assertRunning();
      const job = { context: ctx, type: request.type, outputType: request.outputType, source, fileName, options };
      return this._start("import", ctx, source, async (taskID) =>
        this._tasks.completeImport(taskID, await runImportJob(job, this._environment))
      );
    });
  }

  // Request stage: validation, reading the Unit (readUnitData) or validating and decoding the uploaded
  // snapshot, export middleware, then the task.
  createExportTask(input: ExportInput, context: CollabContext): Promise<string> {
    return this._call(async () => {
      const ctx = resolveContext(context);
      const type = requireSupportedType(input?.type);
      const format = exportFormatOf(type, input.format);
      const options = toExportOptions(type, format, input.options);
      const optional = input.options === undefined ? {} : { options: input.options };
      const { unitID, jsonID } = exportSourceIDs(input);
      let source: ExportSource;
      if (unitID !== undefined) {
        const data = await this._units.read(unitID, type, ctx);
        const request: ExportRequest = Object.freeze({ type, unitID, format, ...optional });
        await this._middleware.run("export", { ...ctx, request });
        source = { kind: "unit", unitID, data };
      } else {
        await this._files.requireUpload(jsonID, ctx);
        const snapshot = decodeSnapshotJson(await this._files.read(jsonID, ctx));
        if (snapshot.snapshot.type !== type) {
          throw invalidRequest(`Snapshot type ${snapshot.snapshot.type} does not match Unit type ${type}`);
        }
        const request: ExportRequest = Object.freeze({ type, jsonID, format, ...optional });
        await this._middleware.run("export", { ...ctx, request, snapshot });
        source = { kind: "json", jsonID, snapshot };
      }
      this._assertRunning();
      const job = { context: ctx, type, format, source, options };
      return this._start("export", ctx, source, async (taskID) =>
        this._tasks.completeExport(taskID, await runExportJob(job, this._environment))
      );
    });
  }

  getTask(taskID: string, context: CollabContext): Promise<ExchangeTask> {
    return this._call(async () => {
      const ctx = resolveContext(context);
      const task = typeof taskID === "string" ? this._tasks.get(taskID, ctx.userID) : undefined;
      if (!task) throw taskNotFound(String(taskID));
      return task;
    });
  }

  // Conversions in progress are not awaited: task records go with the instance and the job discards
  // its result when the conversion ends.
  dispose(): Promise<void> {
    if (this._disposePromise) return this._disposePromise;
    this._disposePromise = (async () => {
      this._tasks.clear();
      this._middleware.clear();
      await this._units.dispose();
    })();
    return this._disposePromise;
  }

  // Creates the task and runs it in the background. Once the task reaches a final state (done or
  // failed) the temporary input is deleted. After dispose the task is left alone and no file is
  // deleted; the File Service's expiry cleanup takes over.
  private _start(
    kind: "import" | "export",
    ctx: ResolvedContext,
    source: ImportSource | ExportSource,
    work: (taskID: string) => Promise<void>
  ): string {
    const taskID = this._tasks.create(kind, ctx.userID);
    void (async () => {
      try {
        await work(taskID);
      } catch (error) {
        this._tasks.fail(taskID, error);
      }
      const temporary = temporaryFileOf(source);
      if (temporary !== undefined && !this._disposePromise) await this._files.deleteQuietly(temporary, ctx);
    })();
    return taskID;
  }

  // Every method reports failures as a rejected Promise, including calls after dispose and synchronous
  // argument validation.
  private _call<T>(work: () => Promise<T>): Promise<T> {
    try {
      this._assertRunning();
      return work();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private _assertRunning(): void {
    if (this._disposePromise) throw new ExchangeServiceError("SERVICE_DISPOSED", "Exchange Service is disposed");
  }
}

function resolveContext(context: CollabContext): ResolvedContext {
  if (typeof context?.userID !== "string" || context.userID.length === 0) {
    throw invalidRequest("context.userID is required");
  }
  return { userID: context.userID, customData: context.customData ?? Object.create(null) };
}

function importRequest(input: ImportInput): ImportRequest {
  const type = requireSupportedType(input?.type);
  if (input.outputType !== IMPORT_OUTPUT_TYPE.Unit && input.outputType !== IMPORT_OUTPUT_TYPE.Json) throw invalidRequest("outputType must be 1 or 2");
  const fileID = requireID(input.fileID, "fileID");
  const outputType: ImportOutputType = input.outputType;
  const sourceUnitID = optionalID(input.sourceUnitID, "sourceUnitID");
  if (sourceUnitID !== undefined && outputType !== IMPORT_OUTPUT_TYPE.Unit) throw invalidRequest("sourceUnitID requires outputType 1");
  return Object.freeze({
    type,
    outputType,
    fileID,
    ...(sourceUnitID === undefined ? {} : { sourceUnitID }),
    ...(input.options === undefined ? {} : { options: input.options }),
  });
}

function exportSourceIDs(input: ExportInput): { unitID: string; jsonID?: undefined } | { unitID?: undefined; jsonID: string } {
  const unitID = optionalID(input.unitID, "unitID");
  const jsonID = optionalID(input.jsonID, "jsonID");
  if ((unitID === undefined) === (jsonID === undefined)) throw invalidRequest("Exactly one of unitID and jsonID is required");
  return unitID === undefined ? { jsonID: jsonID! } : { unitID };
}

// The uploaded source and the jsonID snapshot JSON are temporary; a stored attachment stays with its
// host Unit and an exported Unit is not a file.
function temporaryFileOf(source: ImportSource | ExportSource): string | undefined {
  switch (source.kind) {
    case "upload":
      return source.fileID;
    case "json":
      return source.jsonID;
    default:
      return undefined;
  }
}

function requireID(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalidRequest(`${name} must be a non-empty string`);
  return value;
}

// An absent ID may arrive as undefined, null or "" from the frontend; anything else must be a valid ID.
function optionalID(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireID(value, name);
}

const CONSOLE_LOGGER: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, fields) => console.warn(message, fields ?? {}),
  error: (message, fields) => console.error(message, fields ?? {}),
};
