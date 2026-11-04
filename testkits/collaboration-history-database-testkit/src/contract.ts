import type {
  HistoryOrigin,
  HistoryRecord,
  IHistoryDatabaseAdapter,
  ListHistoryRecordsOptions,
} from "@univerjs-pro/collaboration-history-service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHistoryDatabaseContext, createHistoryRecord } from "./fixtures.js";
import { selectReferencePage } from "./reference.js";

export interface HistoryDatabaseAdapterHarness {
  readonly adapter: IHistoryDatabaseAdapter;
  dispose?(): void | Promise<void>;
}

export type HistoryDatabaseAdapterHarnessFactory = () =>
  | HistoryDatabaseAdapterHarness
  | Promise<HistoryDatabaseAdapterHarness>;

const context = createHistoryDatabaseContext();

/** Registers the complete History persistence contract in the caller's suite. */
export function historyDatabaseAdapterContract(
  name: string,
  createHarness: HistoryDatabaseAdapterHarnessFactory,
): void {
  describe(`${name} IHistoryDatabaseAdapter contract`, () => {
    let harness: HistoryDatabaseAdapterHarness;
    let adapter: IHistoryDatabaseAdapter;

    beforeEach(async () => {
      harness = await createHarness();
      adapter = harness.adapter;
    });

    afterEach(async () => {
      await harness.dispose?.();
    });

    async function appendAll(records: readonly HistoryRecord[]): Promise<void> {
      let latest: number | null = null;
      for (const record of records) {
        expect(await adapter.appendRecord(context, record, { expectedLatestStartRevision: latest })).toEqual({
          status: "appended",
        });
        latest = record.startRevision;
      }
    }

    it("appends boundaries with a CAS on the latest start revision", async () => {
      expect(await adapter.getLatestRecord(context, "unit-1")).toBeNull();
      await appendAll([createHistoryRecord(1), createHistoryRecord(2)]);

      // A stale expectation, a start revision that does not advance and a different record at an
      // existing start revision all conflict; the identical record is idempotent.
      expect(
        await adapter.appendRecord(context, createHistoryRecord(10), { expectedLatestStartRevision: 1 }),
      ).toEqual({ status: "conflict" });
      expect(
        await adapter.appendRecord(context, createHistoryRecord(2), { expectedLatestStartRevision: 2 }),
      ).toEqual({ status: "already-exists" });
      expect(
        await adapter.appendRecord(context, createHistoryRecord(2, { userID: "other" }), {
          expectedLatestStartRevision: 2,
        }),
      ).toEqual({ status: "conflict" });
      expect(
        await adapter.appendRecord(context, createHistoryRecord(1, { additionalFields: "{}" }), {
          expectedLatestStartRevision: 2,
        }),
      ).toEqual({ status: "conflict" });

      const latest = await adapter.getLatestRecord(context, "unit-1");
      expect(latest).toEqual(createHistoryRecord(2));
      (latest as { userID: string }).userID = "mutated";
      expect(await adapter.getLatestRecord(context, "unit-1")).toEqual(createHistoryRecord(2));
    });

    it("keeps additionalFields as an opaque string", async () => {
      await appendAll([createHistoryRecord(1, { additionalFields: '{"restored":true}' })]);
      expect(await adapter.getLatestRecord(context, "unit-1")).toEqual(
        createHistoryRecord(1, { additionalFields: '{"restored":true}' }),
      );
      expect(
        await adapter.appendRecord(context, createHistoryRecord(1), { expectedLatestStartRevision: 1 }),
      ).toEqual({ status: "conflict" });
    });

    it("rejects invalid records without storing them", async () => {
      for (const record of [
        createHistoryRecord(1, { unitID: "" }),
        createHistoryRecord(1, { userID: "" }),
        createHistoryRecord(0),
        createHistoryRecord(1.5),
        createHistoryRecord(1, { createdAt: -1 }),
      ]) {
        await expect(
          adapter.appendRecord(context, record, { expectedLatestStartRevision: null }),
        ).rejects.toThrow(TypeError);
      }
      expect(await adapter.getLatestRecord(context, "unit-1")).toBeNull();
    });

    it("isolates Units", async () => {
      await appendAll([createHistoryRecord(1), createHistoryRecord(5)]);
      expect(
        await adapter.appendRecord(context, createHistoryRecord(3, { unitID: "unit-2" }), {
          expectedLatestStartRevision: null,
        }),
      ).toEqual({ status: "appended" });
      expect(await adapter.getLatestRecord(context, "unit-1")).toEqual(createHistoryRecord(5));
      expect(await adapter.getLatestRecord(context, "unit-3")).toBeNull();
      expect(await adapter.listRecords(context, "unit-3", { throughRevision: 10, length: 5 })).toEqual({
        records: [],
        hasMore: false,
      });
      expect(await adapter.listCreators(context, "unit-3", { throughRevision: 10 })).toEqual([]);
    });

    it("pages newest first with unfiltered successors and caps the head at throughRevision", async () => {
      await appendAll([1, 2, 101, 151, 201].map((revision) => createHistoryRecord(revision)));
      const page = await adapter.listRecords(context, "unit-1", { throughRevision: 180, length: 2 });
      expect(page.records.map(({ record, endRevision }) => [record.startRevision, endRevision])).toEqual([
        [151, 180],
        [101, 150],
      ]);
      expect(page.hasMore).toBe(true);

      // Filters narrow the page; the end revision still comes from the next boundary of the Unit.
      const filtered = await adapter.listRecords(context, "unit-1", {
        throughRevision: 180,
        length: 1,
        origin: 1,
        userIDs: ["user-1", "user-2"],
        beforeRevision: 151,
      });
      expect(filtered.records.map(({ record, endRevision }) => [record.startRevision, endRevision])).toEqual([
        [101, 150],
      ]);
      expect(filtered.hasMore).toBe(true);
      const tail = await adapter.listRecords(context, "unit-1", { throughRevision: 180, length: 10, beforeRevision: 2 });
      expect(tail).toEqual({ records: [{ record: createHistoryRecord(1), endRevision: 1 }], hasMore: false });
    });

    it("treats origin 0 as unfiltered and stores origins opaquely", async () => {
      await appendAll([0, 3, 12].map((origin, index) => createHistoryRecord(index + 1, { origin: origin as HistoryOrigin })));
      const options = { throughRevision: 5, length: 10 };
      const all = await adapter.listRecords(context, "unit-1", { ...options, origin: 0 });
      expect(all.records.map(({ record }) => record.origin)).toEqual([12, 3, 0]);
      expect(await adapter.listRecords(context, "unit-1", options)).toEqual(all);
      const selected = await adapter.listRecords(context, "unit-1", { ...options, origin: 3 as HistoryOrigin });
      expect(selected.records).toEqual([{ record: createHistoryRecord(2, { origin: 3 as HistoryOrigin }), endRevision: 2 }]);
      expect(await adapter.getLatestRecord(context, "unit-1")).toMatchObject({ origin: 12 });
      expect(await adapter.listCreators(context, "unit-1", { throughRevision: 5 })).toEqual([
        { userID: "user-1", origins: [0] },
        { userID: "user-2", origins: [3] },
        { userID: "user-0", origins: [12] },
      ].sort((left, right) => left.userID.localeCompare(right.userID)));
    });

    it("lists creators through a revision, sorted by user and then origin", async () => {
      await appendAll([1, 2, 3, 4, 7, 9].map((revision) => createHistoryRecord(revision)));
      expect(await adapter.listCreators(context, "unit-1", { throughRevision: 4 })).toEqual([
        { userID: "user-0", origins: [1] },
        { userID: "user-1", origins: [1, 2] },
        { userID: "user-2", origins: [2] },
      ]);
      expect(await adapter.listCreators(context, "unit-1", { throughRevision: 0 })).toEqual([]);
    });

    it("matches the reference selection across filters and cursors", async () => {
      const records: HistoryRecord[] = [];
      for (let revision = 1; revision < 300; revision += 7) records.push(createHistoryRecord(revision));
      await appendAll(records);
      for (const throughRevision of [1, 89, 301]) {
        for (const beforeRevision of [undefined, 2, 110, 400]) {
          for (const origin of [undefined, 0, 1, 2] as const) {
            for (const userIDs of [undefined, ["user-1", "user-2"]]) {
              const options: ListHistoryRecordsOptions = {
                throughRevision,
                length: 3,
                ...(beforeRevision === undefined ? {} : { beforeRevision }),
                ...(origin === undefined ? {} : { origin }),
                ...(userIDs === undefined ? {} : { userIDs }),
              };
              expect(await adapter.listRecords(context, "unit-1", options)).toEqual(
                selectReferencePage(records, options),
              );
            }
          }
        }
      }
    });
  });
}
