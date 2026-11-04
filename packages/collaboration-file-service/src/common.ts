import type { FileRequest } from "./types.js";

/**
 * Per-call application data shared by every stage of one Service call. It is never persisted,
 * never sent to clients and never logged by the SDK.
 * @public
 */
export type FileCustomData = Record<string, unknown>;

/** @public */
export interface Disposable {
  dispose(): void;
}

/**
 * Caller-provided identity for one Service call. Same shape as the collaboration Service
 * `CollabContext`; defined here so File does not depend on the core package.
 * @public
 */
export interface FileCallContext {
  readonly userID: string;
  readonly customData?: FileCustomData;
}

/**
 * The resolved context that middleware and adapters receive: `customData` is always present and
 * `request` describes the current Service call. The same object is shared for the whole call.
 * @public
 */
export interface FileContext<TRequest extends FileRequest = FileRequest> {
  readonly userID: string;
  readonly customData: FileCustomData;
  readonly request: TRequest;
}
