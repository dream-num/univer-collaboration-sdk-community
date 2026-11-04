import type { ServerResponse } from "node:http";
import { FileError } from "@univerjs-pro/collaboration-file-service";
import { NodeTransportError } from "@univerjs-pro/collaboration-transport-node";
import { ErrorCode, type IError } from "@univerjs/protocol";

export const OK_ERROR: IError = { code: ErrorCode.OK, message: "" };

export interface ProtocolFailure {
  readonly status: number;
  readonly error: IError;
}

// Maps a FileError to the HTTP status and protocol ErrorCode; the README lists the table.
export function protocolFailure(error: unknown): ProtocolFailure {
  if (error instanceof NodeTransportError) {
    const status = error.code === "REQUEST_BODY_TOO_LARGE" ? 413
      : error.code === "INVALID_JSON" || error.code === "REQUEST_ABORTED" || error.code === "INVALID_URL" ? 400
      : 503;
    const code = status === 503 ? ErrorCode.INTERNAL_ERROR : ErrorCode.INVALID_ARGUMENT;
    return { status, error: { code, message: error.message } };
  }
  if (!(error instanceof FileError)) {
    return { status: 500, error: { code: ErrorCode.INTERNAL_ERROR, message: "Internal error" } };
  }
  const [status, code] = (() => {
    switch (error.code) {
      case "INVALID_REQUEST": return [400, ErrorCode.INVALID_ARGUMENT] as const;
      case "UNAUTHENTICATED": return [401, ErrorCode.UNAUTHENTICATED] as const;
      case "PERMISSION_DENIED": return [403, ErrorCode.PERMISSION_DENIED] as const;
      case "FILE_NOT_FOUND": return [404, ErrorCode.NOT_FOUND] as const;
      case "UPLOAD_TIMEOUT": return [408, ErrorCode.INTERNAL_ERROR] as const;
      case "PAYLOAD_TOO_LARGE": return [413, ErrorCode.INVALID_ARGUMENT] as const;
      case "STORAGE_FAILURE":
      case "SERVICE_DISPOSED": return [503, ErrorCode.INTERNAL_ERROR] as const;
      default: return [500, ErrorCode.INTERNAL_ERROR] as const;
    }
  })();
  return { status, error: { code, message: error.message } };
}

export function writeJson(response: ServerResponse, status: number, body: object): void {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

// JSON routes (upload, sign-url) answer failures with a protocol error object.
export function writeJsonFailure(response: ServerResponse, error: unknown, empty: object = {}): void {
  const failure = protocolFailure(error);
  writeJson(response, failure.status, { error: failure.error, ...empty });
}

// Proxy downloads are binary responses: a failure returns a status code with plain text, and once
// the body has started the only option is to disconnect.
export function writeDownloadFailure(response: ServerResponse, error: unknown): void {
  if (response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const failure = protocolFailure(error);
  response.statusCode = failure.status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(failure.error.message);
}
