import { Buffer } from "node:buffer";
import type { ISnapshotWithBlocks } from "@univerjs-pro/collaboration-service";
import type { ISheetBlock, ISnapshot } from "@univerjs/protocol";
import { invalidRequest } from "./errors.js";

// Snapshot JSON encoding: `{ snapshot, sheetBlocks }`. Binary fields of ISnapshot (the originalMeta of the
// five meta kinds, each worksheet's originalMeta and each sheet block's data) are base64 strings, and
// sheetBlocks is an object keyed by block id. The format is defined by exchange-client's
// `utils/snapshot.ts`; uploads and import results share it, and this file implements it from the protocol.

type JsonRecord = Readonly<Record<string, unknown>>;

const META_FIELDS = ["workbook", "doc", "slide", "board", "pdf"] as const;

/** Decodes an uploaded snapshot JSON (already inflated by File). Malformed input → INVALID_REQUEST. */
export function decodeSnapshotJson(bytes: Uint8Array): ISnapshotWithBlocks {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
  } catch {
    throw invalidRequest("Snapshot JSON is not valid JSON");
  }
  const root = requireRecord(parsed, "snapshot JSON");
  const input = requireRecord(root.snapshot, "snapshot");
  if (typeof input.unitID !== "string" || input.unitID.length === 0) throw invalidRequest("snapshot.unitID is required");
  if (!Number.isSafeInteger(input.type)) throw invalidRequest("snapshot.type must be an integer");
  if (!Number.isSafeInteger(input.rev)) throw invalidRequest("snapshot.rev must be an integer");
  const snapshot: Record<string, unknown> = { ...input };
  for (const field of META_FIELDS) snapshot[field] = decodeMeta(input[field], `snapshot.${field}`);
  return { snapshot: snapshot as unknown as ISnapshot, sheetBlocks: decodeBlocks(root.sheetBlocks) };
}

/** Encodes an import result for `outputType=2`. */
export function encodeSnapshotJson(value: ISnapshotWithBlocks): Uint8Array {
  const snapshot: Record<string, unknown> = { ...value.snapshot };
  for (const field of META_FIELDS) {
    const meta = value.snapshot[field];
    if (meta) snapshot[field] = encodeMeta(meta as unknown as JsonRecord);
  }
  const sheetBlocks = Object.fromEntries(value.sheetBlocks.map((block) => [block.id, { ...block, data: base64(block.data) }]));
  return Buffer.from(JSON.stringify({ snapshot, sheetBlocks }), "utf8");
}

// The frontend writes doc as `{}` when encoding a Sheet snapshot, so an empty object means the same
// as a missing meta.
function decodeMeta(value: unknown, name: string): unknown {
  if (value === undefined || value === null) return undefined;
  const meta = requireRecord(value, name);
  if (Object.keys(meta).length === 0) return undefined;
  const decoded: Record<string, unknown> = { ...meta, originalMeta: decodeBase64(meta.originalMeta, `${name}.originalMeta`) };
  if (meta.sheets !== undefined) {
    const sheets = requireRecord(meta.sheets, `${name}.sheets`);
    decoded.sheets = Object.fromEntries(
      Object.entries(sheets).map(([sheetID, sheet]) => {
        const sheetMeta = requireRecord(sheet, `${name}.sheets.${sheetID}`);
        const originalMeta = decodeBase64(sheetMeta.originalMeta, `${name}.sheets.${sheetID}.originalMeta`);
        return [sheetID, { ...sheetMeta, originalMeta }];
      })
    );
  }
  return decoded;
}

function encodeMeta(meta: JsonRecord): JsonRecord {
  const encoded: Record<string, unknown> = { ...meta, originalMeta: base64(meta.originalMeta as Uint8Array) };
  if (meta.sheets) {
    encoded.sheets = Object.fromEntries(
      Object.entries(meta.sheets as Record<string, JsonRecord>).map(([sheetID, sheet]) => [
        sheetID,
        { ...sheet, originalMeta: base64(sheet.originalMeta as Uint8Array) },
      ])
    );
  }
  return encoded;
}

function decodeBlocks(value: unknown): ISheetBlock[] {
  if (value === undefined || value === null) return [];
  return Object.entries(requireRecord(value, "sheetBlocks")).map(([key, entry]) => {
    const block = requireRecord(entry, `sheetBlocks.${key}`);
    if (typeof block.id !== "string" || block.id.length === 0) throw invalidRequest(`sheetBlocks.${key}.id is required`);
    return { ...block, data: decodeBase64(block.data, `sheetBlocks.${key}.data`) } as unknown as ISheetBlock;
  });
}

function requireRecord(value: unknown, name: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidRequest(`${name} must be an object`);
  return value as JsonRecord;
}

function decodeBase64(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string") throw invalidRequest(`${name} must be a base64 string`);
  return new Uint8Array(Buffer.from(value, "base64"));
}

function base64(bytes: Uint8Array | undefined): string {
  if (!bytes) return "";
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
