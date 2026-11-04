import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { create as createContentDisposition } from "content-disposition";
import type { FileContent, FileRecord } from "@univerjs-pro/collaboration-file-service";

/** Builds the proxy download headers; `Content-Disposition` follows RFC 6266 and RFC 8187. */
export function downloadHeaders(record: FileRecord, cacheMaxAgeSeconds: number): Record<string, string> {
  return {
    "content-type": record.contentType,
    "content-length": String(record.size),
    "content-disposition": createContentDisposition(record.name),
    "x-content-type-options": "nosniff",
    "cache-control": `private, max-age=${cacheMaxAgeSeconds}, immutable`,
    etag: `"${record.fileID}"`,
  };
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
