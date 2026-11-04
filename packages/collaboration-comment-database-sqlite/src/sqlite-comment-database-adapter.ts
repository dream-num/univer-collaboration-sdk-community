import { randomUUID } from "node:crypto";
import Database from "libsql";
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

const SCHEMA_COMPONENT = "comment";
const SCHEMA_VERSION = 1;

interface CommentRow {
  readonly unit_id: string;
  readonly thread_id: string;
  readonly reply_id: string;
  readonly author_user_id: string;
  readonly content: string;
  readonly mentions_json: string;
  readonly solved: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly generation: string;
}

export interface SQLiteCommentDatabaseAdapterOptions {
  /** SQLite filename or `:memory:`. The parent directory must already exist. */
  readonly filename: string;
  /** How long SQLite waits for another writer before reporting SQLITE_BUSY. Defaults to 5000. */
  readonly busyTimeoutMs?: number;
}

/**
 * SQLite implementation of the Thread Comment persistence contract, built on the synchronous
 * `libsql` API. It can share a database file with the other Univer collaboration SQLite adapters.
 *
 * The constructor initializes an empty database and rejects a database whose comment schema
 * version differs from the one this adapter writes.
 */
export class SQLiteCommentDatabaseAdapter implements ICommentDatabaseAdapter {
  private readonly _database: Database.Database;
  private _disposed = false;

  constructor(options: SQLiteCommentDatabaseAdapterOptions) {
    if (!options.filename) {
      throw new TypeError("SQLiteCommentDatabaseAdapter requires a filename");
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    this._database = new Database(options.filename, { timeout: busyTimeoutMs });
    try {
      this._database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
      this._initializeSchema();
    } catch (error) {
      this._database.close();
      throw error;
    }
  }

  async createRoot(input: CreateRootDatabaseInput, _context: CommentDatabaseContext): Promise<CreateCommentDatabaseResult> {
    this._assertOpen();
    return this._transaction(() => {
      if (this._getByReply(input.unitID, input.threadID)) return { status: "duplicate" };
      const now = Date.now();
      this._insert({
        ...input,
        replyID: input.threadID,
        solved: CommentSolvedStatus.OpenOrReOpen,
        createdAt: now,
        updatedAt: now,
        generation: randomUUID(),
      });
      return { status: "created", record: this._require(input.unitID, input.threadID) };
    });
  }

  async createReply(input: CreateReplyDatabaseInput, _context: CommentDatabaseContext): Promise<CreateReplyDatabaseResult> {
    this._assertOpen();
    return this._transaction(() => {
      if (this._getByReply(input.unitID, input.replyID)) return { status: "duplicate" };
      const root = this._getByReply(input.unitID, input.threadID);
      if (!root || root.threadID !== root.replyID) return { status: "not-found" };
      if (root.solved !== CommentSolvedStatus.OpenOrReOpen) return { status: "closed" };
      const now = Date.now();
      this._insert({
        ...input,
        solved: root.solved,
        createdAt: now,
        updatedAt: now,
        generation: randomUUID(),
      });
      return { status: "created", record: this._require(input.unitID, input.replyID) };
    });
  }

  async getComment(input: GetCommentDatabaseInput, _context: CommentDatabaseContext): Promise<CommentRecord | null> {
    this._assertOpen();
    const record = this._getByReply(input.unitID, input.replyID);
    return record?.threadID === input.threadID ? record : null;
  }

  async listThreads(input: ListThreadsDatabaseInput, _context: CommentDatabaseContext): Promise<readonly CommentRecord[]> {
    this._assertOpen();
    const ids = [...new Set(input.threadIDs)];
    const rows = ids.length === 0
      ? this._database.prepare(`${SELECT_COLUMNS} WHERE unit_id = ?`).all(input.unitID)
      : this._database
          .prepare(`${SELECT_COLUMNS} WHERE unit_id = ? AND thread_id IN (${ids.map(() => "?").join(",")})`)
          .all(input.unitID, ...ids);
    return (rows as unknown as CommentRow[]).map(rowToRecord).sort(compareRecords);
  }

  async editComment(input: EditCommentDatabaseInput, _context: CommentDatabaseContext): Promise<EditCommentDatabaseResult> {
    this._assertOpen();
    return this._transaction(() => {
      const target = this._getByReply(input.unitID, input.replyID);
      const root = this._getByReply(input.unitID, input.threadID);
      if (!target || target.threadID !== input.threadID || !root) return { status: "not-found" };
      if (root.solved !== CommentSolvedStatus.OpenOrReOpen) return { status: "closed" };
      if (target.authorUserID !== input.expectedAuthorUserID) return { status: "author-mismatch" };
      if (target.content === input.content && equalStrings(target.mentions, input.mentions)) {
        return { status: "unchanged", record: target };
      }
      this._database
        .prepare(
          `UPDATE collaboration_comments
           SET content = ?, mentions_json = ?, updated_at = ?
           WHERE unit_id = ? AND thread_id = ? AND reply_id = ?`,
        )
        .run(
          input.content,
          JSON.stringify(input.mentions),
          Math.max(Date.now(), target.updatedAt + 1),
          input.unitID,
          input.threadID,
          input.replyID,
        );
      return { status: "edited", record: this._require(input.unitID, input.replyID) };
    });
  }

  async setThreadSolved(input: SetThreadSolvedDatabaseInput, _context: CommentDatabaseContext): Promise<SetThreadSolvedDatabaseResult> {
    this._assertOpen();
    return this._transaction(() => {
      const root = this._getByReply(input.unitID, input.threadID);
      if (!root || root.threadID !== root.replyID) return { status: "not-found" };
      if (root.solved === input.solved) return { status: "unchanged" };
      this._database
        .prepare("UPDATE collaboration_comments SET solved = ?, updated_at = ? WHERE unit_id = ? AND reply_id = ?")
        .run(input.solved, Math.max(Date.now(), root.updatedAt + 1), input.unitID, input.threadID);
      return { status: "updated" };
    });
  }

  async deleteComment(input: DeleteCommentDatabaseInput, _context: CommentDatabaseContext): Promise<DeleteCommentDatabaseResult> {
    this._assertOpen();
    return this._transaction(() => {
      const targetID = input.replyID ?? input.threadID;
      const target = this._getByReply(input.unitID, targetID);
      if (!target || target.threadID !== input.threadID) return { status: "not-found" };
      if (target.generation !== input.expectedGeneration) return { status: "generation-mismatch" };
      if (input.replyID === undefined) {
        this._database
          .prepare("DELETE FROM collaboration_comments WHERE unit_id = ? AND thread_id = ?")
          .run(input.unitID, input.threadID);
      } else {
        this._database
          .prepare("DELETE FROM collaboration_comments WHERE unit_id = ? AND thread_id = ? AND reply_id = ?")
          .run(input.unitID, input.threadID, input.replyID);
      }
      return { status: "deleted" };
    });
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._database.close();
  }

  private _initializeSchema(): void {
    this._transaction(() => {
      this._database.exec(`
        CREATE TABLE IF NOT EXISTS collaboration_schema_versions (
          component TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version >= 1)
        );
      `);
      const version = this._readSchemaVersion();
      if (version === SCHEMA_VERSION) return;
      if (version !== undefined) {
        throw new Error(
          `Comment schema version ${version} is not supported by this adapter (expected ${SCHEMA_VERSION})`,
        );
      }
      this._createSchema();
    });
  }

  private _readSchemaVersion(): number | undefined {
    const row = this._database
      .prepare("SELECT version FROM collaboration_schema_versions WHERE component = ?")
      .get(SCHEMA_COMPONENT) as { version: number } | undefined;
    return row?.version;
  }

  private _createSchema(): void {
    this._database.exec(`
      CREATE TABLE collaboration_comments (
        unit_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        reply_id TEXT NOT NULL,
        author_user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        mentions_json TEXT NOT NULL,
        solved INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        generation TEXT NOT NULL,
        PRIMARY KEY (unit_id, reply_id)
      );
      CREATE INDEX collaboration_comments_thread_lookup
        ON collaboration_comments(unit_id, thread_id, created_at, reply_id);
      INSERT INTO collaboration_schema_versions (component, version)
      VALUES ('${SCHEMA_COMPONENT}', ${SCHEMA_VERSION});
    `);
  }

  private _insert(record: CommentRecord): void {
    this._database
      .prepare(
        `INSERT INTO collaboration_comments
         (unit_id, thread_id, reply_id, author_user_id, content, mentions_json,
          solved, created_at, updated_at, generation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.unitID,
        record.threadID,
        record.replyID,
        record.authorUserID,
        record.content,
        JSON.stringify(record.mentions),
        record.solved,
        record.createdAt,
        record.updatedAt,
        record.generation,
      );
  }

  private _getByReply(unitID: string, replyID: string): CommentRecord | null {
    const row = this._database
      .prepare(`${SELECT_COLUMNS} WHERE unit_id = ? AND reply_id = ?`)
      .get(unitID, replyID) as CommentRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  private _require(unitID: string, replyID: string): CommentRecord {
    const record = this._getByReply(unitID, replyID);
    if (!record) throw new Error("SQLite Comment write did not persist its record");
    return record;
  }

  // The check and the write of every operation share one immediate transaction.
  private _transaction<T>(work: () => T): T {
    this._database.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this._database.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this._database.exec("ROLLBACK;");
      } catch {
        // The original error is the one worth reporting.
      }
      throw error;
    }
  }

  private _assertOpen(): void {
    if (this._disposed) throw new Error("SQLite Comment Database Adapter is disposed");
  }
}

const SELECT_COLUMNS = `SELECT unit_id, thread_id, reply_id, author_user_id,
  content, mentions_json, solved, created_at, updated_at, generation
  FROM collaboration_comments`;

function rowToRecord(row: CommentRow): CommentRecord {
  const mentions = JSON.parse(row.mentions_json) as unknown;
  if (!Array.isArray(mentions) || mentions.some((mention) => typeof mention !== "string")) {
    throw new Error("SQLite Comment contains invalid mentions");
  }
  if (row.solved !== CommentSolvedStatus.OpenOrReOpen && row.solved !== CommentSolvedStatus.Solved) {
    throw new Error("SQLite Comment contains invalid solved status");
  }
  return {
    unitID: row.unit_id,
    threadID: row.thread_id,
    replyID: row.reply_id,
    authorUserID: row.author_user_id,
    content: row.content,
    mentions,
    solved: row.solved,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    generation: row.generation,
  };
}

// Roots come first within a thread; replies follow in creation order.
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
