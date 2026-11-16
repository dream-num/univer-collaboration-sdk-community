import { isDeepStrictEqual } from "node:util";
import {
  CollabError,
  type DatabaseContext,
  type ChangesetRecord,
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
  WorktreeUnitRecord,
  WorktreeUnitMergeArtifact,
  WorktreeUnitSeed,
} from "@univerjs-pro/collaboration-worktree-service";

interface StoredWorktreeUnit {
  record: WorktreeUnitRecord;
  readonly seed?: WorktreeUnitSeed;
  mergeArtifact?: WorktreeUnitMergeArtifact;
  readonly changesets: Map<number, ChangesetRecord>;
}

interface StoredWorktree {
  record: WorktreeAggregateRecord["worktree"];
  readonly units: Map<string, StoredWorktreeUnit>;
}

/**
 * Worktree persistence reference implementation.
 *
 * Every mutation finishes without an await point, so one method call is
 * atomically visible within this process.
 * @public
 */
export class MemoryWorktreeDatabaseAdapter
  implements IWorktreeDatabaseAdapter
{
  private readonly _worktrees = new Map<string, StoredWorktree>();
  private _disposed = false;

  async getWorktree(
    _context: DatabaseContext,
    worktreeID: string
  ): Promise<WorktreeAggregateRecord | null> {
    this._assertOpen();
    const worktree = this._worktrees.get(worktreeID);
    return worktree ? aggregate(worktree) : null;
  }

  async getWorktreeUnit(
    _context: DatabaseContext,
    worktreeID: string,
    unitID: string
  ): Promise<WorktreeUnitRecord | null> {
    this._assertOpen();
    const unit = this._worktrees.get(worktreeID)?.units.get(unitID);
    return unit ? clone(unit.record) : null;
  }

  async getDraftChangesets(
    _context: DatabaseContext,
    worktreeID: string,
    unitID: string,
    range: WorktreeRevisionRange
  ): Promise<readonly ChangesetRecord[] | null> {
    this._assertOpen();
    validateRange(range);
    const unit = this._worktrees.get(worktreeID)?.units.get(unitID);
    if (!unit) {
      return null;
    }
    return [...unit.changesets.entries()]
      .filter(([revision]) => revision > range.from && (range.to === undefined || revision <= range.to))
      .sort(([left], [right]) => left - right)
      .map(([, changeset]) => clone(changeset));
  }

  async getUnitSeed(
    _context: DatabaseContext,
    worktreeID: string,
    unitID: string
  ): Promise<WorktreeUnitSeed | null> {
    this._assertOpen();
    const seed = this._worktrees.get(worktreeID)?.units.get(unitID)?.seed;
    return seed ? clone(seed) : null;
  }

  async getUnitMergeArtifact(
    _context: DatabaseContext,
    worktreeID: string,
    unitID: string
  ): Promise<WorktreeUnitMergeArtifact | null> {
    this._assertOpen();
    const artifact = this._worktrees
      .get(worktreeID)
      ?.units.get(unitID)?.mergeArtifact;
    return artifact ? clone(artifact) : null;
  }

  async createWorktree(
    _context: DatabaseContext,
    input: CreateWorktreeDatabaseInput
  ): Promise<CreateWorktreeDatabaseResult> {
    this._assertOpen();
    validateCreateInput(input);
    const existing = this._worktrees.get(input.record.worktreeID);
    if (existing) {
      return { status: "already-exists", aggregate: aggregate(existing) };
    }

    const units = new Map<string, StoredWorktreeUnit>();
    for (const record of input.units) {
      units.set(record.unitID, {
        record: clone(record),
        changesets: new Map(),
      });
    }
    const stored: StoredWorktree = {
      record: clone(input.record),
      units,
    };
    this._worktrees.set(input.record.worktreeID, stored);
    return { status: "created", aggregate: aggregate(stored) };
  }

  async addUnit(
    _context: DatabaseContext,
    input: AddWorktreeUnitDatabaseInput
  ): Promise<AddWorktreeUnitDatabaseResult> {
    this._assertOpen();
    const { unit } = input;
    validateUnitIdentity(unit);
    const worktree = this._worktrees.get(unit.worktreeID);
    if (!worktree) {
      return { status: "not-found" };
    }
    if (worktree.units.has(unit.unitID)) {
      return { status: "already-exists", aggregate: aggregate(worktree) };
    }
    if (worktree.record.status !== "draft") {
      return { status: "status-mismatch", aggregate: aggregate(worktree) };
    }
    validateTrunkUnit(unit);
    worktree.units.set(unit.unitID, {
      record: clone(unit),
      changesets: new Map(),
    });
    return { status: "added", aggregate: aggregate(worktree) };
  }

  async createUnit(
    _context: DatabaseContext,
    input: CreateWorktreeUnitDatabaseInput
  ): Promise<CreateWorktreeUnitDatabaseResult> {
    this._assertOpen();
    validateWorktreeCreatedUnit(input.unit, input.seed);
    const worktree = this._worktrees.get(input.unit.worktreeID);
    if (!worktree) return { status: "not-found" };
    const existing = worktree.units.get(input.unit.unitID);
    if (existing) {
      const exactRetry =
        existing.record.source === "worktree" &&
        existing.record.type === input.unit.type &&
        existing.seed !== undefined &&
        isDeepStrictEqual(existing.seed, input.seed);
      return {
        status: exactRetry ? "already-created" : "unit-exists",
        aggregate: aggregate(worktree),
      };
    }
    if (worktree.record.status !== "draft") {
      return { status: "status-mismatch", aggregate: aggregate(worktree) };
    }
    worktree.units.set(input.unit.unitID, {
      record: clone(input.unit),
      seed: clone(input.seed),
      changesets: new Map(),
    });
    return { status: "created", aggregate: aggregate(worktree) };
  }

  async saveUnitMergeArtifact(
    _context: DatabaseContext,
    input: SaveWorktreeUnitMergeArtifactInput
  ): Promise<SaveWorktreeUnitMergeArtifactResult> {
    this._assertOpen();
    const worktree = this._worktrees.get(input.worktreeID);
    const unit = worktree?.units.get(input.unitID);
    if (!worktree || !unit) return { status: "not-found" };
    if (
      worktree.record.status !== "merging" ||
      unit.record.source !== "worktree" ||
      unit.record.readyDraftHeadRevision !==
        input.artifact.readyDraftHeadRevision ||
      isTerminal(unit.record)
    ) {
      return { status: "stale-merge" };
    }
    if (unit.mergeArtifact) {
      return {
        status: "already-saved",
        artifact: clone(unit.mergeArtifact),
      };
    }
    validateMergeArtifact(unit.record, input.artifact);
    unit.mergeArtifact = clone(input.artifact);
    return { status: "saved", artifact: clone(input.artifact) };
  }

  async setUnitRemoved(
    _context: DatabaseContext,
    input: SetWorktreeUnitRemovedDatabaseInput
  ): Promise<SetWorktreeUnitRemovedResult> {
    this._assertOpen();
    const worktree = this._worktrees.get(input.worktreeID);
    const unit = worktree?.units.get(input.unitID);
    if (!worktree || !unit) return { status: "not-found" };
    if (worktree.record.status !== "draft" || isTerminal(unit.record)) {
      return { status: "not-editable", aggregate: aggregate(worktree) };
    }
    if (Boolean(unit.record.removed) === input.removed) {
      return { status: "unchanged", aggregate: aggregate(worktree) };
    }
    const { removed: _removed, ...retained } = unit.record;
    unit.record = { ...retained, ...(input.removed ? { removed: true } : {}) };
    return { status: "updated", aggregate: aggregate(worktree) };
  }

  async commitDraftChangeset(
    _context: DatabaseContext,
    input: CommitWorktreeChangesetInput
  ): Promise<CommitWorktreeChangesetResult> {
    this._assertOpen();
    const worktree = this._worktrees.get(input.worktreeID);
    const unit = worktree?.units.get(input.changeset.unitID);
    if (!worktree || !unit) {
      return { status: "not-found" };
    }

    if (worktree.record.status !== "draft") {
      return {
        status: "not-editable",
        worktreeStatus: worktree.record.status,
      };
    }
    if (unit.record.removed || isTerminal(unit.record)) {
      return { status: "unit-frozen" };
    }
    if (unit.record.draftHeadRevision !== input.changeset.revision - 1) {
      return {
        status: "revision-mismatch",
        actualHeadRevision: unit.record.draftHeadRevision,
      };
    }
    const changeset = clone(input.changeset);
    const unitMetadata = clone(input.unitMetadata);
    changeset.createTime = Math.floor(Date.now() / 1000);
    unit.changesets.set(changeset.revision, changeset);
    unit.record = {
      ...unit.record,
      draftHeadRevision: changeset.revision,
      metadata: unitMetadata,
    };
    return {
      status: "committed",
      changeset: clone(changeset),
      headRevision: changeset.revision,
    };
  }

  async markReady(
    _context: DatabaseContext,
    worktreeID: string
  ): Promise<WorktreeTransitionResult> {
    this._assertOpen();
    const worktree = this._worktrees.get(worktreeID);
    if (!worktree) return { status: "not-found" };
    if (worktree.record.status === "ready") {
      return { status: "already-in-target", aggregate: aggregate(worktree) };
    }
    if (worktree.record.status !== "draft") {
      return { status: "status-mismatch", aggregate: aggregate(worktree) };
    }
    for (const unit of worktree.units.values()) {
      if (isTerminal(unit.record)) continue;
      unit.record = {
        ...unit.record,
        readyDraftHeadRevision: unit.record.draftHeadRevision,
      };
    }
    worktree.record = { ...worktree.record, status: "ready" };
    return {
      status: "transitioned",
      previousStatus: "draft",
      aggregate: aggregate(worktree),
    };
  }

  async reopenWorktree(
    _context: DatabaseContext,
    worktreeID: string
  ): Promise<WorktreeTransitionResult> {
    this._assertOpen();
    const worktree = this._worktrees.get(worktreeID);
    if (!worktree) return { status: "not-found" };
    if (worktree.record.status === "draft") {
      return { status: "already-in-target", aggregate: aggregate(worktree) };
    }
    if (worktree.record.status !== "ready") {
      return { status: "status-mismatch", aggregate: aggregate(worktree) };
    }
    for (const unit of worktree.units.values()) {
      if (isTerminal(unit.record)) continue;
      unit.record = editableRecord(unit.record);
      delete unit.mergeArtifact;
    }
    worktree.record = { ...worktree.record, status: "draft" };
    return {
      status: "transitioned",
      previousStatus: "ready",
      aggregate: aggregate(worktree),
    };
  }

  async discardWorktree(
    _context: DatabaseContext,
    worktreeID: string
  ): Promise<WorktreeTransitionResult> {
    this._assertOpen();
    const worktree = this._worktrees.get(worktreeID);
    if (!worktree) return { status: "not-found" };
    if (worktree.record.status === "discarded") {
      return { status: "already-in-target", aggregate: aggregate(worktree) };
    }
    if (
      worktree.record.status !== "draft" &&
      worktree.record.status !== "ready"
    ) {
      return { status: "status-mismatch", aggregate: aggregate(worktree) };
    }
    const previousStatus = worktree.record.status;
    worktree.record = { ...worktree.record, status: "discarded" };
    return {
      status: "transitioned",
      previousStatus,
      aggregate: aggregate(worktree),
    };
  }

  async startOrResumeMerge(
    _context: DatabaseContext,
    worktreeID: string
  ): Promise<StartMergeResult> {
    this._assertOpen();
    const worktree = this._worktrees.get(worktreeID);
    if (!worktree) return { status: "not-found" };
    if (worktree.record.status === "merged") {
      return { status: "already-merged", aggregate: aggregate(worktree) };
    }
    if (worktree.record.status === "merging") {
      return { status: "resumed", aggregate: aggregate(worktree) };
    }
    if (worktree.record.status !== "ready") {
      return { status: "status-mismatch", aggregate: aggregate(worktree) };
    }
    worktree.record = { ...worktree.record, status: "merging" };
    return { status: "started", aggregate: aggregate(worktree) };
  }

  async recordUnitMergeResult(
    _context: DatabaseContext,
    input: RecordUnitMergeResultInput
  ): Promise<RecordUnitMergeResultResult> {
    this._assertOpen();
    validateMergeResult(input.mergeResult);
    const worktree = this._worktrees.get(input.worktreeID);
    const unit = worktree?.units.get(input.unitID);
    if (!worktree || !unit) return { status: "not-found" };
    if (
      worktree.record.status !== "merging" ||
      unit.record.readyDraftHeadRevision !== input.readyDraftHeadRevision
    ) {
      return { status: "stale-merge" };
    }
    if (
      (input.mergeResult.status === "removed" && !unit.record.removed) ||
      (unit.record.removed &&
        (input.mergeResult.status === "merged" || input.mergeResult.status === "unchanged"))
    ) {
      throw new CollabError("INVALID_REQUEST", "Merge result does not match frozen Unit removal intent");
    }
    const existing = unit.record.mergeResult;
    if (existing && isDeepStrictEqual(existing, input.mergeResult)) {
      return {
        status: "already-recorded",
        aggregate: aggregate(worktree),
      };
    }
    if (existing && isTerminalResult(existing)) {
      return { status: "stale-merge" };
    }
    unit.record = {
      ...unit.record,
      mergeResult: clone(input.mergeResult),
    };
    return { status: "recorded", aggregate: aggregate(worktree) };
  }

  async finishMerge(
    _context: DatabaseContext,
    worktreeID: string
  ): Promise<WorktreeTransitionResult> {
    this._assertOpen();
    const worktree = this._worktrees.get(worktreeID);
    if (!worktree) return { status: "not-found" };
    if (worktree.record.status === "merged") {
      return { status: "already-in-target", aggregate: aggregate(worktree) };
    }
    if (worktree.record.status !== "merging") {
      return { status: "status-mismatch", aggregate: aggregate(worktree) };
    }
    const completed = [...worktree.units.values()].every((unit) =>
      isTerminal(unit.record)
    );
    worktree.record = {
      ...worktree.record,
      status: completed ? "merged" : "ready",
    };
    return {
      status: "transitioned",
      previousStatus: "merging",
      aggregate: aggregate(worktree),
    };
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._worktrees.clear();
  }

  private _assertOpen(): void {
    if (this._disposed) {
      throw new CollabError(
        "INTERNAL_ERROR",
        "Memory Worktree Database Adapter is disposed"
      );
    }
  }
}

function aggregate(worktree: StoredWorktree): WorktreeAggregateRecord {
  return {
    worktree: clone(worktree.record),
    units: [...worktree.units.values()].map(({ record }) => clone(record)),
  };
}

function validateCreateInput(input: CreateWorktreeDatabaseInput): void {
  if (
    !input.record.worktreeID ||
    !input.record.sid ||
    input.record.status !== "draft"
  ) {
    throw invalidRequest("New Worktree record must be a draft with identity");
  }
  const unitIDs = new Set<string>();
  for (const unit of input.units) {
    if (unit.worktreeID !== input.record.worktreeID) {
      throw invalidRequest("Initial Unit belongs to a different Worktree");
    }
    if (unitIDs.has(unit.unitID)) {
      throw invalidRequest("Initial Worktree Units must be unique");
    }
    unitIDs.add(unit.unitID);
    validateTrunkUnit(unit);
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

function validateTrunkUnit(unit: WorktreeUnitRecord): void {
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

function validateMergeResult(
  result: RecordUnitMergeResultInput["mergeResult"]
): void {
  if (result.status === "merged") {
    if (
      !Number.isSafeInteger(result.trunkRevision) ||
      result.trunkRevision < 1
    ) {
      throw invalidRequest("Merged result requires a positive trunk revision");
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

function validateRange(range: WorktreeRevisionRange): void {
  if (
    !Number.isSafeInteger(range.from) ||
    range.from < 0 ||
    (range.to !== undefined &&
      (!Number.isSafeInteger(range.to) || range.to < 0))
  ) {
    throw invalidRequest("Changeset range revisions must be non-negative");
  }
}

function editableRecord(record: WorktreeUnitRecord): WorktreeUnitRecord {
  const {
    readyDraftHeadRevision: _readyDraftHeadRevision,
    mergeResult: _mergeResult,
    ...editable
  } = record;
  return editable;
}

function isTerminal(record: WorktreeUnitRecord): boolean {
  return record.mergeResult
    ? isTerminalResult(record.mergeResult)
    : false;
}

function isTerminalResult(
  result: NonNullable<WorktreeUnitRecord["mergeResult"]>
): boolean {
  return result.status === "merged" || result.status === "unchanged" || result.status === "removed";
}

function invalidRequest(message: string): CollabError {
  return new CollabError("INVALID_REQUEST", message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
