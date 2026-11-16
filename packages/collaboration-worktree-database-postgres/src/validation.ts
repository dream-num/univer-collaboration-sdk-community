import { CollabError } from "@univerjs-pro/collaboration-service";
import type {
  CreateWorktreeDatabaseInput, WorktreeRevisionRange, WorktreeUnitMergeArtifact,
  WorktreeUnitMergeResult, WorktreeUnitRecord, WorktreeUnitSeed,
} from "@univerjs-pro/collaboration-worktree-service";

export function validateCreateInput(input: CreateWorktreeDatabaseInput): void {
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

export function validateInitialUnit(unit: WorktreeUnitRecord): void {
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

export function validateWorktreeCreatedUnit(
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

export function validateUnitIdentity(unit: WorktreeUnitRecord): void {
  if (typeof unit.creatorID !== "string" || unit.creatorID.length === 0 || !Number.isSafeInteger(unit.createdAt) || unit.createdAt < 0) {
    throw invalidRequest("Unit creation requires creatorID and createdAt in Unix milliseconds");
  }
  if (!unit.worktreeID || !unit.unitID) {
    throw invalidRequest("Worktree and Unit identity are required");
  }
}

export function validateRange(range: WorktreeRevisionRange): void {
  if (
    !Number.isSafeInteger(range.from) ||
    range.from < 0 ||
    (range.to !== undefined &&
      (!Number.isSafeInteger(range.to) || range.to < 0))
  ) {
    throw invalidRequest("Draft revision range cannot be negative");
  }
}

export function validateMergeResult(result: WorktreeUnitMergeResult): void {
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

export function validateMergeArtifact(
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

function invalidRequest(message: string): CollabError {
  return new CollabError("INVALID_REQUEST", message);
}
