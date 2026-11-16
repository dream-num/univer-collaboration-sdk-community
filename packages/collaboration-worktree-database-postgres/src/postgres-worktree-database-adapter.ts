import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { CollabError, type ChangesetMetadata, type ChangesetRecord } from "@univerjs-pro/collaboration-service";
import type {
  AddWorktreeUnitDatabaseInput, AddWorktreeUnitDatabaseResult, CommitWorktreeChangesetInput,
  CommitWorktreeChangesetResult, CreateWorktreeDatabaseInput, CreateWorktreeDatabaseResult,
  CreateWorktreeUnitDatabaseInput, CreateWorktreeUnitDatabaseResult, IWorktreeDatabaseAdapter,
  RecordUnitMergeResultInput, RecordUnitMergeResultResult, SaveWorktreeUnitMergeArtifactInput,
  SaveWorktreeUnitMergeArtifactResult, SetWorktreeUnitRemovedDatabaseInput, SetWorktreeUnitRemovedResult,
  StartMergeResult, WorktreeDatabaseContext, WorktreeRevisionRange, WorktreeStatus, WorktreeTransitionResult,
  WorktreeAggregateRecord, WorktreeUnitMergeArtifact, WorktreeUnitMergeResult, WorktreeUnitRecord, WorktreeUnitSeed,
} from "@univerjs-pro/collaboration-worktree-service";
import type { IChangeset } from "@univerjs/protocol";
import { initializeSchema } from "./schema.js";
import { getAggregate, getArtifact, getSeed, getUnit, insertUnit, pack, requireAggregate, unpack } from "./storage.js";
import { transaction } from "./transaction.js";
import {
  validateCreateInput, validateInitialUnit, validateMergeArtifact, validateMergeResult,
  validateRange, validateUnitIdentity, validateWorktreeCreatedUnit,
} from "./validation.js";

/** @public */
export interface PostgresWorktreeDatabaseAdapterOptions {
  /** Application-owned connection pool. */
  readonly pool: Pool;
}

function isTerminal(result: WorktreeUnitMergeResult | undefined): boolean {
  return result?.status === "removed" || result?.status === "merged" || result?.status === "unchanged";
}

const unfinished = "COALESCE(merge_result->>'status', '') NOT IN ('merged', 'unchanged', 'removed')";

async function updateStatus(client: PoolClient, worktreeID: string, status: WorktreeStatus): Promise<void> {
  await client.query("UPDATE collaboration.worktrees SET status = $2 WHERE worktree_id = $1", [worktreeID, status]);
}

/** PostgreSQL persistence for Worktree lifecycle, draft changesets and merge results. @public */
export class PostgresWorktreeDatabaseAdapter implements IWorktreeDatabaseAdapter {
  private _disposed = false;

  private constructor(private readonly _pool: Pool) {}

  /** Initializes the Worktree schema or checks its existing version. */
  static async create({ pool }: PostgresWorktreeDatabaseAdapterOptions): Promise<PostgresWorktreeDatabaseAdapter> {
    await initializeSchema(pool);
    return new PostgresWorktreeDatabaseAdapter(pool);
  }

  async dispose(): Promise<void> {
    this._disposed = true;
  }

  private _assertOpen(): void {
    if (this._disposed) throw new CollabError("INTERNAL_ERROR", "PostgreSQL Worktree Database Adapter is disposed");
  }

  private _write<T>(
    worktreeID: string,
    operation: (client: PoolClient, status: WorktreeStatus) => Promise<T>,
  ): Promise<T | { status: "not-found" }> {
    this._assertOpen();
    return transaction(this._pool, async client => {
      // Every writer locks the parent first, so status, draft CAS and merge results serialize across pools.
      const { rows } = await client.query<{ status: WorktreeStatus }>(
        "SELECT status FROM collaboration.worktrees WHERE worktree_id = $1 FOR UPDATE", [worktreeID],
      );
      return rows[0] ? operation(client, rows[0].status) : { status: "not-found" };
    });
  }

  async getWorktree(_context: WorktreeDatabaseContext, worktreeID: string): Promise<WorktreeAggregateRecord | null> {
    this._assertOpen();
    return getAggregate(this._pool, worktreeID);
  }

  async getWorktreeUnit(_context: WorktreeDatabaseContext, worktreeID: string, unitID: string): Promise<WorktreeUnitRecord | null> {
    this._assertOpen();
    return getUnit(this._pool, worktreeID, unitID);
  }

  async getUnitSeed(_context: WorktreeDatabaseContext, worktreeID: string, unitID: string): Promise<WorktreeUnitSeed | null> {
    this._assertOpen();
    return getSeed(this._pool, worktreeID, unitID);
  }

  async getUnitMergeArtifact(_context: WorktreeDatabaseContext, worktreeID: string, unitID: string): Promise<WorktreeUnitMergeArtifact | null> {
    this._assertOpen();
    return getArtifact(this._pool, worktreeID, unitID);
  }

  async getDraftChangesets(
    _context: WorktreeDatabaseContext, worktreeID: string, unitID: string, range: WorktreeRevisionRange,
  ): Promise<readonly ChangesetRecord[] | null> {
    this._assertOpen();
    validateRange(range);
    const { rows } = await this._pool.query<{ payload: Buffer | null; metadata: ChangesetMetadata }>(`
      SELECT c.payload, c.metadata FROM collaboration.worktree_units u
      LEFT JOIN collaboration.worktree_changesets c ON c.worktree_id = u.worktree_id AND c.unit_id = u.unit_id
        AND c.revision > $3 AND ($4::bigint IS NULL OR c.revision <= $4)
      WHERE u.worktree_id = $1 AND u.unit_id = $2 ORDER BY c.revision`, [worktreeID, unitID, range.from, range.to]);
    if (rows.length === 0) return null;
    return rows.flatMap(row => row.payload ? [{ ...unpack<IChangeset>(row.payload), metadata: row.metadata }] : []);
  }

  async createWorktree(_context: WorktreeDatabaseContext, input: CreateWorktreeDatabaseInput): Promise<CreateWorktreeDatabaseResult> {
    this._assertOpen();
    validateCreateInput(input);
    const { worktreeID, sid } = input.record;
    return transaction(this._pool, async client => {
      const result = await client.query(`
        INSERT INTO collaboration.worktrees (worktree_id, sid, status) VALUES ($1, $2, 'draft')
        ON CONFLICT (worktree_id) DO NOTHING`, [worktreeID, sid]);
      if (result.rowCount === 0) {
        return { status: "already-exists", aggregate: await requireAggregate(client, worktreeID) };
      }
      for (const unit of input.units) await insertUnit(client, unit);
      return { status: "created", aggregate: await requireAggregate(client, worktreeID) };
    });
  }

  async addUnit(_context: WorktreeDatabaseContext, { unit }: AddWorktreeUnitDatabaseInput): Promise<AddWorktreeUnitDatabaseResult> {
    validateUnitIdentity(unit);
    const id = unit.worktreeID;
    return this._write<AddWorktreeUnitDatabaseResult>(id, async (client, status) => {
      if (await getUnit(client, id, unit.unitID)) {
        return { status: "already-exists", aggregate: await requireAggregate(client, id) };
      }
      if (status !== "draft") {
        return { status: "status-mismatch", aggregate: await requireAggregate(client, id) };
      }
      validateInitialUnit(unit);
      await insertUnit(client, unit);
      return { status: "added", aggregate: await requireAggregate(client, id) };
    });
  }

  async createUnit(_context: WorktreeDatabaseContext, { unit, seed }: CreateWorktreeUnitDatabaseInput): Promise<CreateWorktreeUnitDatabaseResult> {
    validateWorktreeCreatedUnit(unit, seed);
    const id = unit.worktreeID;
    return this._write<CreateWorktreeUnitDatabaseResult>(id, async (client, status) => {
      const existing = await getUnit(client, id, unit.unitID);
      if (existing) {
        const sameSeed = existing.source === "worktree" && existing.type === unit.type &&
          isDeepStrictEqual(await getSeed(client, id, unit.unitID), unpack(pack(seed)));
        return { status: sameSeed ? "already-created" : "unit-exists", aggregate: await requireAggregate(client, id) };
      }
      if (status !== "draft") {
        return { status: "status-mismatch", aggregate: await requireAggregate(client, id) };
      }
      await insertUnit(client, unit, pack(seed));
      return { status: "created", aggregate: await requireAggregate(client, id) };
    });
  }

  async setUnitRemoved(
    _context: WorktreeDatabaseContext, { worktreeID, unitID, removed }: SetWorktreeUnitRemovedDatabaseInput,
  ): Promise<SetWorktreeUnitRemovedResult> {
    return this._write<SetWorktreeUnitRemovedResult>(worktreeID, async (client, status) => {
      const unit = await getUnit(client, worktreeID, unitID);
      if (!unit) return { status: "not-found" };
      if (status !== "draft" || isTerminal(unit.mergeResult)) {
        return { status: "not-editable", aggregate: await requireAggregate(client, worktreeID) };
      }
      if (Boolean(unit.removed) === removed) {
        return { status: "unchanged", aggregate: await requireAggregate(client, worktreeID) };
      }
      await client.query(
        "UPDATE collaboration.worktree_units SET removed = $3 WHERE worktree_id = $1 AND unit_id = $2",
        [worktreeID, unitID, removed],
      );
      return { status: "updated", aggregate: await requireAggregate(client, worktreeID) };
    });
  }

  async commitDraftChangeset(
    _context: WorktreeDatabaseContext, { worktreeID, changeset, unitMetadata }: CommitWorktreeChangesetInput,
  ): Promise<CommitWorktreeChangesetResult> {
    return this._write<CommitWorktreeChangesetResult>(worktreeID, async (client, status) => {
      const unit = await getUnit(client, worktreeID, changeset.unitID);
      if (!unit) return { status: "not-found" };
      if (status !== "draft") return { status: "not-editable", worktreeStatus: status };
      if (unit.removed || isTerminal(unit.mergeResult)) return { status: "unit-frozen" };
      const head = changeset.revision - 1;
      if (unit.draftHeadRevision !== head) return { status: "revision-mismatch", actualHeadRevision: unit.draftHeadRevision };

      const now = Date.now();
      const { metadata, ...protocol } = changeset;
      const payload = pack({ ...protocol, createTime: Math.floor(now / 1000) });
      const update = await client.query(`
        UPDATE collaboration.worktree_units SET draft_head_revision = $4, metadata = $5
        WHERE worktree_id = $1 AND unit_id = $2 AND draft_head_revision = $3`,
        [worktreeID, unit.unitID, head, changeset.revision, JSON.stringify(unitMetadata)]);
      if (update.rowCount !== 1) throw new Error("Draft head changed while the Worktree was locked");
      const { rows } = await client.query<{ metadata: ChangesetMetadata }>(`
        INSERT INTO collaboration.worktree_changesets
          (worktree_id, unit_id, revision, base_revision, sid, req_id, created_at_ms, payload, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING metadata`,
        [worktreeID, unit.unitID, changeset.revision, changeset.baseRev, changeset.sid, changeset.reqId, now, payload, JSON.stringify(metadata)]);
      return {
        status: "committed",
        headRevision: changeset.revision,
        changeset: { ...unpack<IChangeset>(payload), metadata: rows[0]!.metadata },
      };
    });
  }

  async markReady(_context: WorktreeDatabaseContext, id: string): Promise<WorktreeTransitionResult> {
    return this._transition(id, "ready", ["draft"], async client => {
      await client.query(`UPDATE collaboration.worktree_units SET ready_draft_head_revision = draft_head_revision, merge_artifact = NULL
        WHERE worktree_id = $1 AND ${unfinished}`, [id]);
    });
  }

  async reopenWorktree(_context: WorktreeDatabaseContext, id: string): Promise<WorktreeTransitionResult> {
    return this._transition(id, "draft", ["ready"], async client => {
      await client.query(`UPDATE collaboration.worktree_units SET ready_draft_head_revision = NULL, merge_result = NULL, merge_artifact = NULL
        WHERE worktree_id = $1 AND ${unfinished}`, [id]);
    });
  }

  async discardWorktree(_context: WorktreeDatabaseContext, id: string): Promise<WorktreeTransitionResult> {
    return this._transition(id, "discarded", ["draft", "ready"]);
  }

  private _transition(
    id: string, target: WorktreeStatus, from: readonly WorktreeStatus[], updateUnits?: (client: PoolClient) => Promise<void>,
  ): Promise<WorktreeTransitionResult> {
    return this._write<WorktreeTransitionResult>(id, async (client, status) => {
      if (status === target) {
        return { status: "already-in-target", aggregate: await requireAggregate(client, id) };
      }
      if (!from.includes(status)) {
        return { status: "status-mismatch", aggregate: await requireAggregate(client, id) };
      }
      await updateUnits?.(client);
      await updateStatus(client, id, target);
      return { status: "transitioned", previousStatus: status, aggregate: await requireAggregate(client, id) };
    });
  }

  async startOrResumeMerge(_context: WorktreeDatabaseContext, id: string): Promise<StartMergeResult> {
    return this._write<StartMergeResult>(id, async (client, status) => {
      if (status === "merged") {
        return { status: "already-merged", aggregate: await requireAggregate(client, id) };
      }
      if (status === "merging") {
        return { status: "resumed", aggregate: await requireAggregate(client, id) };
      }
      if (status !== "ready") {
        return { status: "status-mismatch", aggregate: await requireAggregate(client, id) };
      }
      await updateStatus(client, id, "merging");
      return { status: "started", aggregate: await requireAggregate(client, id) };
    });
  }

  async saveUnitMergeArtifact(
    _context: WorktreeDatabaseContext, { worktreeID, unitID, artifact }: SaveWorktreeUnitMergeArtifactInput,
  ): Promise<SaveWorktreeUnitMergeArtifactResult> {
    return this._write<SaveWorktreeUnitMergeArtifactResult>(worktreeID, async (client, status) => {
      const unit = await getUnit(client, worktreeID, unitID);
      if (!unit) return { status: "not-found" };
      if (status !== "merging" || unit.source !== "worktree" || isTerminal(unit.mergeResult) ||
          unit.readyDraftHeadRevision !== artifact.readyDraftHeadRevision) {
        return { status: "stale-merge" };
      }
      const existing = await getArtifact(client, worktreeID, unitID);
      if (existing) return { status: "already-saved", artifact: existing };
      validateMergeArtifact(unit, artifact);
      const payload = pack(artifact);
      await client.query(
        "UPDATE collaboration.worktree_units SET merge_artifact = $3 WHERE worktree_id = $1 AND unit_id = $2",
        [worktreeID, unitID, payload],
      );
      return { status: "saved", artifact: unpack(payload) };
    });
  }

  async recordUnitMergeResult(
    _context: WorktreeDatabaseContext, { worktreeID, unitID, readyDraftHeadRevision, mergeResult }: RecordUnitMergeResultInput,
  ): Promise<RecordUnitMergeResultResult> {
    validateMergeResult(mergeResult);
    return this._write<RecordUnitMergeResultResult>(worktreeID, async (client, status) => {
      const unit = await getUnit(client, worktreeID, unitID);
      if (!unit) return { status: "not-found" };
      if (status !== "merging" || unit.readyDraftHeadRevision !== readyDraftHeadRevision) return { status: "stale-merge" };
      if (isTerminal(mergeResult) && Boolean(unit.removed) !== (mergeResult.status === "removed")) {
        throw new CollabError("INVALID_REQUEST", "Merge result does not match frozen Unit removal intent");
      }
      if (isDeepStrictEqual(unit.mergeResult, mergeResult)) {
        return { status: "already-recorded", aggregate: await requireAggregate(client, worktreeID) };
      }
      if (isTerminal(unit.mergeResult)) return { status: "stale-merge" };
      await client.query(
        "UPDATE collaboration.worktree_units SET merge_result = $3 WHERE worktree_id = $1 AND unit_id = $2",
        [worktreeID, unitID, JSON.stringify(mergeResult)],
      );
      return { status: "recorded", aggregate: await requireAggregate(client, worktreeID) };
    });
  }

  async finishMerge(_context: WorktreeDatabaseContext, id: string): Promise<WorktreeTransitionResult> {
    return this._write<WorktreeTransitionResult>(id, async (client, status) => {
      if (status === "merged") {
        return { status: "already-in-target", aggregate: await requireAggregate(client, id) };
      }
      if (status !== "merging") {
        return { status: "status-mismatch", aggregate: await requireAggregate(client, id) };
      }
      const pending = await client.query(`SELECT 1 FROM collaboration.worktree_units WHERE worktree_id = $1 AND ${unfinished} LIMIT 1`, [id]);
      await updateStatus(client, id, pending.rows.length ? "ready" : "merged");
      return { status: "transitioned", previousStatus: status, aggregate: await requireAggregate(client, id) };
    });
  }
}
