import { createChangeset, createDatabaseContext, createSheetBlock, createSnapshot } from "@univerjs-pro/collaboration-database-testkit";
import type {
  WorktreeRecord,
  WorktreeStatus,
  WorktreeUnitSeed,
  WorktreeUnitRecord,
  WorktreeUnitSource,
} from "@univerjs-pro/collaboration-worktree-service";
import { UniverType } from "@univerjs/protocol";

export {
  createChangeset,
  createDatabaseContext,
  createSheetBlock,
  createSnapshot,
};

export function createWorktreeRecord(
  worktreeID: string,
  status: WorktreeStatus = "draft"
): WorktreeRecord {
  return {
    worktreeID,
    sid: `merge-${worktreeID}`,
    status,
  };
}

export function createWorktreeUnitRecord(input: {
  readonly worktreeID: string;
  readonly unitID: string;
  readonly type?: UniverType;
  readonly source?: WorktreeUnitSource;
  readonly baselineTrunkRevision?: number;
}): WorktreeUnitRecord {
  const source = input.source ?? "trunk";
  const baselineTrunkRevision =
    source === "trunk" ? (input.baselineTrunkRevision ?? 1) : undefined;
  return {
    worktreeID: input.worktreeID,
    unitID: input.unitID,
    type: input.type ?? UniverType.UNIVER_SHEET,
    source,
    ...(baselineTrunkRevision === undefined
      ? {}
      : { baselineTrunkRevision }),
    draftHeadRevision: baselineTrunkRevision ?? 1,
    creatorID: "test-user",
    createdAt: 1700000000123,
    metadata: {},
  };
}

export function createWorktreeUnitSeed(
  unitID: string,
  type: UniverType = UniverType.UNIVER_SHEET
): WorktreeUnitSeed {
  return {
    snapshot: createSnapshot(unitID, type, 1),
    sheetBlocks: [createSheetBlock("block-1", 1)],
  };
}

export function createPdfWorktreeUnitSeed(unitID: string): WorktreeUnitSeed {
  return {
    snapshot: {
      ...createSnapshot(unitID, UniverType.UNIVER_PDF, 1),
      pdf: {
        unitID,
        rev: 1,
        creator: "test-user",
        name: "PDF",
        originalMeta: Uint8Array.from([0, 1, 2, 127, 128, 254, 255]),
      },
    },
  };
}
