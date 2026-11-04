import type {
  SubmitDatabaseContext,
  UnitRecord,
} from "@univerjs-pro/collaboration-service";
import type {
  IChangeset,
  ISheetBlock,
  ISnapshot,
  UniverType,
} from "@univerjs/protocol";

export function createDatabaseContext(): SubmitDatabaseContext {
  return {
    userID: "test-user",
    memberID: "test-member",
    customData: Object.create(null) as Record<string, unknown>,
    request: {
      changeset: createChangeset({
        unitID: "test-context",
        type: 1 as UniverType,
        revision: 2,
        sid: "test-context",
        reqId: 1,
      }),
    },
  };
}

export function createUnitRecord(
  unitID: string,
  type: UniverType
): UnitRecord {
  return { unitID, type, headRevision: 1, creatorID: "test-user", createdAt: 1700000000123 };
}

export function createSnapshot(
  unitID: string,
  type: UniverType,
  rev: number
): ISnapshot {
  return {
    unitID,
    type,
    rev,
    workbook: undefined,
    doc: undefined,
    slide: undefined,
    board: undefined,
  };
}

export function createChangeset(input: {
  readonly unitID: string;
  readonly type: UniverType;
  readonly revision: number;
  readonly sid: string;
  readonly reqId: number;
  readonly marker?: string;
}): IChangeset {
  return {
    unitID: input.unitID,
    type: input.type,
    baseRev: input.revision - 1,
    revision: input.revision,
    userID: "test-user",
    memberID: "test-member",
    sid: input.sid,
    reqId: input.reqId,
    mutations: [
      {
        id: "test.mutation",
        data: JSON.stringify({ marker: input.marker ?? input.revision }),
      },
    ],
  };
}

export function createSheetBlock(id: string, marker: number): ISheetBlock {
  return {
    id,
    startRow: marker,
    endRow: marker,
    data: new Uint8Array([marker]),
  };
}
