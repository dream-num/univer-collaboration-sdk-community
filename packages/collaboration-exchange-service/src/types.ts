import type { CustomData } from "@univerjs-pro/collaboration-service";
import type { ISheetBlock, ISnapshot, UniverType } from "@univerjs/protocol";

/** Protocol `outputType`: `1` stores the result as a collaborative Unit, `2` returns snapshot JSON. @public */
export type ImportOutputType = 1 | 2;

// ---- Frontend options (field names and values follow exchange-client's request.service.ts) ----

/** @public */
export interface ExchangeImportOptions {
  readonly sheet?: {
    readonly minSheetRowCount?: number;
    readonly minSheetColumnCount?: number;
  };
  readonly base?: {
    readonly xlsx?: {
      readonly baseMode?: "auto" | "tables" | "sheets" | "hybrid";
      readonly baseFormulaPolicy?: "convert-then-values" | "values" | "text" | "fail";
    };
  };
  readonly doc?: {
    readonly docType?: "modern" | "traditional";
  };
}

/** @public */
export interface ExchangeExportOptions {
  /** Only `original` is supported; `online` is rejected. */
  readonly oleAttachmentSource?: "original" | "online";
  readonly sheet?: {
    /** Accepted for compatibility and ignored: URL images always export as a transparent placeholder. */
    readonly useImageUrl?: boolean;
    readonly csv?: { readonly sheetId?: string };
  };
  readonly base?: {
    readonly csv?: { readonly tableId?: string };
    readonly xlsx?: {
      readonly baseExportMode?: "tables" | "ranges";
      readonly baseFormulaPolicy?: "convert-then-values" | "values" | "text" | "fail";
    };
  };
}

// ---- Service inputs and the requests middleware sees ----

/** @public */
export interface ImportInput {
  readonly type: UniverType;
  readonly outputType: ImportOutputType;
  /** An `HttpImport` file uploaded by the caller; its name decides the source format. */
  readonly fileID: string;
  /** Converting a stored attachment to an online Unit is not supported; present → rejected. */
  readonly sourceUnitID?: string;
  readonly options?: ExchangeImportOptions;
}

/** The read-only view of an import that middleware sees. @public */
export interface ImportRequest {
  readonly type: UniverType;
  readonly outputType: ImportOutputType;
  readonly fileID: string;
  readonly options?: ExchangeImportOptions;
}

/** Exactly one of `unitID` and `jsonID` must be set. @public */
export interface ExportInput {
  readonly type: UniverType;
  readonly unitID?: string;
  /** An `HttpImport` upload holding `{ snapshot, sheetBlocks }` JSON. */
  readonly jsonID?: string;
  readonly format: string;
  readonly options?: ExchangeExportOptions;
}

/** The read-only view of an export that middleware sees; carries the one source that was given. @public */
export type ExportRequest =
  | {
      readonly type: UniverType;
      readonly unitID: string;
      readonly format: string;
      readonly options?: ExchangeExportOptions;
    }
  | {
      readonly type: UniverType;
      readonly jsonID: string;
      readonly format: string;
      readonly options?: ExchangeExportOptions;
    };

/** @public */
export type ExchangeRequest = ImportRequest | ExportRequest;

/**
 * The resolved context that middleware receives: `customData` is always present and is the caller's
 * object when one was passed. The same object is shared for the whole request phase.
 * @public
 */
export interface ExchangeContext<TRequest extends ExchangeRequest = ExchangeRequest> {
  readonly userID: string;
  readonly customData: CustomData;
  readonly request: TRequest;
}

/** A decoded snapshot aggregate, shared by reference and read-only by contract. @public */
export interface ExchangeSnapshot {
  readonly snapshot: Readonly<ISnapshot>;
  readonly sheetBlocks: readonly ISheetBlock[];
}

// ---- Tasks ----

/** @public */
export type ImportTaskResult =
  | { readonly outputType: 1; readonly unitID: string }
  | { readonly outputType: 2; readonly jsonID: string };

/** `fileID` is an `HttpExport` file owned by the task's creator. @public */
export interface ExportTaskResult {
  readonly fileID: string;
}

/**
 * A task as its creator sees it. `error` is the original failure (an `ExchangeServiceError`,
 * `FileError`, `CollabError`, exchange-node `ExchangeError` or any other thrown value).
 * @public
 */
export type ExchangeTask =
  | { readonly taskID: string; readonly kind: "import" | "export"; readonly status: "pending" }
  | { readonly taskID: string; readonly kind: "import"; readonly status: "done"; readonly result: ImportTaskResult }
  | { readonly taskID: string; readonly kind: "export"; readonly status: "done"; readonly result: ExportTaskResult }
  | { readonly taskID: string; readonly kind: "import" | "export"; readonly status: "failed"; readonly error: unknown };
