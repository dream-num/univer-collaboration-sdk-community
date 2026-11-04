import {
  BaseExportMode,
  BaseFormulaPolicy,
  BaseImportMode,
  DocxCompatibilityMode,
  ExchangeFormat,
} from "@univerjs-pro/exchange-node";
import { UniverType } from "@univerjs/protocol";
import { invalidRequest } from "./errors.js";

// Frontend options to exchange-node options: pure conversion and validation. fileName, unitId and files
// are filled in when the job runs. Unsupported values, including online OLE versions and a missing CSV
// selector, throw INVALID_REQUEST. The input comes from HTTP JSON and is validated as unknown.

/**
 * exchange-node options without the per-task fields. exchange-node types them as a union keyed by
 * type and format; the jobs cast once at the call, after this module has checked the combination.
 */
export interface ConversionOptions {
  readonly type: UniverType;
  readonly format: ExchangeFormat;
  readonly [option: string]: unknown;
}

const FORMULA_POLICIES: Readonly<Record<string, BaseFormulaPolicy>> = {
  "convert-then-values": BaseFormulaPolicy.CONVERT_THEN_VALUES,
  values: BaseFormulaPolicy.VALUES,
  text: BaseFormulaPolicy.TEXT,
  fail: BaseFormulaPolicy.FAIL,
};
const BASE_IMPORT_MODES = Object.values(BaseImportMode) as readonly string[];
const BASE_EXPORT_MODES = Object.values(BaseExportMode) as readonly string[];
const DOC_TYPES = Object.values(DocxCompatibilityMode) as readonly string[];

export function toImportOptions(type: UniverType, format: ExchangeFormat, options: unknown): ConversionOptions {
  const root = optionalObject(options, "options");
  const result: Record<string, unknown> = { type, format };
  if (type === UniverType.UNIVER_SHEET) {
    const sheet = optionalObject(root?.sheet, "options.sheet");
    assign(result, "minSheetRowCount", optionalCount(sheet?.minSheetRowCount, "options.sheet.minSheetRowCount"));
    assign(result, "minSheetColumnCount", optionalCount(sheet?.minSheetColumnCount, "options.sheet.minSheetColumnCount"));
  } else if (type === UniverType.UNIVER_BASE) {
    const xlsx = optionalObject(optionalObject(root?.base, "options.base")?.xlsx, "options.base.xlsx");
    assign(result, "mode", optionalOneOf(xlsx?.baseMode, BASE_IMPORT_MODES, "options.base.xlsx.baseMode"));
    assign(result, "formulaPolicy", formulaPolicy(xlsx?.baseFormulaPolicy, "options.base.xlsx.baseFormulaPolicy"));
  } else if (type === UniverType.UNIVER_DOC) {
    const doc = optionalObject(root?.doc, "options.doc");
    assign(result, "compatibilityMode", optionalOneOf(doc?.docType, DOC_TYPES, "options.doc.docType"));
  }
  return result as ConversionOptions;
}

export function toExportOptions(type: UniverType, format: ExchangeFormat, options: unknown): ConversionOptions {
  const root = optionalObject(options, "options");
  // The first version only writes the original attachment back.
  const oleSource = root?.oleAttachmentSource;
  if (oleSource !== undefined && oleSource !== "original") {
    throw invalidRequest(`options.oleAttachmentSource ${JSON.stringify(oleSource)} is not supported`);
  }
  const result: Record<string, unknown> = { type, format };
  const csv = format === ExchangeFormat.CSV || format === ExchangeFormat.TSV;
  if (type === UniverType.UNIVER_SHEET && csv) {
    // options.sheet.useImageUrl has no effect: URL images always export as the placeholder.
    const sheet = optionalObject(root?.sheet, "options.sheet");
    const sheetCsv = optionalObject(sheet?.csv, "options.sheet.csv");
    result.csv = { worksheetId: requiredSelector(sheetCsv?.sheetId, "options.sheet.csv.sheetId") };
  } else if (type === UniverType.UNIVER_BASE) {
    const base = optionalObject(root?.base, "options.base");
    if (csv) {
      const baseCsv = optionalObject(base?.csv, "options.base.csv");
      result.csv = { tableId: requiredSelector(baseCsv?.tableId, "options.base.csv.tableId") };
    } else {
      const xlsx = optionalObject(base?.xlsx, "options.base.xlsx");
      assign(result, "mode", optionalOneOf(xlsx?.baseExportMode, BASE_EXPORT_MODES, "options.base.xlsx.baseExportMode"));
      assign(result, "formulaPolicy", formulaPolicy(xlsx?.baseFormulaPolicy, "options.base.xlsx.baseFormulaPolicy"));
    }
  }
  return result as ConversionOptions;
}

/** Whether exchange-node accepts `files` for this import (Sheet, Doc, Slide). */
export function importStoresFiles(type: UniverType): boolean {
  return type === UniverType.UNIVER_SHEET || type === UniverType.UNIVER_DOC || type === UniverType.UNIVER_SLIDE;
}

/** Whether exchange-node accepts `files` for this export (Sheet XLSX, Doc, Slide, PDF). */
export function exportLoadsFiles(type: UniverType, format: ExchangeFormat): boolean {
  if (type === UniverType.UNIVER_SHEET) return format === ExchangeFormat.XLSX;
  return type === UniverType.UNIVER_DOC || type === UniverType.UNIVER_SLIDE || type === UniverType.UNIVER_PDF;
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function optionalObject(value: unknown, name: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw invalidRequest(`${name} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function optionalCount(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidRequest(`${name} must be a non-negative integer`);
  return value as number;
}

function optionalOneOf(value: unknown, allowed: readonly string[], name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalidRequest(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function formulaPolicy(value: unknown, name: string): BaseFormulaPolicy | undefined {
  const key = optionalOneOf(value, Object.keys(FORMULA_POLICIES), name);
  return key === undefined ? undefined : FORMULA_POLICIES[key];
}

// The exchange-node CSV selector is required; a missing one does not default to the first sheet.
function requiredSelector(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalidRequest(`${name} is required for CSV/TSV export`);
  return value;
}
