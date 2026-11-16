import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { initializeSchema } from "./schema.js";
import { transaction } from "./transaction.js";
import type {
  CommentDatabaseContext,
  CommentRecord,
  CommentMemberDatabaseContext,
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

interface CommentRow {
  readonly unit_id: string;
  readonly thread_id: string;
  readonly reply_id: string;
  readonly author_user_id: string;
  readonly content: string;
  readonly mentions: string[];
  readonly solved: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly generation: string;
}

/** @public */
export interface PostgresCommentDatabaseAdapterOptions {
  /** Application-owned connection pool. */
  readonly pool: Pool;
}

/** PostgreSQL storage for Thread Comment roots and replies. @public */
export class PostgresCommentDatabaseAdapter implements ICommentDatabaseAdapter {
  private constructor(private readonly _pool: Pool) {}

  /** Creates or validates the Comment schema before returning. */
  static async create({ pool }: PostgresCommentDatabaseAdapterOptions): Promise<PostgresCommentDatabaseAdapter> {
    await initializeSchema(pool);
    return new PostgresCommentDatabaseAdapter(pool);
  }

  async createRoot(input: CreateRootDatabaseInput, _context: CommentMemberDatabaseContext): Promise<CreateCommentDatabaseResult> {
    return this._write(input.unitID, async (client) => {
      if (await getByReply(client, input.unitID, input.threadID)) return { status: "duplicate" };
      const now = Date.now();
      const record = await insert(client, {
        ...input,
        replyID: input.threadID,
        solved: CommentSolvedStatus.OpenOrReOpen,
        createdAt: now,
        updatedAt: now,
        generation: randomUUID(),
      });
      return { status: "created", record };
    });
  }

  async createReply(input: CreateReplyDatabaseInput, _context: CommentMemberDatabaseContext): Promise<CreateReplyDatabaseResult> {
    return this._write(input.unitID, async (client) => {
      if (await getByReply(client, input.unitID, input.replyID)) return { status: "duplicate" };
      const root = await getByReply(client, input.unitID, input.threadID);
      if (!root || root.threadID !== root.replyID) return { status: "not-found" };
      if (root.solved !== CommentSolvedStatus.OpenOrReOpen) return { status: "closed" };
      const now = Date.now();
      const record = await insert(client, {
        ...input,
        solved: root.solved,
        createdAt: now,
        updatedAt: now,
        generation: randomUUID(),
      });
      return { status: "created", record };
    });
  }

  async getComment(input: GetCommentDatabaseInput, _context: CommentMemberDatabaseContext): Promise<CommentRecord | null> {
    const record = await getByReply(this._pool, input.unitID, input.replyID);
    return record?.threadID === input.threadID ? record : null;
  }

  async listThreads(input: ListThreadsDatabaseInput, _context: CommentDatabaseContext): Promise<readonly CommentRecord[]> {
    const { rows } = await this._pool.query<CommentRow>(
      `SELECT * FROM collaboration.comments
       WHERE unit_id = $1 AND ($2::text[] IS NULL OR thread_id = ANY($2))`,
      [input.unitID, input.threadIDs.length ? input.threadIDs : null],
    );
    return rows.map(rowToRecord).sort(compareRecords);
  }

  async editComment(input: EditCommentDatabaseInput, _context: CommentMemberDatabaseContext): Promise<EditCommentDatabaseResult> {
    return this._write(input.unitID, async (client) => {
      const target = await getByReply(client, input.unitID, input.replyID);
      const root = await getByReply(client, input.unitID, input.threadID);
      if (!target || target.threadID !== input.threadID || !root) return { status: "not-found" };
      if (root.solved !== CommentSolvedStatus.OpenOrReOpen) return { status: "closed" };
      if (target.authorUserID !== input.expectedAuthorUserID) return { status: "author-mismatch" };
      if (target.content === input.content && equalStrings(target.mentions, input.mentions)) {
        return { status: "unchanged", record: target };
      }
      const { rows } = await client.query<CommentRow>(
        `UPDATE collaboration.comments SET content = $3, mentions = $4, updated_at = $5
         WHERE unit_id = $1 AND reply_id = $2 RETURNING *`,
        [input.unitID, input.replyID, input.content, input.mentions, Math.max(Date.now(), target.updatedAt + 1)],
      );
      return { status: "edited", record: rowToRecord(rows[0]!) };
    });
  }

  async setThreadSolved(input: SetThreadSolvedDatabaseInput, _context: CommentMemberDatabaseContext): Promise<SetThreadSolvedDatabaseResult> {
    return this._write(input.unitID, async (client) => {
      const root = await getByReply(client, input.unitID, input.threadID);
      if (!root || root.threadID !== root.replyID) return { status: "not-found" };
      if (root.solved === input.solved) return { status: "unchanged" };
      await client.query(
        "UPDATE collaboration.comments SET solved = $3, updated_at = $4 WHERE unit_id = $1 AND reply_id = $2",
        [input.unitID, input.threadID, input.solved, Math.max(Date.now(), root.updatedAt + 1)],
      );
      return { status: "updated" };
    });
  }

  async deleteComment(input: DeleteCommentDatabaseInput, _context: CommentMemberDatabaseContext): Promise<DeleteCommentDatabaseResult> {
    return this._write(input.unitID, async (client) => {
      const targetID = input.replyID ?? input.threadID;
      const target = await getByReply(client, input.unitID, targetID);
      if (!target || target.threadID !== input.threadID) return { status: "not-found" };
      if (target.generation !== input.expectedGeneration) return { status: "generation-mismatch" };
      await client.query(
        `DELETE FROM collaboration.comments WHERE unit_id = $1 AND thread_id = $2
         AND ($3::text IS NULL OR reply_id = $3)`,
        [input.unitID, input.threadID, input.replyID === input.threadID ? null : input.replyID],
      );
      return { status: "deleted" };
    });
  }

  /** The application owns the pool and closes it after use. */
  async dispose(): Promise<void> {}

  private _write<T>(unitID: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return transaction(this._pool, async (client) => {
      // Reply IDs share a Unit-wide namespace across threads, including roots.
      await client.query("SELECT pg_advisory_xact_lock(2, hashtext($1))", [unitID]);
      return work(client);
    });
  }
}

async function getByReply(db: Pool | PoolClient, unitID: string, replyID: string): Promise<CommentRecord | null> {
  const { rows } = await db.query<CommentRow>(
    "SELECT * FROM collaboration.comments WHERE unit_id = $1 AND reply_id = $2", [unitID, replyID],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

async function insert(client: PoolClient, record: CommentRecord): Promise<CommentRecord> {
  const { rows } = await client.query<CommentRow>(
    `INSERT INTO collaboration.comments
     (unit_id, thread_id, reply_id, author_user_id, content, mentions, solved, created_at, updated_at, generation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [record.unitID, record.threadID, record.replyID, record.authorUserID, record.content,
      record.mentions, record.solved, record.createdAt, record.updatedAt, record.generation],
  );
  return rowToRecord(rows[0]!);
}

function rowToRecord(row: CommentRow): CommentRecord {
  if (row.solved !== CommentSolvedStatus.OpenOrReOpen && row.solved !== CommentSolvedStatus.Solved) {
    throw new Error("PostgreSQL Comment contains invalid solved status");
  }
  return {
    unitID: row.unit_id,
    threadID: row.thread_id,
    replyID: row.reply_id,
    authorUserID: row.author_user_id,
    content: row.content,
    mentions: row.mentions,
    solved: row.solved,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
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
