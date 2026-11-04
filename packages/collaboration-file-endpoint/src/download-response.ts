import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileContent, FileRecord } from "@univerjs-pro/collaboration-file-service";

/**
 * Builds the proxy download headers. `filename*` goes first and the plain `filename=` last and
 * unquoted, because exchange-client extracts the name with `/filename=(.+)/`.
 */
export function downloadHeaders(record: FileRecord, cacheMaxAgeSeconds: number): Record<string, string> {
  return {
    "content-type": record.contentType,
    "content-length": String(record.size),
    "content-disposition": contentDisposition(record.name),
    "x-content-type-options": "nosniff",
    "cache-control": `private, max-age=${cacheMaxAgeSeconds}, immutable`,
    etag: `"${record.fileID}"`,
  };
}

export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "-").replace(/["\\;]/g, "-").trim() || "file";
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}; filename=${ascii}`;
}

export async function writeDownload(
  response: ServerResponse,
  record: FileRecord,
  content: FileContent,
  cacheMaxAgeSeconds: number
): Promise<void> {
  response.statusCode = 200;
  for (const [key, value] of Object.entries(downloadHeaders(record, cacheMaxAgeSeconds))) response.setHeader(key, value);
  await pipeline(Readable.from(content), response);
}
