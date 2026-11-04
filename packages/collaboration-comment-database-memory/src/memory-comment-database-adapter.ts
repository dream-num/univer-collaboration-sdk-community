import { randomUUID } from "node:crypto";
import type {
  CommentDatabaseContext,
  CommentRecord,
  CreateCommentDatabaseResult,
  CreateReplyDatabaseInput,
  CreateReplyDatabaseResult,
  CreateRootDatabaseInput,
  DeleteCommentDatabaseInput,
  DeleteCommentDatabaseResult,
  EditCommentDatabaseInput,
  EditCommentDatabaseResult,
  GetCommentDatabaseInput,
  ICommentDatabaseAdapter,
  ListThreadsDatabaseInput,
  SetThreadSolvedDatabaseInput,
  SetThreadSolvedDatabaseResult,
} from "@univerjs-pro/collaboration-comment-service";
import { CommentSolvedStatus } from "@univerjs/protocol";

/**
 * An in-memory `ICommentDatabaseAdapter`. Data is scoped to this instance and lost on process exit.
 *
 * Operations on the same Unit run one at a time, which gives each call the atomicity a database
 * implementation provides with a transaction. Returned records are copies.
 */
export class MemoryCommentDatabaseAdapter implements ICommentDatabaseAdapter {
  private readonly _units = new Map<string, Map<string, CommentRecord>>();
  private readonly _queues = new Map<string, Promise<void>>();
  private readonly _calls = new Set<Promise<unknown>>();
  private _state: "running" | "disposing" | "disposed" = "running";
  private _disposePromise: Promise<void> | undefined;

  createRoot(
    input: CreateRootDatabaseInput,
    _context: CommentDatabaseContext
  ): Promise<CreateCommentDatabaseResult> {
    return this._call(() => this._enqueue(input.unitID, () => {
      const records = this._unit(input.unitID);
      if (records.has(input.threadID)) return { status: "duplicate" };
      const now = Date.now();
      const record: CommentRecord = {
        ...input,
        replyID: input.threadID,
        mentions: [...input.mentions],
        solved: CommentSolvedStatus.OpenOrReOpen,
        createdAt: now,
        updatedAt: now,
        generation: randomUUID(),
      };
      records.set(record.replyID, record);
      return { status: "created", record: cloneRecord(record) };
    }));
  }

  createReply(
    input: CreateReplyDatabaseInput,
    _context: CommentDatabaseContext
  ): Promise<CreateReplyDatabaseResult> {
    return this._call(() => this._enqueue(input.unitID, () => {
      const records = this._unit(input.unitID);
      if (records.has(input.replyID)) return { status: "duplicate" };
      const root = records.get(input.threadID);
      if (!root || root.replyID !== root.threadID) return { status: "not-found" };
      if (root.solved !== CommentSolvedStatus.OpenOrReOpen) return { status: "closed" };
      const now = Date.now();
      const record: CommentRecord = {
        ...input,
        mentions: [...input.mentions],
        solved: root.solved,
        createdAt: now,
        updatedAt: now,
        generation: randomUUID(),
      };
      records.set(record.replyID, record);
      return { status: "created", record: cloneRecord(record) };
    }));
  }

  getComment(
    input: GetCommentDatabaseInput,
    _context: CommentDatabaseContext
  ): Promise<CommentRecord | null> {
    return this._call(() => this._enqueue(input.unitID, () => {
      const record = this._units.get(input.unitID)?.get(input.replyID);
      return record?.threadID === input.threadID ? cloneRecord(record) : null;
    }));
  }

  listThreads(
    input: ListThreadsDatabaseInput,
    _context: CommentDatabaseContext
  ): Promise<readonly CommentRecord[]> {
    return this._call(() => this._enqueue(input.unitID, () => {
      const filter = new Set(input.threadIDs);
      return [...(this._units.get(input.unitID)?.values() ?? [])]
        .filter((record) => filter.size === 0 || filter.has(record.threadID))
        .sort(compareRecords)
        .map(cloneRecord);
    }));
  }

  editComment(
    input: EditCommentDatabaseInput,
    _context: CommentDatabaseContext
  ): Promise<EditCommentDatabaseResult> {
    return this._call(() => this._enqueue(input.unitID, () => {
      const records = this._units.get(input.unitID);
      const target = records?.get(input.replyID);
      const root = records?.get(input.threadID);
      if (!target || target.threadID !== input.threadID || !root) return { status: "not-found" };
      if (root.solved !== CommentSolvedStatus.OpenOrReOpen) return { status: "closed" };
      if (target.authorUserID !== input.expectedAuthorUserID) return { status: "author-mismatch" };
      if (target.content === input.content && equalStrings(target.mentions, input.mentions)) {
        return { status: "unchanged", record: cloneRecord(target) };
      }
      const record: CommentRecord = {
        ...target,
        content: input.content,
        mentions: [...input.mentions],
        updatedAt: Math.max(Date.now(), target.updatedAt + 1),
      };
      records!.set(input.replyID, record);
      return { status: "edited", record: cloneRecord(record) };
    }));
  }

  setThreadSolved(
    input: SetThreadSolvedDatabaseInput,
    _context: CommentDatabaseContext
  ): Promise<SetThreadSolvedDatabaseResult> {
    return this._call(() => this._enqueue(input.unitID, () => {
      const records = this._units.get(input.unitID);
      const root = records?.get(input.threadID);
      if (!root || root.replyID !== root.threadID) return { status: "not-found" };
      if (root.solved === input.solved) return { status: "unchanged" };
      records!.set(input.threadID, {
        ...root,
        solved: input.solved,
        updatedAt: Math.max(Date.now(), root.updatedAt + 1),
      });
      return { status: "updated" };
    }));
  }

  deleteComment(
    input: DeleteCommentDatabaseInput,
    _context: CommentDatabaseContext
  ): Promise<DeleteCommentDatabaseResult> {
    return this._call(() => this._enqueue(input.unitID, () => {
      const records = this._units.get(input.unitID);
      const targetID = input.replyID ?? input.threadID;
      const target = records?.get(targetID);
      if (!target || target.threadID !== input.threadID) return { status: "not-found" };
      if (target.generation !== input.expectedGeneration) return { status: "generation-mismatch" };
      if (input.replyID === undefined) {
        for (const [replyID, record] of records!) {
          if (record.threadID === input.threadID) records!.delete(replyID);
        }
      } else {
        records!.delete(input.replyID);
      }
      if (records!.size === 0) this._units.delete(input.unitID);
      return { status: "deleted" };
    }));
  }

  dispose(): Promise<void> {
    if (this._disposePromise) return this._disposePromise;
    this._state = "disposing";
    this._disposePromise = (async () => {
      await Promise.allSettled([...this._calls]);
      this._queues.clear();
      this._state = "disposed";
    })();
    return this._disposePromise;
  }

  private _unit(unitID: string): Map<string, CommentRecord> {
    const existing = this._units.get(unitID);
    if (existing) return existing;
    const created = new Map<string, CommentRecord>();
    this._units.set(unitID, created);
    return created;
  }

  private _enqueue<T>(unitID: string, work: () => T | Promise<T>): Promise<T> {
    const previous = this._queues.get(unitID) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const tail = result.then(() => undefined, () => undefined);
    this._queues.set(unitID, tail);
    void tail.finally(() => {
      if (this._queues.get(unitID) === tail) this._queues.delete(unitID);
    });
    return result;
  }

  private _call<T>(work: () => Promise<T>): Promise<T> {
    if (this._state !== "running") return Promise.reject(new Error(`Memory Comment Database Adapter is ${this._state}`));
    const call = work();
    this._calls.add(call);
    void call.finally(() => this._calls.delete(call)).catch(() => undefined);
    return call;
  }
}

function cloneRecord(record: CommentRecord): CommentRecord {
  return { ...record, mentions: [...record.mentions] };
}

function compareRecords(left: CommentRecord, right: CommentRecord): number {
  const thread = left.threadID.localeCompare(right.threadID);
  if (thread !== 0) return thread;
  if (left.replyID === left.threadID) return -1;
  if (right.replyID === right.threadID) return 1;
  return left.createdAt - right.createdAt || left.replyID.localeCompare(right.replyID);
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
