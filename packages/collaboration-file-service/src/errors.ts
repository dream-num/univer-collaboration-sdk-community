/**
 * Error codes raised by the File Service, Endpoint and adapters.
 * @public
 */
export type FileErrorCode =
  | "INVALID_REQUEST"
  | "FILE_NOT_FOUND"
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "PAYLOAD_TOO_LARGE"
  | "UPLOAD_TIMEOUT"
  | "STORAGE_FAILURE"
  | "SERVICE_DISPOSED";

/**
 * The single error type of the File packages. Branch on `code`; the original error of a wrapped
 * failure is in `cause`.
 * @public
 */
export class FileError extends Error {
  readonly code: FileErrorCode;

  constructor(code: FileErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "FileError";
    this.code = code;
  }
}

export function invalidRequest(message: string): FileError {
  return new FileError("INVALID_REQUEST", message);
}

export function fileNotFound(fileID: string): FileError {
  return new FileError("FILE_NOT_FOUND", `File ${fileID} does not exist`);
}

export function permissionDenied(message: string): FileError {
  return new FileError("PERMISSION_DENIED", message);
}

// Non-FileError exceptions from adapters are wrapped; the original stays in `cause` for diagnosis.
export function storageFailure(stage: string, cause: unknown): FileError {
  if (cause instanceof FileError) return cause;
  return new FileError("STORAGE_FAILURE", `File storage failed during ${stage}`, { cause });
}
