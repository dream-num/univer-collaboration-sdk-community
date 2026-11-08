import { ExchangeFormat } from "@univerjs-pro/exchange-node";
import { UniverType } from "@univerjs/protocol";
import { invalidRequest } from "./errors.js";

// Types and formats of the first version. Board is not in the table and is treated as unsupported.
const IMPORT_FORMATS: ReadonlyMap<UniverType, readonly ExchangeFormat[]> = new Map([
  [UniverType.UNIVER_SHEET, [ExchangeFormat.XLS, ExchangeFormat.XLSX, ExchangeFormat.CSV, ExchangeFormat.TSV]],
  [UniverType.UNIVER_DOC, [ExchangeFormat.DOC, ExchangeFormat.DOCX]],
  [UniverType.UNIVER_SLIDE, [ExchangeFormat.PPT, ExchangeFormat.PPTX]],
  [UniverType.UNIVER_BASE, [ExchangeFormat.XLS, ExchangeFormat.XLSX, ExchangeFormat.CSV, ExchangeFormat.TSV]],
  [UniverType.UNIVER_PDF, [ExchangeFormat.PDF]],
]);

const EXPORT_FORMATS: ReadonlyMap<UniverType, readonly ExchangeFormat[]> = new Map([
  [UniverType.UNIVER_SHEET, [ExchangeFormat.XLSX, ExchangeFormat.CSV, ExchangeFormat.TSV]],
  [UniverType.UNIVER_DOC, [ExchangeFormat.DOCX]],
  [UniverType.UNIVER_SLIDE, [ExchangeFormat.PPTX]],
  [UniverType.UNIVER_BASE, [ExchangeFormat.XLSX, ExchangeFormat.CSV]],
  [UniverType.UNIVER_PDF, [ExchangeFormat.PDF]],
]);

const CONTENT_TYPES: Readonly<Partial<Record<ExchangeFormat, string>>> = {
  [ExchangeFormat.XLSX]: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  [ExchangeFormat.CSV]: "text/csv; charset=utf-8",
  [ExchangeFormat.TSV]: "text/tab-separated-values; charset=utf-8",
  [ExchangeFormat.DOCX]: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  [ExchangeFormat.PPTX]: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  [ExchangeFormat.PDF]: "application/pdf",
};

/** Rejects types outside the first-version table, Board included. */
export function requireSupportedType(type: unknown): UniverType {
  if (typeof type === "number" && IMPORT_FORMATS.has(type)) return type;
  throw invalidRequest(`Unsupported Unit type ${String(type)}`);
}

/** Resolves the import format from the uploaded file name; rejects formats the type does not import. */
export function importFormatOf(type: UniverType, fileName: string): ExchangeFormat {
  const dot = fileName.lastIndexOf(".");
  const extension = dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
  const format = IMPORT_FORMATS.get(type)?.find((candidate) => candidate === extension);
  if (!format) throw invalidRequest(`Cannot import "${fileName}" as Unit type ${type}`);
  return format;
}

/** Validates the requested export format for the type. */
export function exportFormatOf(type: UniverType, format: unknown): ExchangeFormat {
  const resolved = EXPORT_FORMATS.get(type)?.find((candidate) => candidate === format);
  if (!resolved) throw invalidRequest(`Cannot export Unit type ${type} as ${String(format)}`);
  return resolved;
}

/** MIME type of an export result. */
export function exportContentType(format: ExchangeFormat): string {
  return CONTENT_TYPES[format] ?? "application/octet-stream";
}

/** File name of an export result: the Unit name when the snapshot has one, otherwise the unitID. */
export function exportFileName(unitName: string | undefined, unitID: string, format: ExchangeFormat): string {
  const base = unitName?.trim() || unitID;
  return base.toLowerCase().endsWith(`.${format}`) ? base : `${base}.${format}`;
}
