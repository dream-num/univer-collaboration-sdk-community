import type { IDatabaseAdapter } from "@univerjs-pro/collaboration-service";
import { UniverType } from "@univerjs/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createChangeset,
  createDatabaseContext,
  createSheetBlock,
  createSnapshot,
  createUnitRecord,
} from "./fixtures.js";

export interface DatabaseAdapterHarness {
  readonly adapter: IDatabaseAdapter;
  dispose?(): void | Promise<void>;
}

export type DatabaseAdapterHarnessFactory = () =>
  | DatabaseAdapterHarness
  | Promise<DatabaseAdapterHarness>;

// Adapters store the Unit type as an opaque integer; two values prove it round-trips.
const UNIT_TYPES = [UniverType.UNIVER_SHEET, UniverType.UNIVER_DOC] as const;

/**
 * Registers the complete persistence contract in the caller's suite.
 *
 * Lifecycle inputs follow the Service contract: `unitIDs` is non-empty and contains no empty
 * strings or duplicates. Adapters may rely on this and are not exercised with duplicates.
 */
export function databaseAdapterContract(
  name: string,
  createHarness: DatabaseAdapterHarnessFactory
): void {
  describe(`${name} IDatabaseAdapter contract`, () => {
    let harness: DatabaseAdapterHarness;
    let adapter: IDatabaseAdapter;

    beforeEach(async () => {
      harness = await createHarness();
      adapter = harness.adapter;
    });

    afterEach(async () => {
      await harness.dispose?.();
    });

    it.each([undefined, 123])("assigns the persisted time without mutating input: %s", async (inputTime) => {
      const context = createDatabaseContext();
      const unitID = "time-unit";
      await createUnit(adapter, context, unitID, UniverType.UNIVER_SHEET);
      const changeset = {
        ...createChangeset({ unitID, type: UniverType.UNIVER_SHEET, revision: 2, sid: "time-sid", reqId: 1 }),
        ...(inputTime === undefined ? {} : { createTime: inputTime }),
      };
      const result = await adapter.commitChangeset(context, { changeset });
      expect(result).toEqual({
        status: "committed", headRevision: 2,
        changeset: { ...changeset, createTime: expect.any(Number) },
      });
      if (result.status !== "committed") throw new Error("Expected commit");
      expect(Number.isSafeInteger(result.changeset.createTime)).toBe(true);
      expect(result.changeset.createTime).not.toBe(inputTime);
      expect(changeset.createTime).toBe(inputTime);
      await expect(adapter.getChangesets(context, unitID, { from: 1 })).resolves.toEqual([result.changeset]);
    });

    it("creates a unit at revision 1 and reports a duplicate create", async () => {
      const context = createDatabaseContext();
      const type = UniverType.UNIVER_SHEET;
      const record = createUnitRecord("unit-create", type);
      const snapshot = createSnapshot(record.unitID, type, 1);
      const block = createSheetBlock("block-initial", 1);
      const [first, second] = await Promise.all([
        adapter.createUnit(context, {
          record,
          snapshot,
          sheetBlocks: [block],
        }),
        adapter.createUnit(context, {
          record,
          snapshot,
          sheetBlocks: [block],
        }),
      ]);

      expect([first.status, second.status].sort()).toEqual([
        "already-exists",
        "created",
      ]);
      await expect(adapter.getUnit(context, record.unitID)).resolves.toEqual(
        record
      );
      await expect(
        adapter.getSnapshot(context, record.unitID)
      ).resolves.toEqual(snapshot);
      await expect(
        adapter.getSheetBlock(context, record.unitID, block.id)
      ).resolves.toEqual(block);
    });

    it("preserves creation facts across duplicate create, commit and recovery", async () => {
      const context = createDatabaseContext();
      const record = {
        ...createUnitRecord("creation-facts", UniverType.UNIVER_DOC),
        creatorID: "original-creator",
        createdAt: 1_700_000_000_123,
      };
      const snapshot = createSnapshot(record.unitID, record.type, 1);
      await adapter.createUnit(context, { record, snapshot });
      await expect(adapter.createUnit(context, {
        record: { ...record, creatorID: "another-user", createdAt: record.createdAt + 1000 },
        snapshot,
      })).resolves.toEqual({ status: "already-exists", record });
      await adapter.commitChangeset(context, {
        changeset: createChangeset({ unitID: record.unitID, type: record.type, revision: 2, sid: "creation-facts", reqId: 1 }),
      });
      await adapter.deleteUnits(context, { unitIDs: [record.unitID], hardDelete: false });
      await adapter.recoverUnits(context, { unitIDs: [record.unitID] });
      await expect(adapter.getUnit(context, record.unitID)).resolves.toEqual({ ...record, headRevision: 2 });
    });

    it("rejects missing or invalid creation facts without creating a Unit", async () => {
      const context = createDatabaseContext();
      const record = createUnitRecord("invalid-creation", UniverType.UNIVER_DOC);
      for (const invalid of [{ creatorID: undefined }, { creatorID: "" }, { createdAt: undefined }, { createdAt: -1 }, { createdAt: 1.5 }]) {
        await expect(adapter.createUnit(context, {
          record: { ...record, ...invalid } as typeof record,
          snapshot: createSnapshot(record.unitID, record.type, 1),
        })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        await expect(adapter.getUnit(context, record.unitID)).resolves.toBeNull();
      }
    });

    it("rejects any initial revision other than 1", async () => {
      const context = createDatabaseContext();
      const type = UniverType.UNIVER_DOC;

      await expect(
        adapter.createUnit(context, {
          record: {
            ...createUnitRecord("unit-invalid-rev", type),
            headRevision: 2,
          },
          snapshot: createSnapshot("unit-invalid-rev", type, 2),
        })
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(
        adapter.createUnit(context, {
          record: createUnitRecord("unit-mismatched-rev", type),
          snapshot: createSnapshot("unit-mismatched-rev", type, 2),
        })
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(adapter.getUnit(context, "unit-mismatched-rev")).resolves.toBeNull();
    });

    it("reads changesets in (from, to] and treats to=0 as an explicit upper bound", async () => {
      const context = createDatabaseContext();
      const unitID = "unit-range";
      const type = UniverType.UNIVER_DOC;
      await createUnit(adapter, context, unitID, type);
      const revision2 = createChangeset({
        unitID,
        type,
        revision: 2,
        sid: "sid-range",
        reqId: 1,
      });
      const revision3 = createChangeset({
        unitID,
        type,
        revision: 3,
        sid: "sid-range",
        reqId: 2,
      });
      await adapter.commitChangeset(context, {
        changeset: revision2,
      });
      await adapter.commitChangeset(context, {
        changeset: revision3,
      });

      await expect(
        adapter.getChangesets(context, unitID, { from: 1, to: 2 })
      ).resolves.toEqual([{ ...revision2, createTime: expect.any(Number) }]);
      await expect(
        adapter.getChangesets(context, unitID, { from: 1 })
      ).resolves.toEqual([{ ...revision2, createTime: expect.any(Number) }, { ...revision3, createTime: expect.any(Number) }]);
      await expect(
        adapter.getChangesets(context, unitID, { from: 3 })
      ).resolves.toEqual([]);
      await expect(
        adapter.getChangesets(context, unitID, { from: 0 })
      ).resolves.toEqual([{ ...revision2, createTime: expect.any(Number) }, { ...revision3, createTime: expect.any(Number) }]);
      await expect(
        adapter.getChangesets(context, unitID, { from: 1, to: 99 })
      ).resolves.toEqual([{ ...revision2, createTime: expect.any(Number) }, { ...revision3, createTime: expect.any(Number) }]);
      await expect(
        adapter.getChangesets(context, unitID, { from: 1, to: 0 })
      ).resolves.toEqual([]);
      await expect(
        adapter.getChangesets(context, "missing-unit", { from: 0 })
      ).resolves.toBeNull();
    });

    it("uses omitted bounds for latest without treating zero as latest", async () => {
      const context = createDatabaseContext();
      const unitID = "unit-read-bounds";
      const snapshot = await createUnit(adapter, context, unitID, UniverType.UNIVER_DOC);
      await expect(adapter.getSnapshot(context, unitID, {})).resolves.toEqual(snapshot);
      await expect(adapter.getSnapshotInfo(context, unitID, {})).resolves.toEqual({
        unitID, type: UniverType.UNIVER_DOC, rev: 1,
      });
      await expect(adapter.getChangesets(context, unitID, { from: 0 })).resolves.toEqual([]);
      await expect(adapter.getSnapshot(context, unitID, { revision: 0 })).resolves.toBeNull();
      await expect(adapter.getSnapshotInfo(context, unitID, { revision: 0 })).resolves.toBeNull();
    });

    it("rejects negative revisions and ranges", async () => {
      const context = createDatabaseContext();
      const unitID = "unit-negative-bounds";
      await createUnit(adapter, context, unitID, UniverType.UNIVER_DOC);
      await expect(adapter.getSnapshot(context, unitID, { revision: -1 })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      await expect(adapter.getSnapshotInfo(context, unitID, { revision: -1 })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      await expect(adapter.getChangesets(context, unitID, { from: -1 })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      await expect(adapter.getChangesets(context, unitID, { from: 0, to: -1 })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    });

    it("returns the nearest snapshot at or below the requested revision", async () => {
      const context = createDatabaseContext();
      const unitID = "unit-snapshot";
      const type = UniverType.UNIVER_SHEET;
      const initial = await createUnit(adapter, context, unitID, type);
      const revision2 = createChangeset({
        unitID,
        type,
        revision: 2,
        sid: "sid-snapshot",
        reqId: 1,
      });
      const revision3 = createChangeset({
        unitID,
        type,
        revision: 3,
        sid: "sid-snapshot",
        reqId: 2,
      });
      await adapter.commitChangeset(context, {
        changeset: revision2,
      });
      await adapter.commitChangeset(context, {
        changeset: revision3,
      });

      const snapshot = createSnapshot(unitID, type, 3);
      const block = createSheetBlock("block-rev-3", 3);
      await adapter.saveSnapshot(context, {
        snapshot,
        sheetBlocks: [block],
      });

      await expect(
        adapter.getSnapshot(context, unitID, { revision: 2 })
      ).resolves.toEqual(initial);
      await expect(
        adapter.getSnapshot(context, unitID, { revision: 3 })
      ).resolves.toEqual(snapshot);
      await expect(
        adapter.getSnapshot(context, unitID)
      ).resolves.toEqual(snapshot);
      for (const [revision, rev] of [[1, 1], [2, 1], [3, 3], [99, 3]] as const) {
        await expect(
          adapter.getSnapshotInfo(context, unitID, { revision })
        ).resolves.toEqual({ unitID, type, rev });
      }
      await expect(adapter.getSnapshotInfo(context, unitID)).resolves.toEqual({
        unitID, type, rev: 3,
      });
      await expect(adapter.getSnapshotInfo(context, "missing-unit")).resolves.toBeNull();
      await expect(
        adapter.getSheetBlock(context, unitID, block.id)
      ).resolves.toEqual(block);
    });

    it("rejects snapshots that do not match the stored unit", async () => {
      const context = createDatabaseContext();
      const unitID = "unit-snapshot-validation";
      const type = UniverType.UNIVER_SHEET;
      const initial = await createUnit(adapter, context, unitID, type);

      await expect(
        adapter.saveSnapshot(context, { snapshot: createSnapshot(unitID, type, 2) })
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(
        adapter.saveSnapshot(context, { snapshot: createSnapshot(unitID, UniverType.UNIVER_DOC, 1) })
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(
        adapter.saveSnapshot(context, { snapshot: createSnapshot(unitID, type, 0) })
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(adapter.getSnapshot(context, unitID)).resolves.toEqual(initial);
      await expect(adapter.getSnapshotInfo(context, unitID)).resolves.toEqual({ unitID, type, rev: 1 });
    });

    it("overwrites a snapshot and its blocks saved again at the same revision", async () => {
      const context = createDatabaseContext();
      const unitID = "unit-snapshot-overwrite";
      const type = UniverType.UNIVER_SHEET;
      await createUnit(adapter, context, unitID, type);
      await adapter.commitChangeset(context, {
        changeset: createChangeset({ unitID, type, revision: 2, sid: "sid-overwrite", reqId: 1 }),
      });

      const snapshot = createSnapshot(unitID, type, 2);
      await adapter.saveSnapshot(context, {
        snapshot,
        sheetBlocks: [createSheetBlock("block-shared", 2), createSheetBlock("block-first-only", 2)],
      });
      const replaced = createSheetBlock("block-shared", 3);
      await adapter.saveSnapshot(context, { snapshot, sheetBlocks: [replaced] });

      await expect(adapter.getSnapshot(context, unitID)).resolves.toEqual(snapshot);
      await expect(adapter.getSnapshotInfo(context, unitID)).resolves.toEqual({ unitID, type, rev: 2 });
      await expect(adapter.getSheetBlock(context, unitID, "block-shared")).resolves.toEqual(replaced);
      await expect(adapter.getSheetBlock(context, unitID, "block-first-only")).resolves.toEqual(
        createSheetBlock("block-first-only", 2)
      );
    });

    it("reports revision-mismatch for stale and ahead revisions without changing the unit", async () => {
      const context = createDatabaseContext();
      const unitID = "unit-revision-mismatch";
      const type = UniverType.UNIVER_DOC;
      await createUnit(adapter, context, unitID, type);
      const revision2 = createChangeset({ unitID, type, revision: 2, sid: "sid-mismatch", reqId: 1 });
      const committed = await adapter.commitChangeset(context, { changeset: revision2 });
      expect(committed.status).toBe("committed");

      await expect(
        adapter.commitChangeset(context, {
          changeset: createChangeset({ unitID, type, revision: 2, sid: "sid-stale", reqId: 1 }),
        })
      ).resolves.toEqual({ status: "revision-mismatch", actualHeadRevision: 2 });
      await expect(
        adapter.commitChangeset(context, {
          changeset: createChangeset({ unitID, type, revision: 4, sid: "sid-ahead", reqId: 1 }),
        })
      ).resolves.toEqual({ status: "revision-mismatch", actualHeadRevision: 2 });

      await expect(adapter.getUnit(context, unitID)).resolves.toMatchObject({ headRevision: 2 });
      await expect(adapter.getChangesets(context, unitID, { from: 1 })).resolves.toEqual([
        { ...revision2, createTime: expect.any(Number) },
      ]);
    });

    it("rejects commits to a unit that was never created", async () => {
      const context = createDatabaseContext();
      await expect(
        adapter.commitChangeset(context, {
          changeset: createChangeset({
            unitID: "unit-never-created",
            type: UniverType.UNIVER_SHEET,
            revision: 2,
            sid: "sid-missing",
            reqId: 1,
          }),
        })
      ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });
      await expect(adapter.getUnit(context, "unit-never-created")).resolves.toBeNull();
    });

    it("allows only one caller to win the same revision CAS", async () => {
      const context = createDatabaseContext();
      const unitID = "unit-cas";
      const type = UniverType.UNIVER_BASE;
      await createUnit(adapter, context, unitID, type);
      const first = createChangeset({
        unitID,
        type,
        revision: 2,
        sid: "sid-cas-a",
        reqId: 1,
      });
      const second = createChangeset({
        unitID,
        type,
        revision: 2,
        sid: "sid-cas-b",
        reqId: 1,
      });

      const results = await Promise.all([
        adapter.commitChangeset(context, {
          changeset: first,
        }),
        adapter.commitChangeset(context, {
          changeset: second,
        }),
      ]);

      expect(results.filter((result) => result.status === "committed")).toHaveLength(
        1
      );
      expect(
        results.filter((result) => result.status === "revision-mismatch")
      ).toEqual([{ status: "revision-mismatch", actualHeadRevision: 2 }]);
    });

    it.each(UNIT_TYPES)(
      "preserves a type %s unit across soft delete and recover",
      async (type) => {
        const context = createDatabaseContext();
        const unitID = `unit-lifecycle-${type}`;
        const initial = createSnapshot(unitID, type, 1);
        const initialBlock = createSheetBlock(`block-initial-${type}`, 1);
        await adapter.createUnit(context, {
          record: createUnitRecord(unitID, type),
          snapshot: initial,
          sheetBlocks: [initialBlock],
        });

        const revision2 = createChangeset({
          unitID,
          type,
          revision: 2,
          sid: `sid-lifecycle-${type}`,
          reqId: 1,
        });
        await adapter.commitChangeset(context, {
          changeset: revision2,
        });
        const latest = createSnapshot(unitID, type, 2);
        const latestBlock = createSheetBlock(`block-latest-${type}`, 2);
        await adapter.saveSnapshot(context, {
          snapshot: latest,
          sheetBlocks: [latestBlock],
        });

        await expect(
          adapter.deleteUnits(context, { unitIDs: [unitID], hardDelete: false })
        ).resolves.toEqual({
          units: [{ unitID, status: "soft-deleted" }],
        });
        await expect(
          adapter.deleteUnits(context, { unitIDs: [unitID], hardDelete: false })
        ).resolves.toEqual({
          units: [{ unitID, status: "already-soft-deleted" }],
        });

        await expect(adapter.getUnit(context, unitID)).resolves.toBeNull();
        await expect(adapter.getSnapshot(context, unitID)).resolves.toBeNull();
        await expect(adapter.getSnapshotInfo(context, unitID)).resolves.toBeNull();
        await expect(
          adapter.getChangesets(context, unitID, { from: 0 })
        ).resolves.toEqual(null);
        await expect(
          adapter.getSheetBlock(context, unitID, latestBlock.id)
        ).resolves.toBeNull();
        await expect(
          adapter.commitChangeset(context, {
            changeset: revision2,
          })
        ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });
        await expect(
          adapter.saveSnapshot(context, { snapshot: latest })
        ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });

        await expect(
          adapter.createUnit(context, {
            record: createUnitRecord(unitID, type),
            snapshot: initial,
          })
        ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        await expect(adapter.getUnit(context, unitID)).resolves.toBeNull();

        await expect(
          adapter.recoverUnits(context, { unitIDs: [unitID] })
        ).resolves.toEqual({ units: [{ unitID, status: "recovered" }] });
        await expect(
          adapter.recoverUnits(context, { unitIDs: [unitID] })
        ).resolves.toEqual({ units: [{ unitID, status: "already-active" }] });

        await expect(adapter.getUnit(context, unitID)).resolves.toEqual({
          ...createUnitRecord(unitID, type),
          headRevision: 2,
        });
        await expect(adapter.getSnapshot(context, unitID)).resolves.toEqual(
          latest
        );
        await expect(adapter.getSnapshotInfo(context, unitID)).resolves.toEqual({
          unitID, type, rev: 2,
        });
        await expect(
          adapter.getChangesets(context, unitID, { from: 1 })
        ).resolves.toEqual([{ ...revision2, createTime: expect.any(Number) }]);
        await expect(
          adapter.getSheetBlock(context, unitID, latestBlock.id)
        ).resolves.toEqual(latestBlock);
        await expect(
          adapter.deleteUnits(context, { unitIDs: [unitID], hardDelete: true })
        ).resolves.toEqual({
          units: [{ unitID, status: "hard-deleted" }],
        });
        await assertPurged(adapter, context, unitID, type, initial);
      }
    );

    it.each(UNIT_TYPES)(
      "hard deletes a soft-deleted type %s unit",
      async (type) => {
        const context = createDatabaseContext();
        const unitID = `unit-soft-hard-delete-${type}`;
        const snapshot = createSnapshot(unitID, type, 1);
        await adapter.createUnit(context, {
          record: createUnitRecord(unitID, type),
          snapshot,
        });
        await adapter.deleteUnits(context, {
          unitIDs: [unitID],
          hardDelete: false,
        });

        await expect(
          adapter.deleteUnits(context, { unitIDs: [unitID], hardDelete: true })
        ).resolves.toEqual({
          units: [{ unitID, status: "hard-deleted" }],
        });
        await assertPurged(adapter, context, unitID, type, snapshot);
      }
    );

    it("does not partially change a lifecycle batch containing a missing unit", async () => {
      const context = createDatabaseContext();
      const type = UniverType.UNIVER_SHEET;
      const softDeleteID = "unit-batch-soft-delete";
      const recoverID = "unit-batch-recover";
      const hardDeleteID = "unit-batch-hard-delete";

      for (const unitID of [softDeleteID, recoverID, hardDeleteID]) {
        await createUnit(adapter, context, unitID, type);
      }
      await adapter.deleteUnits(context, {
        unitIDs: [recoverID],
        hardDelete: false,
      });

      await expect(
        adapter.deleteUnits(context, {
          unitIDs: [softDeleteID, "unit-batch-missing"],
          hardDelete: false,
        })
      ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });
      await expect(adapter.getUnit(context, softDeleteID)).resolves.not.toBeNull();

      await expect(
        adapter.recoverUnits(context, {
          unitIDs: [recoverID, "unit-batch-missing"],
        })
      ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });
      await expect(
        adapter.deleteUnits(context, {
          unitIDs: [recoverID],
          hardDelete: false,
        })
      ).resolves.toEqual({
        units: [{ unitID: recoverID, status: "already-soft-deleted" }],
      });

      await expect(
        adapter.deleteUnits(context, {
          unitIDs: [hardDeleteID, "unit-batch-missing"],
          hardDelete: true,
        })
      ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });
      await expect(adapter.getUnit(context, hardDeleteID)).resolves.not.toBeNull();
    });
  });
}

async function assertPurged(
  adapter: IDatabaseAdapter,
  context: ReturnType<typeof createDatabaseContext>,
  unitID: string,
  type: UniverType,
  initial: ReturnType<typeof createSnapshot>
): Promise<void> {
  await expect(adapter.getUnit(context, unitID)).resolves.toBeNull();
  await expect(adapter.getSnapshot(context, unitID)).resolves.toBeNull();
  await expect(adapter.getSnapshotInfo(context, unitID)).resolves.toBeNull();
  await expect(
    adapter.getChangesets(context, unitID, { from: 0 })
  ).resolves.toEqual(null);
  await expect(
    adapter.getSheetBlock(context, unitID, "block-missing")
  ).resolves.toBeNull();
  await expect(
    adapter.commitChangeset(context, {
      changeset: createChangeset({
        unitID,
        type,
        revision: 2,
        sid: "sid-purged",
        reqId: 1,
      }),
    })
  ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });
  await expect(
    adapter.saveSnapshot(context, { snapshot: initial })
  ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });

  await expect(
    adapter.deleteUnits(context, { unitIDs: [unitID], hardDelete: true })
  ).resolves.toEqual({
    units: [{ unitID, status: "already-hard-deleted" }],
  });
  await expect(
    adapter.deleteUnits(context, { unitIDs: [unitID], hardDelete: false })
  ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });
  await expect(
    adapter.recoverUnits(context, { unitIDs: [unitID] })
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(
    adapter.createUnit(context, {
      record: createUnitRecord(unitID, type),
      snapshot: initial,
    })
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
}

async function createUnit(
  adapter: IDatabaseAdapter,
  context: ReturnType<typeof createDatabaseContext>,
  unitID: string,
  type: UniverType
) {
  const snapshot = createSnapshot(unitID, type, 1);
  await adapter.createUnit(context, {
    record: createUnitRecord(unitID, type),
    snapshot,
  });
  return snapshot;
}
