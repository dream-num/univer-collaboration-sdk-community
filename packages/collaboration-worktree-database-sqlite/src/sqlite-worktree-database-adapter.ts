import { isDeepStrictEqual } from "node:util";
import Database from "libsql";
import {
  CollabError,
  type DatabaseContext,
  type ChangesetMetadata,
  type ChangesetRecord,
  type UnitMetadata,
} from "@univerjs-pro/collaboration-service";
import type {
  SetWorktreeUnitRemovedDatabaseInput,
  SetWorktreeUnitRemovedResult,
  AddWorktreeUnitDatabaseInput,
  AddWorktreeUnitDatabaseResult,
  CommitWorktreeChangesetInput,
  CommitWorktreeChangesetResult,
  CreateWorktreeDatabaseInput,
  CreateWorktreeDatabaseResult,
  CreateWorktreeUnitDatabaseInput,
  CreateWorktreeUnitDatabaseResult,
  IWorktreeDatabaseAdapter,
  RecordUnitMergeResultInput,
  RecordUnitMergeResultResult,
  SaveWorktreeUnitMergeArtifactInput,
  SaveWorktreeUnitMergeArtifactResult,
  StartMergeResult,
  WorktreeAggregateRecord,
  WorktreeRevisionRange,
  WorktreeTransitionResult,
  WorktreeUnitMergeResult,
  WorktreeUnitMergeArtifact,
  WorktreeUnitRecord,
  WorktreeUnitSeed,
} from "@univerjs-pro/collaboration-worktree-service";
import type { IChangeset, UniverType } from "@univerjs/protocol";

import { SCHEMA_COMPONENT, SCHEMA_VERSION, SCHEMA_VERSIONS_SQL, WORKTREE_SCHEMA_SQL } from "./schema.js";

const TABLE_NAMES = [
  "collaboration_worktrees",
  "collaboration_worktree_units",
  "collaboration_worktree_changesets",
  "collaboration_worktree_unit_seeds",
  "collaboration_worktree_unit_merge_artifacts",
] as const;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const BINARY_TAG = "__univerCollaborationBinary";

interface WorktreeRow {
  readonly worktree_id: string;
  readonly sid: string;
  readonly status: string;
}

interface WorktreeUnitRow {
  readonly worktree_id: string;
  readonly unit_id: string;
  readonly type: number;
  readonly source: string;
  readonly baseline_trunk_revision: number;
  readonly draft_head_revision: number;
  readonly ready_draft_head_revision: number | null;
  readonly creator_id: string;
  readonly created_at_ms: number;
  readonly metadata_json: string;
  readonly removed: number;
  readonly merge_result_json: string | null;
}

interface ChangesetRow {
  readonly payload_json: string;
  readonly metadata_json: string;
}

interface SeedRow {
  readonly snapshot_json: string;
  readonly sheet_blocks_json: string | null;
}

interface MergeArtifactRow extends SeedRow {
  readonly ready_draft_head_revision: number;
}

interface SchemaVersionRow {
  readonly version: number;
}

export interface SQLiteWorktreeDatabaseAdapterOptions {
  /** SQLite filename or `:memory:`. The parent directory must already exist. */
  readonly filename: string;
  /** How long SQLite waits for another writer before reporting SQLITE_BUSY. */
  readonly busyTimeoutMs?: number;
}

/**
 * Implements Worktree state transitions, Draft CAS and the atomic merge result contract with
 * SQLite write transactions.
 * @public
 */
export class SQLiteWorktreeDatabaseAdapter
  implements IWorktreeDatabaseAdapter
{
  private readonly _database: Database.Database;
  private _disposed = false;

  constructor(options: SQLiteWorktreeDatabaseAdapterOptions) {
    validateOptions(options);
    this._database = new Database(options.filename, {
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      this._database.exec("PRAGMA foreign_keys = ON;");
      this._database.exec(
        `PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS};`
      );
      this._initializeSchema();
    } catch (error) {
      this._database.close();
      throw error;
    }
  }

  async getWorktree(
    _context: DatabaseContext,
    worktreeID: string
  ): Promise<WorktreeAggregateRecord | null> {
    this._assertOpen();
    return this._getAggregate(worktreeID);
  }

  async getWorktreeUnit(
    _context: DatabaseContext,
    worktreeID: string,
    unitID: string
  ): Promise<WorktreeUnitRecord | null> {
    this._assertOpen();
    const row = this._getUnitRow(worktreeID, unitID);
    return row ? rowToUnitRecord(row) : null;
  }

  async getDraftChangesets(
    _context: DatabaseContext,
    worktreeID: string,
    unitID: string,
    range: WorktreeRevisionRange
  ): Promise<readonly ChangesetRecord[] | null> {
    this._assertOpen();
    validateRange(range);
    const rows = this._database
      .prepare(
        `SELECT changesets.payload_json, changesets.metadata_json
         FROM collaboration_worktree_units AS units
         LEFT JOIN collaboration_worktree_changesets AS changesets
           ON changesets.worktree_id = units.worktree_id
          AND changesets.unit_id = units.unit_id
          AND changesets.revision > ?
          ${range.to === undefined ? "" : "AND changesets.revision <= ?"}
         WHERE units.worktree_id = ? AND units.unit_id = ?
         ORDER BY changesets.revision ASC`
      )
      .all(range.from, ...(range.to === undefined ? [] : [range.to]), worktreeID, unitID) as unknown as Array<ChangesetRow | { payload_json: null; metadata_json: null }>;
    if (rows.length === 0) return null;
    return rows.flatMap((row) =>
      row.payload_json === null ? [] : [decodeChangeset(row.payload_json, row.metadata_json)]
    );
  }

  async getUnitSeed(
    _context: DatabaseContext,
    worktreeID: string,
    unitID: string
  ): Promise<WorktreeUnitSeed | null> {
    this._assertOpen();
    return this._getUnitSeed(worktreeID, unitID);
  }

  async getUnitMergeArtifact(
    _context: DatabaseContext,
    worktreeID: string,
    unitID: string
  ): Promise<WorktreeUnitMergeArtifact | null> {
    this._assertOpen();
    return this._getUnitMergeArtifact(worktreeID, unitID);
  }

  async createWorktree(
    _context: DatabaseContext,
    input: CreateWorktreeDatabaseInput
  ): Promise<CreateWorktreeDatabaseResult> {
    this._assertOpen();
    validateCreateInput(input);
    return this._transaction(() => {
      const existing = this._getAggregate(input.record.worktreeID);
      if (existing) {
        return { status: "already-exists", aggregate: existing };
      }
      this._database
        .prepare(
          `INSERT INTO collaboration_worktrees (worktree_id, sid, status)
           VALUES (?, ?, 'draft')`
        )
        .run(input.record.worktreeID, input.record.sid);
      const insertUnit = this._database.prepare(
        `INSERT INTO collaboration_worktree_units
           (worktree_id, unit_id, unit_order, type, source,
            baseline_trunk_revision, draft_head_revision, creator_id, created_at_ms, metadata_json)
         VALUES (?, ?, ?, ?, 'trunk', ?, ?, ?, ?, ?)`
      );
      input.units.forEach((unit, index) => {
        insertUnit.run(
          unit.worktreeID,
          unit.unitID,
          index,
          unit.type,
          unit.baselineTrunkRevision as number,
          unit.draftHeadRevision,
          unit.creatorID,
          unit.createdAt,
          JSON.stringify(unit.metadata)
        );
      });
      return {
        status: "created",
        aggregate: this._requireAggregate(input.record.worktreeID),
      };
    });
  }

  async addUnit(
    _context: DatabaseContext,
    input: AddWorktreeUnitDatabaseInput
  ): Promise<AddWorktreeUnitDatabaseResult> {
    this._assertOpen();
    validateUnitIdentity(input.unit);
    return this._transaction(() => {
      const { unit } = input;
      const worktree = this._getWorktreeRow(unit.worktreeID);
      if (!worktree) return { status: "not-found" };
      if (this._getUnitRow(unit.worktreeID, unit.unitID)) {
        return {
          status: "already-exists",
          aggregate: this._requireAggregate(unit.worktreeID),
        };
      }
      if (worktree.status !== "draft") {
        return {
          status: "status-mismatch",
          aggregate: this._requireAggregate(unit.worktreeID),
        };
      }
      validateInitialUnit(unit);
      const orderRow = this._database
        .prepare(
          `SELECT COALESCE(MAX(unit_order), -1) + 1 AS next_order
           FROM collaboration_worktree_units
           WHERE worktree_id = ?`
        )
        .get(unit.worktreeID) as { readonly next_order: number };
      this._database
        .prepare(
          `INSERT INTO collaboration_worktree_units
             (worktree_id, unit_id, unit_order, type, source,
              baseline_trunk_revision, draft_head_revision, creator_id, created_at_ms, metadata_json)
           VALUES (?, ?, ?, ?, 'trunk', ?, ?, ?, ?, ?)`
        )
        .run(
          unit.worktreeID,
          unit.unitID,
          orderRow.next_order,
          unit.type,
          unit.baselineTrunkRevision as number,
          unit.draftHeadRevision,
          unit.creatorID,
          unit.createdAt,
          JSON.stringify(unit.metadata)
        );
      return {
        status: "added",
        aggregate: this._requireAggregate(unit.worktreeID),
      };
    });
  }

  async createUnit(
    _context: DatabaseContext,
    input: CreateWorktreeUnitDatabaseInput
  ): Promise<CreateWorktreeUnitDatabaseResult> {
    this._assertOpen();
    validateWorktreeCreatedUnit(input.unit, input.seed);
    return this._transaction(() => {
      const { unit, seed } = input;
      const worktree = this._getWorktreeRow(unit.worktreeID);
      if (!worktree) return { status: "not-found" };
      const existing = this._getUnitRow(unit.worktreeID, unit.unitID);
      if (existing) {
        const existingSeed = this._getUnitSeed(
          unit.worktreeID,
          unit.unitID
        );
        const exactRetry =
          existing.source === "worktree" &&
          existing.type === unit.type &&
          existingSeed !== null &&
          encode(existingSeed) === encode(seed);
        return {
          status: exactRetry ? "already-created" : "unit-exists",
          aggregate: this._requireAggregate(unit.worktreeID),
        };
      }
      if (worktree.status !== "draft") {
        return {
          status: "status-mismatch",
          aggregate: this._requireAggregate(unit.worktreeID),
        };
      }
      const orderRow = this._database
        .prepare(
          `SELECT COALESCE(MAX(unit_order), -1) + 1 AS next_order
           FROM collaboration_worktree_units
           WHERE worktree_id = ?`
        )
        .get(unit.worktreeID) as { readonly next_order: number };
      this._database
        .prepare(
          `INSERT INTO collaboration_worktree_units
             (worktree_id, unit_id, unit_order, type, source,
              baseline_trunk_revision, draft_head_revision, creator_id, created_at_ms, metadata_json)
           VALUES (?, ?, ?, ?, 'worktree', 1, 1, ?, ?, ?)`
        )
        .run(
          unit.worktreeID,
          unit.unitID,
          orderRow.next_order,
          unit.type,
          unit.creatorID,
          unit.createdAt,
          JSON.stringify(unit.metadata)
        );
      this._database
        .prepare(
          `INSERT INTO collaboration_worktree_unit_seeds
             (worktree_id, unit_id, snapshot_json,
              sheet_blocks_json)
           VALUES (?, ?, ?, ?)`
        )
        .run(
          unit.worktreeID,
          unit.unitID,
          encode(seed.snapshot),
          seed.sheetBlocks === undefined ? null : encode(seed.sheetBlocks)
        );
      return {
        status: "created",
        aggregate: this._requireAggregate(unit.worktreeID),
      };
    });
  }

  async saveUnitMergeArtifact(
    _context: DatabaseContext,
    input: SaveWorktreeUnitMergeArtifactInput
  ): Promise<SaveWorktreeUnitMergeArtifactResult> {
    this._assertOpen();
    return this._transaction(() => {
      const worktree = this._getWorktreeRow(input.worktreeID);
      const row = this._getUnitRow(input.worktreeID, input.unitID);
      if (!worktree || !row) return { status: "not-found" };
      const unit = rowToUnitRecord(row);
      if (
        worktree.status !== "merging" ||
        unit.source !== "worktree" ||
        unit.readyDraftHeadRevision !==
          input.artifact.readyDraftHeadRevision ||
        isTerminal(unit)
      ) {
        return { status: "stale-merge" };
      }
      const existing = this._getUnitMergeArtifact(
        input.worktreeID,
        input.unitID
      );
      if (existing) {
        return { status: "already-saved", artifact: existing };
      }
      validateMergeArtifact(unit, input.artifact);
      this._database
        .prepare(
          `INSERT INTO collaboration_worktree_unit_merge_artifacts
             (worktree_id, unit_id, ready_draft_head_revision,
              snapshot_json, sheet_blocks_json)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          input.worktreeID,
          input.unitID,
          input.artifact.readyDraftHeadRevision,
          encode(input.artifact.unit.snapshot),
          input.artifact.unit.sheetBlocks === undefined
            ? null
            : encode(input.artifact.unit.sheetBlocks)
        );
      return {
        status: "saved",
        artifact: decode<WorktreeUnitMergeArtifact>(
          encode(input.artifact)
        ),
      };
    });
  }

  async setUnitRemoved(
    _context: DatabaseContext,
    input: SetWorktreeUnitRemovedDatabaseInput
  ): Promise<SetWorktreeUnitRemovedResult> {
    this._assertOpen();
    return this._transaction(() => {
      const worktree = this._getWorktreeRow(input.worktreeID);
      const unit = this._getUnitRow(input.worktreeID, input.unitID);
      if (!worktree || !unit) return { status: "not-found" };
      if (worktree.status !== "draft" || isTerminal(rowToUnitRecord(unit))) {
        return { status: "not-editable", aggregate: this._requireAggregate(input.worktreeID) };
      }
      if ((unit.removed === 1) === input.removed) {
        return { status: "unchanged", aggregate: this._requireAggregate(input.worktreeID) };
      }
      this._database.prepare("UPDATE collaboration_worktree_units SET removed = ? WHERE worktree_id = ? AND unit_id = ?")
        .run(input.removed ? 1 : 0, input.worktreeID, input.unitID);
      return { status: "updated", aggregate: this._requireAggregate(input.worktreeID) };
    });
  }

  async commitDraftChangeset(
    _context: DatabaseContext,
    input: CommitWorktreeChangesetInput
  ): Promise<CommitWorktreeChangesetResult> {
    this._assertOpen();
    return this._transaction(() => {
      const { worktreeID, changeset } = input;
      const worktree = this._getWorktreeRow(worktreeID);
      const unit = this._getUnitRow(worktreeID, changeset.unitID);
      if (!worktree || !unit) return { status: "not-found" };
      if (worktree.status !== "draft") {
        return {
          status: "not-editable",
          worktreeStatus: toWorktreeStatus(worktree.status),
        };
      }
      const record = rowToUnitRecord(unit);
      if (record.removed || isTerminal(record)) return { status: "unit-frozen" };
      if (record.draftHeadRevision !== changeset.revision - 1) {
        return {
          status: "revision-mismatch",
          actualHeadRevision: record.draftHeadRevision,
        };
      }
      const createdAt = Date.now();
      const { metadata, ...protocolChangeset } = changeset;
      const payload = encode({ ...protocolChangeset, createTime: Math.floor(createdAt / 1000) });
      const metadataJson = JSON.stringify(metadata);
      this._database
        .prepare(
          `INSERT INTO collaboration_worktree_changesets
             (worktree_id, unit_id, revision, base_revision,
              sid, req_id, created_at_ms, payload_json, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          worktreeID,
          changeset.unitID,
          changeset.revision,
          changeset.baseRev,
          changeset.sid,
          changeset.reqId,
          createdAt,
          payload,
          metadataJson
        );
      const update = this._database
        .prepare(
          `UPDATE collaboration_worktree_units
           SET draft_head_revision = ?, metadata_json = ?
           WHERE worktree_id = ? AND unit_id = ?
             AND draft_head_revision = ?`
        )
        .run(
          changeset.revision,
          JSON.stringify(input.unitMetadata),
          worktreeID,
          changeset.unitID,
          changeset.revision - 1
        );
      if (update.changes !== 1) {
        throw new CollabError(
          "INTERNAL_ERROR",
          "SQLite draft head changed inside a write transaction"
        );
      }
      return {
        status: "committed",
        changeset: decodeChangeset(payload, metadataJson),
        headRevision: changeset.revision,
      };
    });
  }

  async markReady(
    _context: DatabaseContext,
    worktreeID: string
  ): Promise<WorktreeTransitionResult> {
    this._assertOpen();
    return this._transaction(() => {
      const row = this._getWorktreeRow(worktreeID);
      if (!row) return { status: "not-found" };
      if (row.status === "ready") {
        return {
          status: "already-in-target",
          aggregate: this._requireAggregate(worktreeID),
        };
      }
      if (row.status !== "draft") {
        return {
          status: "status-mismatch",
          aggregate: this._requireAggregate(worktreeID),
        };
      }
      for (const unit of this._getUnitRows(worktreeID)) {
        if (isTerminal(rowToUnitRecord(unit))) continue;
        this._database
          .prepare(
            `UPDATE collaboration_worktree_units
             SET ready_draft_head_revision = draft_head_revision
             WHERE worktree_id = ? AND unit_id = ?`
          )
          .run(worktreeID, unit.unit_id);
        this._database
          .prepare(
            `DELETE FROM collaboration_worktree_unit_merge_artifacts
             WHERE worktree_id = ? AND unit_id = ?`
          )
          .run(worktreeID, unit.unit_id);
      }
      this._updateStatus(worktreeID, "ready");
      return {
        status: "transitioned",
        previousStatus: "draft",
        aggregate: this._requireAggregate(worktreeID),
      };
    });
  }

  async reopenWorktree(
    _context: DatabaseContext,
    worktreeID: string
  ): Promise<WorktreeTransitionResult> {
    this._assertOpen();
    return this._transaction(() => {
      const row = this._getWorktreeRow(worktreeID);
      if (!row) return { status: "not-found" };
      if (row.status === "draft") {
        return {
          status: "already-in-target",
          aggregate: this._requireAggregate(worktreeID),
        };
      }
      if (row.status !== "ready") {
        return {
          status: "status-mismatch",
          aggregate: this._requireAggregate(worktreeID),
        };
      }
      for (const unit of this._getUnitRows(worktreeID)) {
        if (isTerminal(rowToUnitRecord(unit))) continue;
        this._database
          .prepare(
            `UPDATE collaboration_worktree_units
             SET ready_draft_head_revision = NULL, merge_result_json = NULL
             WHERE worktree_id = ? AND unit_id = ?`
          )
          .run(worktreeID, unit.unit_id);
        this._database
          .prepare(
            `DELETE FROM collaboration_worktree_unit_merge_artifacts
             WHERE worktree_id = ? AND unit_id = ?`
          )
          .run(worktreeID, unit.unit_id);
      }
      this._updateStatus(worktreeID, "draft");
      return {
        status: "transitioned",
        previousStatus: "ready",
        aggregate: this._requireAggregate(worktreeID),
      };
    });
  }

  async discardWorktree(
    _context: DatabaseContext,
    worktreeID: string
  ): Promise<WorktreeTransitionResult> {
    this._assertOpen();
    return this._transaction(() => {
      const row = this._getWorktreeRow(worktreeID);
      if (!row) return { status: "not-found" };
      if (row.status === "discarded") {
        return {
          status: "already-in-target",
          aggregate: this._requireAggregate(worktreeID),
        };
      }
      if (row.status !== "draft" && row.status !== "ready") {
        return {
          status: "status-mismatch",
          aggregate: this._requireAggregate(worktreeID),
        };
      }
      const previousStatus = toWorktreeStatus(row.status);
      this._updateStatus(worktreeID, "discarded");
      return {
        status: "transitioned",
        previousStatus,
        aggregate: this._requireAggregate(worktreeID),
      };
    });
  }

  async startOrResumeMerge(
    _context: DatabaseContext,
    worktreeID: string
  ): Promise<StartMergeResult> {
    this._assertOpen();
    return this._transaction(() => {
      const row = this._getWorktreeRow(worktreeID);
      if (!row) return { status: "not-found" };
      if (row.status === "merged") {
        return {
          status: "already-merged",
          aggregate: this._requireAggregate(worktreeID),
        };
      }
      if (row.status === "merging") {
        return {
          status: "resumed",
          aggregate: this._requireAggregate(worktreeID),
        };
      }
      if (row.status !== "ready") {
        return {
          status: "status-mismatch",
          aggregate: this._requireAggregate(worktreeID),
        };
      }
      this._updateStatus(worktreeID, "merging");
      return {
        status: "started",
        aggregate: this._requireAggregate(worktreeID),
      };
    });
  }

  async recordUnitMergeResult(
    _context: DatabaseContext,
    input: RecordUnitMergeResultInput
  ): Promise<RecordUnitMergeResultResult> {
    this._assertOpen();
    validateMergeResult(input.mergeResult);
    return this._transaction(() => {
      const worktree = this._getWorktreeRow(input.worktreeID);
      const unit = this._getUnitRow(input.worktreeID, input.unitID);
      if (!worktree || !unit) return { status: "not-found" };
      const record = rowToUnitRecord(unit);
      if (
        worktree.status !== "merging" ||
        record.readyDraftHeadRevision !== input.readyDraftHeadRevision
      ) {
        return { status: "stale-merge" };
      }
      if (
        (input.mergeResult.status === "removed" && !record.removed) ||
        (record.removed &&
          (input.mergeResult.status === "merged" || input.mergeResult.status === "unchanged"))
      ) {
        throw new CollabError("INVALID_REQUEST", "Merge result does not match frozen Unit removal intent");
      }
      const existing = record.mergeResult;
      if (existing && isDeepStrictEqual(existing, input.mergeResult)) {
        return {
          status: "already-recorded",
          aggregate: this._requireAggregate(input.worktreeID),
        };
      }
      if (existing && isTerminalResult(existing)) {
        return { status: "stale-merge" };
      }
      this._database
        .prepare(
          `UPDATE collaboration_worktree_units
           SET merge_result_json = ?
           WHERE worktree_id = ? AND unit_id = ?`
        )
        .run(encode(input.mergeResult), input.worktreeID, input.unitID);
      return {
        status: "recorded",
        aggregate: this._requireAggregate(input.worktreeID),
      };
    });
  }

  async finishMerge(
    _context: DatabaseContext,
    worktreeID: string
  ): Promise<WorktreeTransitionResult> {
    this._assertOpen();
    return this._transaction(() => {
      const row = this._getWorktreeRow(worktreeID);
      if (!row) return { status: "not-found" };
      if (row.status === "merged") {
        return {
          status: "already-in-target",
          aggregate: this._requireAggregate(worktreeID),
        };
      }
      if (row.status !== "merging") {
        return {
          status: "status-mismatch",
          aggregate: this._requireAggregate(worktreeID),
        };
      }
      const completed = this._getUnitRows(worktreeID).every((unit) =>
        isTerminal(rowToUnitRecord(unit))
      );
      this._updateStatus(worktreeID, completed ? "merged" : "ready");
      return {
        status: "transitioned",
        previousStatus: "merging",
        aggregate: this._requireAggregate(worktreeID),
      };
    });
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._database.close();
  }

  private _initializeSchema(): void {
    this._transaction(() => {
      if (!this._hasTable("collaboration_schema_versions")) {
        if (this._hasAnyOwnedTable()) {
          throw incompatibleSchema(
            "SQLite Worktree tables exist without a schema version"
          );
        }
        this._database.exec(SCHEMA_VERSIONS_SQL);
      }

      const row = this._database
        .prepare(
          `SELECT version
           FROM collaboration_schema_versions
           WHERE component = ?`
        )
        .get(SCHEMA_COMPONENT) as SchemaVersionRow | undefined;
      if (row) {
        if (row.version !== SCHEMA_VERSION) {
          const remedy = row.version < SCHEMA_VERSION ? "run migrateSQLiteWorktree first" : "upgrade the adapter";
          throw incompatibleSchema(
            `SQLite Worktree schema version ${row.version} is not supported; ${remedy}`
          );
        }
        const missingTables = TABLE_NAMES.filter(
          (tableName) => !this._hasTable(tableName)
        );
        if (missingTables.length > 0) {
          throw incompatibleSchema(
            `SQLite Worktree schema v${row.version} is incomplete: missing ${missingTables.join(", ")}`
          );
        }
        const changesetColumns = this._database.prepare("PRAGMA table_info(collaboration_worktree_changesets)").all() as Array<{ name: string; notnull: number }>;
        if (!["created_at_ms", "metadata_json"].every(name => changesetColumns.some(column => column.name === name && column.notnull === 1))) {
          throw incompatibleSchema("SQLite Worktree schema v4 is missing required changeset columns");
        }
        const columns = this._database.prepare("PRAGMA table_info(collaboration_worktree_units)").all() as Array<{ name: string; notnull: number }>;
        if (!["removed", "creator_id", "created_at_ms", "metadata_json"].every(name => columns.some(column => column.name === name && column.notnull === 1))) {
          throw incompatibleSchema("SQLite Worktree schema v4 is missing required Unit columns");
        }
        return;
      }

      if (this._hasAnyOwnedTable()) {
        throw incompatibleSchema(
          "SQLite Worktree tables exist without a schema version"
        );
      }

      this._database.exec(`
        ${WORKTREE_SCHEMA_SQL}
        INSERT INTO collaboration_schema_versions (component, version)
        VALUES ('worktree', ${SCHEMA_VERSION});
      `);
    });
  }

  private _hasTable(tableName: string): boolean {
    return Boolean(
      this._database
        .prepare(
          `SELECT 1
           FROM sqlite_schema
           WHERE type = 'table' AND name = ?`
        )
        .get(tableName)
    );
  }

  private _hasAnyOwnedTable(): boolean {
    return TABLE_NAMES.some((tableName) => this._hasTable(tableName));
  }

  private _getWorktreeRow(worktreeID: string): WorktreeRow | null {
    const row = this._database
      .prepare(
        `SELECT worktree_id, sid, status
         FROM collaboration_worktrees
         WHERE worktree_id = ?`
      )
      .get(worktreeID) as WorktreeRow | undefined;
    return row ?? null;
  }

  private _getUnitRow(
    worktreeID: string,
    unitID: string
  ): WorktreeUnitRow | null {
    const row = this._database
      .prepare(
        `SELECT worktree_id, unit_id, type, source, baseline_trunk_revision,
                draft_head_revision, ready_draft_head_revision,
                creator_id, created_at_ms, metadata_json, removed, merge_result_json
         FROM collaboration_worktree_units
         WHERE worktree_id = ? AND unit_id = ?`
      )
      .get(worktreeID, unitID) as WorktreeUnitRow | undefined;
    return row ?? null;
  }

  private _getUnitRows(worktreeID: string): readonly WorktreeUnitRow[] {
    return this._database
      .prepare(
        `SELECT worktree_id, unit_id, type, source, baseline_trunk_revision,
                draft_head_revision, ready_draft_head_revision,
                creator_id, created_at_ms, metadata_json, removed, merge_result_json
         FROM collaboration_worktree_units
         WHERE worktree_id = ?
         ORDER BY unit_order ASC`
      )
      .all(worktreeID) as unknown as WorktreeUnitRow[];
  }

  private _getUnitSeed(
    worktreeID: string,
    unitID: string
  ): WorktreeUnitSeed | null {
    const row = this._database
      .prepare(
        `SELECT snapshot_json, sheet_blocks_json
         FROM collaboration_worktree_unit_seeds
         WHERE worktree_id = ? AND unit_id = ?`
      )
      .get(worktreeID, unitID) as SeedRow | undefined;
    if (!row) return null;
    return {
      snapshot: decode(row.snapshot_json),
      ...(row.sheet_blocks_json === null
        ? {}
        : { sheetBlocks: decode(row.sheet_blocks_json) }),
    };
  }

  private _getUnitMergeArtifact(
    worktreeID: string,
    unitID: string
  ): WorktreeUnitMergeArtifact | null {
    const row = this._database
      .prepare(
        `SELECT ready_draft_head_revision, snapshot_json,
                sheet_blocks_json
         FROM collaboration_worktree_unit_merge_artifacts
         WHERE worktree_id = ? AND unit_id = ?`
      )
      .get(worktreeID, unitID) as MergeArtifactRow | undefined;
    if (!row) return null;
    return {
      readyDraftHeadRevision: row.ready_draft_head_revision,
      unit: {
        snapshot: decode(row.snapshot_json),
        ...(row.sheet_blocks_json === null
          ? {}
          : { sheetBlocks: decode(row.sheet_blocks_json) }),
      },
    };
  }

  private _getAggregate(worktreeID: string): WorktreeAggregateRecord | null {
    const worktree = this._getWorktreeRow(worktreeID);
    if (!worktree) return null;
    return {
      worktree: {
        worktreeID: worktree.worktree_id,
        sid: worktree.sid,
        status: toWorktreeStatus(worktree.status),
      },
      units: this._getUnitRows(worktreeID).map(rowToUnitRecord),
    };
  }

  private _requireAggregate(worktreeID: string): WorktreeAggregateRecord {
    const aggregate = this._getAggregate(worktreeID);
    if (!aggregate) {
      throw new CollabError(
        "INTERNAL_ERROR",
        "SQLite Worktree disappeared inside a write transaction"
      );
    }
    return aggregate;
  }

  private _updateStatus(worktreeID: string, status: string): void {
    const update = this._database
      .prepare(
        "UPDATE collaboration_worktrees SET status = ? WHERE worktree_id = ?"
      )
      .run(status, worktreeID);
    if (update.changes !== 1) {
      throw new CollabError(
        "INTERNAL_ERROR",
        "SQLite Worktree status update did not affect one record"
      );
    }
  }

  private _transaction<T>(operation: () => T): T {
    this._database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this._database.exec("COMMIT;");
      return result;
    } catch (error) {
      if (this._database.inTransaction) {
        this._database.exec("ROLLBACK;");
      }
      throw error;
    }
  }

  private _assertOpen(): void {
    if (this._disposed) {
      throw new CollabError(
        "INTERNAL_ERROR",
        "SQLite Worktree Database Adapter is disposed"
      );
    }
  }
}

function rowToUnitRecord(row: WorktreeUnitRow): WorktreeUnitRecord {
  const source = toWorktreeUnitSource(row.source);
  return {
    worktreeID: row.worktree_id,
    unitID: row.unit_id,
    type: row.type as UniverType,
    source,
    ...(source === "trunk"
      ? { baselineTrunkRevision: row.baseline_trunk_revision }
      : {}),
    draftHeadRevision: row.draft_head_revision,
    ...(row.ready_draft_head_revision === null
      ? {}
      : { readyDraftHeadRevision: row.ready_draft_head_revision }),
    creatorID: row.creator_id,
    createdAt: row.created_at_ms,
    metadata: JSON.parse(row.metadata_json) as UnitMetadata,
    ...(row.removed === 1 ? { removed: true } : {}),
    ...(row.merge_result_json === null
      ? {}
      : {
          mergeResult: decode<WorktreeUnitMergeResult>(
            row.merge_result_json
          ),
        }),
  };
}

function validateOptions(
  options: SQLiteWorktreeDatabaseAdapterOptions
): void {
  if (!options.filename) throw invalidRequest("SQLite filename is required");
  if (
    options.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.busyTimeoutMs) ||
      options.busyTimeoutMs < 0)
  ) {
    throw invalidRequest(
      "SQLite busyTimeoutMs must be a non-negative integer"
    );
  }
}

function validateCreateInput(input: CreateWorktreeDatabaseInput): void {
  if (
    !input.record.worktreeID ||
    !input.record.sid ||
    input.record.status !== "draft"
  ) {
    throw invalidRequest("New Worktree must be a draft with identity");
  }
  const unitIDs = new Set<string>();
  for (const unit of input.units) {
    if (
      unit.worktreeID !== input.record.worktreeID ||
      unitIDs.has(unit.unitID)
    ) {
      throw invalidRequest(
        "Initial Worktree Units must be unique and share identity"
      );
    }
    unitIDs.add(unit.unitID);
    validateInitialUnit(unit);
  }
}

function validateInitialUnit(unit: WorktreeUnitRecord): void {
  validateUnitIdentity(unit);
  if (
    unit.source !== "trunk" ||
    !Number.isSafeInteger(unit.baselineTrunkRevision) ||
    (unit.baselineTrunkRevision as number) < 1 ||
    unit.draftHeadRevision !== unit.baselineTrunkRevision ||
    unit.readyDraftHeadRevision !== undefined ||
    unit.mergeResult !== undefined
  ) {
    throw invalidRequest("New Worktree Unit must start at its trunk baseline");
  }
}

function validateWorktreeCreatedUnit(
  unit: WorktreeUnitRecord,
  seed: WorktreeUnitSeed
): void {
  validateUnitIdentity(unit);
  if (
    unit.source !== "worktree" ||
    unit.baselineTrunkRevision !== undefined ||
    unit.draftHeadRevision !== 1 ||
    unit.readyDraftHeadRevision !== undefined ||
    unit.mergeResult !== undefined ||
    seed.snapshot.unitID !== unit.unitID ||
    seed.snapshot.type !== unit.type ||
    seed.snapshot.rev !== 1
  ) {
    throw invalidRequest(
      "Worktree-created Unit must start from its revision 1 seed"
    );
  }
}

function validateUnitIdentity(unit: WorktreeUnitRecord): void {
  if (typeof unit.creatorID !== "string" || unit.creatorID.length === 0 || !Number.isSafeInteger(unit.createdAt) || unit.createdAt < 0) {
    throw invalidRequest("Unit creation requires creatorID and createdAt in Unix milliseconds");
  }
  if (!unit.worktreeID || !unit.unitID) {
    throw invalidRequest("Worktree and Unit identity are required");
  }
}

function validateRange(range: WorktreeRevisionRange): void {
  if (
    !Number.isSafeInteger(range.from) ||
    range.from < 0 ||
    (range.to !== undefined &&
      (!Number.isSafeInteger(range.to) || range.to < 0))
  ) {
    throw invalidRequest("Draft revision range cannot be negative");
  }
}

function validateMergeResult(result: WorktreeUnitMergeResult): void {
  if (result.status === "merged") {
    if (
      !Number.isSafeInteger(result.trunkRevision) ||
      result.trunkRevision < 1
    ) {
      throw invalidRequest("Merged result requires a trunk revision");
    }
    return;
  }
  if (result.status === "unchanged" || result.status === "removed") return;
  if (
    !result.error.code ||
    !result.error.message ||
    typeof result.error.retryable !== "boolean"
  ) {
    throw invalidRequest("Merge error must be stable and serializable");
  }
}

function validateMergeArtifact(
  unit: WorktreeUnitRecord,
  artifact: WorktreeUnitMergeArtifact
): void {
  if (
    artifact.unit.snapshot.unitID !== unit.unitID ||
    artifact.unit.snapshot.type !== unit.type ||
    artifact.unit.snapshot.rev !== 1
  ) {
    throw invalidRequest(
      "Worktree Unit merge artifact must be a revision 1 snapshot"
    );
  }
}

function isTerminal(unit: WorktreeUnitRecord): boolean {
  return isTerminalResult(unit.mergeResult);
}

function isTerminalResult(
  result: WorktreeUnitMergeResult | undefined
): boolean {
  return result?.status === "merged" || result?.status === "unchanged" || result?.status === "removed";
}

function toWorktreeStatus(
  status: string
): WorktreeAggregateRecord["worktree"]["status"] {
  if (
    status === "draft" ||
    status === "ready" ||
    status === "merging" ||
    status === "merged" ||
    status === "discarded"
  ) {
    return status;
  }
  throw new CollabError(
    "INTERNAL_ERROR",
    `SQLite contains invalid Worktree status ${status}`
  );
}

function toWorktreeUnitSource(value: string): "trunk" | "worktree" {
  if (value === "trunk" || value === "worktree") return value;
  throw new CollabError(
    "INTERNAL_ERROR",
    `SQLite contains invalid Worktree Unit source ${value}`
  );
}

function invalidRequest(message: string): CollabError {
  return new CollabError("INVALID_REQUEST", message);
}

function incompatibleSchema(message: string): CollabError {
  return new CollabError("INTERNAL_ERROR", message);
}

function encode(value: unknown): string {
  return JSON.stringify(value, function (
    this: Record<string, unknown>,
    key: string,
    current: unknown
  ) {
    // Buffer.toJSON runs before the replacer. Read the original value from the holder to preserve its byte type.
    const original = this[key];
    if (original instanceof Uint8Array) {
      return {
        [BINARY_TAG]: Buffer.from(original).toString("base64"),
      };
    }
    return current;
  });
}

function decodeChangeset(payload: string, metadata: string): ChangesetRecord {
  return {
    ...decode<IChangeset>(payload),
    metadata: JSON.parse(metadata) as ChangesetMetadata,
  };
}

function decode<T>(payload: string): T {
  return JSON.parse(payload, (_key, current: unknown) => {
    if (isBinaryEncoding(current)) {
      return Uint8Array.from(Buffer.from(current[BINARY_TAG], "base64"));
    }
    return current;
  }) as T;
}

function isBinaryEncoding(
  value: unknown
): value is Record<typeof BINARY_TAG, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>)[BINARY_TAG] === "string"
  );
}
