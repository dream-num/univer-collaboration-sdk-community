import type { ServerResponse } from "node:http";
import { ExchangeServiceError, type ExchangeServiceErrorCode } from "@univerjs-pro/collaboration-exchange-service";
import { FileError, type FileErrorCode } from "@univerjs-pro/collaboration-file-service";
import { CollabError, type CollabErrorCode } from "@univerjs-pro/collaboration-service";
import { NodeTransportError } from "@univerjs-pro/collaboration-transport-node";
import { ErrorCode, type IError } from "@univerjs/protocol";

export const OK_ERROR: IError = { code: ErrorCode.OK, message: "" };

// Maps any error to a protocol IError. The message is kept as it is; an unrecognized exception,
// including a plain Error thrown by middleware, becomes INTERNAL_ERROR.
export function protocolError(error: unknown): IError {
  return { code: protocolCode(error), message: error instanceof Error ? error.message : String(error) };
}

// All three routes return business errors with HTTP 200 and the code in error.code: the frontend
// HTTPService throws on non-2xx responses, and exchange-client then drops the error code.
export function writeJson(response: ServerResponse, body: object): void {
  if (response.writableEnded || response.destroyed) return;
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

const SERVICE_CODES: Readonly<Record<ExchangeServiceErrorCode, ErrorCode>> = {
  INVALID_REQUEST: ErrorCode.INVALID_ARGUMENT,
  UNAUTHENTICATED: ErrorCode.UNAUTHENTICATED,
  FILE_NOT_FOUND: ErrorCode.NOT_FOUND,
  TASK_NOT_FOUND: ErrorCode.NOT_FOUND,
  SERVICE_DISPOSED: ErrorCode.INTERNAL_ERROR,
};

// Same mapping as the File Endpoint.
const FILE_CODES: Readonly<Record<FileErrorCode, ErrorCode>> = {
  INVALID_REQUEST: ErrorCode.INVALID_ARGUMENT,
  PAYLOAD_TOO_LARGE: ErrorCode.INVALID_ARGUMENT,
  UNAUTHENTICATED: ErrorCode.UNAUTHENTICATED,
  PERMISSION_DENIED: ErrorCode.PERMISSION_DENIED,
  FILE_NOT_FOUND: ErrorCode.NOT_FOUND,
  UPLOAD_TIMEOUT: ErrorCode.INTERNAL_ERROR,
  STORAGE_FAILURE: ErrorCode.INTERNAL_ERROR,
  SERVICE_DISPOSED: ErrorCode.INTERNAL_ERROR,
};

// Same mapping as the collaboration Endpoint uses for CollabError.
const COLLAB_CODES: Readonly<Record<CollabErrorCode, ErrorCode>> = {
  UNAUTHENTICATED: ErrorCode.UNAUTHENTICATED,
  INVALID_REQUEST: ErrorCode.INVALID_ARGUMENT,
  UNIT_NOT_FOUND: ErrorCode.NOT_FOUND,
  PERMISSION_DENIED: ErrorCode.PERMISSION_DENIED,
  OT_CONFLICT: ErrorCode.APPLY_REJECT,
  REVISION_MISMATCH: ErrorCode.CHANGESET_REVISION_CONFILICT,
  ADAPTER_FAILURE: ErrorCode.INTERNAL_ERROR,
  INTERNAL_ERROR: ErrorCode.INTERNAL_ERROR,
  LICENSE_INVALID: ErrorCode.LICENSE_INVALID,
  LICENSE_POLICY_INVALID: ErrorCode.LICENSE_POLICY_INVALID,
  LICENSE_VERSION_NOT_ALLOWED: ErrorCode.LICENSE_VERSION_NOT_ALLOWED,
  LICENSE_UNIT_TYPE_REJECTED: ErrorCode.LICENSE_UNIT_TYPE_REJECTED,
  LICENSE_DOMAIN_REJECTED: ErrorCode.LICENSE_DOMAIN_REJECTED,
};

// ExchangeErrorCode of exchange-node. The nine LICENSE_* codes have protocol ErrorCode values of the same name.
const CONVERSION_INPUT_CODES = new Set(["INVALID_ARGUMENT", "UNSUPPORTED_FORMAT", "INVALID_FILE", "INCOMPLETE_SNAPSHOT"]);

function protocolCode(error: unknown): ErrorCode {
  if (error instanceof ExchangeServiceError) return SERVICE_CODES[error.code];
  if (error instanceof FileError) return FILE_CODES[error.code] ?? ErrorCode.INTERNAL_ERROR;
  if (error instanceof CollabError) return COLLAB_CODES[error.code] ?? ErrorCode.INTERNAL_ERROR;
  if (error instanceof NodeTransportError) {
    return error.code === "TRANSPORT_DISPOSED" ? ErrorCode.INTERNAL_ERROR : ErrorCode.INVALID_ARGUMENT;
  }
  const conversionCode = exchangeNodeCode(error);
  if (conversionCode !== undefined) {
    if (CONVERSION_INPUT_CODES.has(conversionCode)) return ErrorCode.INVALID_ARGUMENT;
    if (conversionCode.startsWith("LICENSE_") && conversionCode in ErrorCode) {
      return ErrorCode[conversionCode as keyof typeof ErrorCode];
    }
  }
  return ErrorCode.INTERNAL_ERROR;
}

// The Endpoint does not depend on exchange-node: its ExchangeError is recognized by name and string
// code, which also holds when the application installs several copies of exchange-node.
function exchangeNodeCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "ExchangeError") return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
