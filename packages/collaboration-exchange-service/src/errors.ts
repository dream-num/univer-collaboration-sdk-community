/**
 * Error codes the Exchange Service raises itself. Failures from File, the collaboration Service and
 * exchange-node keep their own error types.
 * @public
 */
export type ExchangeServiceErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "FILE_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "SERVICE_DISPOSED";

/** @public */
export class ExchangeServiceError extends Error {
  readonly code: ExchangeServiceErrorCode;

  constructor(code: ExchangeServiceErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "ExchangeServiceError";
    this.code = code;
  }
}

export function invalidRequest(message: string): ExchangeServiceError {
  return new ExchangeServiceError("INVALID_REQUEST", message);
}

// A missing file and a file owned by someone else return the same error, so existence is not exposed.
export function fileNotFound(fileID: string): ExchangeServiceError {
  return new ExchangeServiceError("FILE_NOT_FOUND", `File ${fileID} does not exist`);
}

// A missing task and a task owned by someone else return the same error.
export function taskNotFound(taskID: string): ExchangeServiceError {
  return new ExchangeServiceError("TASK_NOT_FOUND", `Task ${taskID} does not exist`);
}
