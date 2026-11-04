import { randomUUID } from "node:crypto";
import type { ExchangeTask, ExportTaskResult, ImportTaskResult } from "./types.js";

// Tasks live only in process memory: a task in a final state is kept for one hour, a running task never
// expires. Records hold no source file, snapshot or export bytes; a failure keeps the original error
// for the Endpoint to map to a protocol code.
export const TERMINAL_TASK_RETENTION_MS = 60 * 60 * 1000;

interface TaskRecord {
  readonly userID: string;
  task: ExchangeTask;
  expiry?: ReturnType<typeof setTimeout>;
}

export class ExchangeTaskStore {
  private readonly _tasks = new Map<string, TaskRecord>();

  constructor(private readonly _retentionMs: number = TERMINAL_TASK_RETENTION_MS) {}

  /** Creates a pending task owned by `userID` and returns its taskID. */
  create(kind: "import" | "export", userID: string): string {
    const taskID = randomUUID();
    this._tasks.set(taskID, { userID, task: { taskID, kind, status: "pending" } });
    return taskID;
  }

  completeImport(taskID: string, result: ImportTaskResult): void {
    this._finish(taskID, { taskID, kind: "import", status: "done", result });
  }

  completeExport(taskID: string, result: ExportTaskResult): void {
    this._finish(taskID, { taskID, kind: "export", status: "done", result });
  }

  fail(taskID: string, error: unknown): void {
    const record = this._tasks.get(taskID);
    if (record) this._finish(taskID, { taskID, kind: record.task.kind, status: "failed", error });
  }

  /** Returns the task only to its creator. */
  get(taskID: string, userID: string): ExchangeTask | undefined {
    const record = this._tasks.get(taskID);
    return record?.userID === userID ? record.task : undefined;
  }

  /** Drops every task and expiry timer. */
  clear(): void {
    for (const record of this._tasks.values()) clearTimeout(record.expiry);
    this._tasks.clear();
  }

  private _finish(taskID: string, task: ExchangeTask): void {
    const record = this._tasks.get(taskID);
    if (!record || record.task.status !== "pending") return;
    record.task = task;
    record.expiry = setTimeout(() => this._tasks.delete(taskID), this._retentionMs);
    record.expiry.unref?.();
  }
}
