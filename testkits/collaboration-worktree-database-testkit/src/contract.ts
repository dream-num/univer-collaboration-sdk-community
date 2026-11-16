import type {
  IWorktreeDatabaseAdapter,
  WorktreeAggregateRecord,
  WorktreeUnitMergeResult,
} from "@univerjs-pro/collaboration-worktree-service";
import { UniverType } from "@univerjs/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createChangeset,
  createDatabaseContext,
  createSheetBlock,
  createWorktreeRecord,
  createPdfWorktreeUnitSeed,
  createWorktreeUnitSeed,
  createWorktreeUnitRecord,
} from "./fixtures.js";

export interface WorktreeDatabaseAdapterHarness {
  readonly adapter: IWorktreeDatabaseAdapter;
  dispose?(): void | Promise<void>;
}

export type WorktreeDatabaseAdapterHarnessFactory = () =>
  | WorktreeDatabaseAdapterHarness
  | Promise<WorktreeDatabaseAdapterHarness>;

export function worktreeDatabaseAdapterContract(
  name: string,
  createHarness: WorktreeDatabaseAdapterHarnessFactory
): void {
  describe(`${name} IWorktreeDatabaseAdapter contract`, () => {
    let harness: WorktreeDatabaseAdapterHarness;
    let adapter: IWorktreeDatabaseAdapter;

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
      const worktreeID = "time-worktree";
      await createWorktree(adapter, worktreeID, unitID);
      const changeset = {
        ...createChangeset({ unitID, type: UniverType.UNIVER_SHEET, revision: 2, sid: "time-sid", reqId: 1 }),
        ...(inputTime === undefined ? {} : { createTime: inputTime }),
      };
      const result = await adapter.commitDraftChangeset(context, { unitMetadata: {}, worktreeID, changeset });
      expect(result).toEqual({
        status: "committed", headRevision: 2,
        changeset: { ...changeset, createTime: expect.any(Number) },
      });
      if (result.status !== "committed") throw new Error("Expected commit");
      expect(Number.isSafeInteger(result.changeset.createTime)).toBe(true);
      expect(result.changeset.createTime).not.toBe(inputTime);
      expect(changeset.createTime).toBe(inputTime);
      await expect(adapter.getDraftChangesets(context, worktreeID, unitID, { from: 1 })).resolves.toEqual([result.changeset]);
    });

    it("atomically replaces draft metadata and isolates reads, inputs and competing commits", async () => {
      const context = createDatabaseContext();
      const worktreeID = "metadata-worktree";
      const unitID = "metadata-unit";
      await adapter.createWorktree(context, { record: createWorktreeRecord(worktreeID), units: [] });
      const initial = { name: "Initial", details: { source: "import" } };
      const unit = { ...createWorktreeUnitRecord({ worktreeID, unitID, source: "worktree" }), metadata: initial };
      const created = await adapter.createUnit(context, { unit, seed: createWorktreeUnitSeed(unitID) });
      expect(created.status).toBe("created");
      initial.details.source = "caller-change";
      expect((await adapter.getWorktreeUnit(context, worktreeID, unitID))!.metadata).toEqual({
        name: "Initial", details: { source: "import" },
      });
      const firstMetadata = { label: "first", nested: { value: "saved" } };
      const first = createChangeset({ unitID, type: unit.type, revision: 2, sid: "meta-first", reqId: 1, metadata: firstMetadata });
      const second = createChangeset({ unitID, type: unit.type, revision: 2, sid: "meta-second", reqId: 1, metadata: { label: "second" } });
      const results = await Promise.all([
        adapter.commitDraftChangeset(context, { worktreeID, changeset: first, unitMetadata: { winner: "first" } }),
        adapter.commitDraftChangeset(context, { worktreeID, changeset: second, unitMetadata: { winner: "second" } }),
      ]);
      const winner = results[0].status === "committed" ? "first" : "second";
      const expectedMetadata = winner === "first" ? { label: "first", nested: { value: "saved" } } : { label: "second" };
      expect(results.map(result => result.status).sort()).toEqual(["committed", "revision-mismatch"]);
      firstMetadata.nested.value = "caller-change";
      const stored = await adapter.getWorktreeUnit(context, worktreeID, unitID);
      expect(stored!.metadata).toEqual({ winner });
      stored!.metadata.winner = "read-change";
      const history = await adapter.getDraftChangesets(context, worktreeID, unitID, { from: 1 });
      expect(history![0]!.metadata).toEqual(expectedMetadata);
      history![0]!.metadata.label = "read-change";
      expect((await adapter.getDraftChangesets(context, worktreeID, unitID, { from: 1 }))![0]!.metadata).toEqual(expectedMetadata);
      await adapter.commitDraftChangeset(context, {
        unitMetadata: (await adapter.getWorktreeUnit(context, worktreeID, unitID))!.metadata,
        worktreeID, changeset: createChangeset({ unitID, type: unit.type, revision: 3, sid: "meta-next", reqId: 1 }),
      });
      expect((await adapter.getWorktreeUnit(context, worktreeID, unitID))!.metadata).toEqual({ winner });
      await adapter.commitDraftChangeset(context, {
        worktreeID, changeset: createChangeset({ unitID, type: unit.type, revision: 4, sid: "meta-clear", reqId: 1 }), unitMetadata: {},
      });
      expect((await adapter.getWorktreeUnit(context, worktreeID, unitID))!.metadata).toEqual({});
    });

    it("keeps application JSON metadata independent of protocol binary encoding", async () => {
      const context = createDatabaseContext();
      const worktreeID = "metadata-json";
      const unitID = "unit-json";
      const metadata = JSON.parse('{"__proto__":{"application":true},"nested":{"__univerCollaborationBinary":"arbitrary application text"}}');
      await adapter.createWorktree(context, {
        record: createWorktreeRecord(worktreeID),
        units: [{ ...createWorktreeUnitRecord({ worktreeID, unitID }), metadata }],
      });
      const result = await adapter.commitDraftChangeset(context, {
        unitMetadata: metadata,
        worktreeID,
        changeset: createChangeset({ unitID, type: UniverType.UNIVER_SHEET, revision: 2, sid: "json", reqId: 1, metadata }),
      });
      expect(result).toMatchObject({ status: "committed", changeset: { metadata } });
      expect((await adapter.getWorktreeUnit(context, worktreeID, unitID))!.metadata).toEqual(metadata);
      expect((await adapter.getDraftChangesets(context, worktreeID, unitID, { from: 1 }))![0]!.metadata).toEqual(metadata);
    });

    it("freezes removed Units against writes and preserves reversible intent until ready", async () => {
      const context = createDatabaseContext();
      const worktreeID = "remove-unit";
      const unitID = "unit-removed";
      await adapter.createWorktree(context, {
        record: createWorktreeRecord(worktreeID), units: [createWorktreeUnitRecord({ worktreeID, unitID })],
      });
      const removed = { worktreeID, unitID, removed: true };
      expect((await adapter.setUnitRemoved(context, removed)).status).toBe("updated");
      expect((await adapter.setUnitRemoved(context, removed)).status).toBe("unchanged");
      const changeset = createChangeset({ unitID, type: UniverType.UNIVER_SHEET, revision: 2, sid: "remove-write", reqId: 1 });
      expect((await adapter.commitDraftChangeset(context, { unitMetadata: {}, worktreeID, changeset })).status).toBe("unit-frozen");
      expect((await adapter.setUnitRemoved(context, { ...removed, removed: false })).status).toBe("updated");
      expect((await adapter.commitDraftChangeset(context, { unitMetadata: {}, worktreeID, changeset })).status).toBe("committed");
      await adapter.setUnitRemoved(context, removed);
      await adapter.markReady(context, worktreeID);
      expect((await adapter.setUnitRemoved(context, { ...removed, removed: false })).status).toBe("not-editable");
      await adapter.startOrResumeMerge(context, worktreeID);
      await adapter.recordUnitMergeResult(context, { worktreeID, unitID, readyDraftHeadRevision: 2, mergeResult: { status: "removed" } });
      const finished = await adapter.finishMerge(context, worktreeID);
      expect(finished.status).toBe("transitioned");
      expect((await adapter.getWorktree(context, worktreeID))?.worktree.status).toBe("merged");
    });

    it("rejects terminal merge outcomes that contradict frozen removal intent", async () => {
      const context = createDatabaseContext();
      const worktreeID = "removal-result-contract";
      await adapter.createWorktree(context, {
        record: createWorktreeRecord(worktreeID),
        units: ["retained", "removed"].map(unitID => createWorktreeUnitRecord({ worktreeID, unitID })),
      });
      await adapter.setUnitRemoved(context, { worktreeID, unitID: "removed", removed: true });
      await adapter.markReady(context, worktreeID);
      await adapter.startOrResumeMerge(context, worktreeID);
      for (const [unitID, mergeResult] of [
        ["retained", { status: "removed" }],
        ["removed", { status: "unchanged" }],
        ["removed", { status: "merged", trunkRevision: 1 }],
      ] as const) {
        await expect(adapter.recordUnitMergeResult(context, {
          worktreeID, unitID, readyDraftHeadRevision: 1, mergeResult,
        })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        expect((await adapter.getWorktreeUnit(context, worktreeID, unitID))?.mergeResult).toBeUndefined();
      }
    });

    it("atomically creates a Worktree and all initial Units", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-create";
      const input = {
        record: createWorktreeRecord(worktreeID),
        units: [
          createWorktreeUnitRecord({
            worktreeID,
            unitID: "unit-a",
            baselineTrunkRevision: 4,
          }),
          createWorktreeUnitRecord({
            worktreeID,
            unitID: "unit-b",
            type: UniverType.UNIVER_DOC,
            baselineTrunkRevision: 9,
          }),
        ],
      };

      const [first, second] = await Promise.all([
        adapter.createWorktree(context, input),
        adapter.createWorktree(context, input),
      ]);

      expect([first.status, second.status].sort()).toEqual([
        "already-exists",
        "created",
      ]);
      const aggregate = await adapter.getWorktree(context, worktreeID);
      expect(aggregate?.worktree).toEqual(input.record);
      expect(aggregate?.units).toEqual(input.units);
    });

    it("does not publish a partial Worktree when initial Units are invalid", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-invalid-create";
      const duplicate = createWorktreeUnitRecord({
        worktreeID,
        unitID: "duplicate",
      });

      await expect(
        adapter.createWorktree(context, {
          record: createWorktreeRecord(worktreeID),
          units: [duplicate, duplicate],
        })
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(
        adapter.getWorktree(context, worktreeID)
      ).resolves.toBeNull();
    });

    it("adds Units only while draft and keeps duplicate retries idempotent", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-add";
      await createWorktree(adapter, worktreeID);
      const unit = createWorktreeUnitRecord({
        worktreeID,
        unitID: "unit-add",
        baselineTrunkRevision: 3,
      });

      await expect(
        adapter.addUnit(context, { unit })
      ).resolves.toMatchObject({ status: "added" });
      await adapter.markReady(context, worktreeID);
      await expect(
        adapter.addUnit(context, { unit })
      ).resolves.toMatchObject({ status: "already-exists" });
      await expect(
        adapter.addUnit(context, {
          unit: createWorktreeUnitRecord({
            worktreeID,
            unitID: "unit-late",
          }),
        })
      ).resolves.toMatchObject({ status: "status-mismatch" });
    });

    it("atomically creates a Worktree-sourced Unit with its immutable seed", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-create-unit";
      const unitID = "local-unit";
      await createWorktree(adapter, worktreeID);
      const input = {
        unit: createWorktreeUnitRecord({
          worktreeID,
          unitID,
          source: "worktree" as const,
        }),
        seed: createWorktreeUnitSeed(unitID),
      };

      const [first, second] = await Promise.all([
        adapter.createUnit(context, input),
        adapter.createUnit(context, input),
      ]);

      expect([first.status, second.status].sort()).toEqual([
        "already-created",
        "created",
      ]);
      await expect(
        adapter.getUnitSeed(context, worktreeID, unitID)
      ).resolves.toEqual(input.seed);
      await expect(
        adapter.getWorktreeUnit(context, worktreeID, unitID)
      ).resolves.toEqual(input.unit);

      await adapter.commitDraftChangeset(context, {
        unitMetadata: {},
        worktreeID,
        changeset: createChangeset({ unitID, type: input.unit.type, revision: 2, sid: "creation-facts", reqId: 1 }),
      });
      expect((await adapter.createUnit(context, {
        ...input,
        unit: { ...input.unit, creatorID: "another-user", createdAt: input.unit.createdAt + 1000 },
      })).status).toBe("already-created");
      await expect(adapter.getWorktreeUnit(context, worktreeID, unitID))
        .resolves.toEqual({ ...input.unit, draftHeadRevision: 2 });

      const returned = await adapter.getUnitSeed(context, worktreeID, unitID);
      if (!returned) throw new Error("Expected Worktree Unit seed");
      returned.snapshot.rev = 99;
      await expect(
        adapter.getUnitSeed(context, worktreeID, unitID)
      ).resolves.toEqual(input.seed);
    });

    it("round-trips binary PDF originalMeta through a Unit seed and merge artifact", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-pdf-binary";
      const unitID = "local-pdf";
      await createWorktree(adapter, worktreeID);
      const seed = createPdfWorktreeUnitSeed(unitID);
      await adapter.createUnit(context, {
        unit: createWorktreeUnitRecord({
          worktreeID,
          unitID,
          type: UniverType.UNIVER_PDF,
          source: "worktree",
        }),
        seed,
      });
      const storedSeed = await adapter.getUnitSeed(context, worktreeID, unitID);
      expect(storedSeed).toEqual(seed);
      expect(storedSeed?.snapshot.pdf?.originalMeta).toBeInstanceOf(Uint8Array);

      await adapter.markReady(context, worktreeID);
      await adapter.startOrResumeMerge(context, worktreeID);
      const artifact = {
        readyDraftHeadRevision: 1,
        unit: createPdfWorktreeUnitSeed(unitID),
      };
      await expect(
        adapter.saveUnitMergeArtifact(context, { worktreeID, unitID, artifact })
      ).resolves.toEqual({ status: "saved", artifact });
      const storedArtifact = await adapter.getUnitMergeArtifact(context, worktreeID, unitID);
      expect(storedArtifact).toEqual(artifact);
      expect(storedArtifact?.unit.snapshot.pdf?.originalMeta).toBeInstanceOf(Uint8Array);
    });

    it("does not reinterpret an attached or differently seeded Unit as a create retry", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-create-collision";
      const attachedID = "attached-unit";
      const localID = "local-unit";
      await createWorktree(adapter, worktreeID, attachedID);

      await expect(
        adapter.createUnit(context, {
          unit: createWorktreeUnitRecord({
            worktreeID,
            unitID: attachedID,
            source: "worktree",
          }),
          seed: createWorktreeUnitSeed(attachedID),
        })
      ).resolves.toMatchObject({ status: "unit-exists" });

      const local = createWorktreeUnitRecord({
        worktreeID,
        unitID: localID,
        source: "worktree",
      });
      await adapter.createUnit(context, {
        unit: local,
        seed: createWorktreeUnitSeed(localID),
      });
      await expect(
        adapter.createUnit(context, {
          unit: local,
          seed: {
            ...createWorktreeUnitSeed(localID),
            // TODO(@ai-review): Confirm a block-level seed difference remains a create collision for every adapter.
            sheetBlocks: [createSheetBlock("block-1", 2)],
          },
        })
      ).resolves.toMatchObject({ status: "unit-exists" });
    });

    it("rejects a new Worktree-sourced Unit outside draft", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-create-unit-ready";
      await createWorktree(adapter, worktreeID);
      await adapter.markReady(context, worktreeID);

      await expect(
        adapter.createUnit(context, {
          unit: createWorktreeUnitRecord({
            worktreeID,
            unitID: "late-unit",
            source: "worktree",
          }),
          seed: createWorktreeUnitSeed("late-unit"),
        })
      ).resolves.toMatchObject({ status: "status-mismatch" });
      await expect(
        adapter.getUnitSeed(context, worktreeID, "late-unit")
      ).resolves.toBeNull();
    });

    it("freezes one merge artifact and clears it after reopen", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-merge-artifact";
      const unitID = "local-artifact";
      await createWorktree(adapter, worktreeID);
      await adapter.createUnit(context, {
        unit: createWorktreeUnitRecord({
          worktreeID,
          unitID,
          source: "worktree",
        }),
        seed: createWorktreeUnitSeed(unitID),
      });
      await adapter.markReady(context, worktreeID);
      await adapter.startOrResumeMerge(context, worktreeID);
      const first = {
        readyDraftHeadRevision: 1,
        unit: createWorktreeUnitSeed(unitID),
      };
      const second = {
        readyDraftHeadRevision: 1,
        unit: {
          ...createWorktreeUnitSeed(unitID),
        },
      };

      await expect(
        adapter.saveUnitMergeArtifact(context, {
          worktreeID,
          unitID,
          artifact: first,
        })
      ).resolves.toEqual({ status: "saved", artifact: first });
      await expect(
        adapter.saveUnitMergeArtifact(context, {
          worktreeID,
          unitID,
          artifact: second,
        })
      ).resolves.toEqual({ status: "already-saved", artifact: first });
      await expect(
        adapter.getUnitMergeArtifact(context, worktreeID, unitID)
      ).resolves.toEqual(first);

      await adapter.recordUnitMergeResult(context, {
        worktreeID,
        unitID,
        readyDraftHeadRevision: 1,
        mergeResult: failure("TEMPORARY"),
      });
      await adapter.finishMerge(context, worktreeID);
      await adapter.reopenWorktree(context, worktreeID);
      await expect(
        adapter.getUnitMergeArtifact(context, worktreeID, unitID)
      ).resolves.toBeNull();
    });

    it("isolates the same unitID in different Worktrees", async () => {
      const context = createDatabaseContext();
      const firstID = "worktree-scope-a";
      const secondID = "worktree-scope-b";
      await createWorktree(adapter, firstID, "shared-unit");
      await createWorktree(adapter, secondID, "shared-unit");

      const first = createChangeset({
        unitID: "shared-unit",
        type: UniverType.UNIVER_SHEET,
        revision: 2,
        sid: "sid-scope",
        reqId: 1,
        marker: "first",
      });
      await adapter.commitDraftChangeset(context, {
        unitMetadata: {},
        worktreeID: firstID,
        changeset: first,
      });

      await expect(
        adapter.getDraftChangesets(context, firstID, "shared-unit", {
          from: 1,
        })
      ).resolves.toEqual([{ ...first, createTime: expect.any(Number) }]);
      await expect(
        adapter.getDraftChangesets(context, secondID, "shared-unit", {
          from: 1,
        })
      ).resolves.toEqual([]);
    });

    it("reads draft changesets in (from, to] from the trunk baseline", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-range";
      const unitID = "unit-range";
      await adapter.createWorktree(context, {
        record: createWorktreeRecord(worktreeID),
        units: [
          createWorktreeUnitRecord({
            worktreeID,
            unitID,
            baselineTrunkRevision: 3,
          }),
        ],
      });
      const revision4 = createChangeset({
        unitID,
        type: UniverType.UNIVER_SHEET,
        revision: 4,
        sid: "sid-range",
        reqId: 1,
      });
      const revision5 = createChangeset({
        unitID,
        type: UniverType.UNIVER_SHEET,
        revision: 5,
        sid: "sid-range",
        reqId: 2,
      });
      await adapter.commitDraftChangeset(context, {
        unitMetadata: {},
        worktreeID,
        changeset: revision4,
      });
      await adapter.commitDraftChangeset(context, {
        unitMetadata: {},
        worktreeID,
        changeset: revision5,
      });

      await expect(
        adapter.getDraftChangesets(context, worktreeID, unitID, {
          from: 3,
          to: 4,
        })
      ).resolves.toEqual([{ ...revision4, createTime: expect.any(Number) }]);
      await expect(
        adapter.getDraftChangesets(context, worktreeID, unitID, {
          from: 4,
        })
      ).resolves.toEqual([{ ...revision5, createTime: expect.any(Number) }]);
      for (const range of [{ from: 0 }, { from: 3, to: 99 }]) {
        await expect(adapter.getDraftChangesets(context, worktreeID, unitID, range))
          .resolves.toEqual([{ ...revision4, createTime: expect.any(Number) }, { ...revision5, createTime: expect.any(Number) }]);
      }
      await expect(adapter.getDraftChangesets(context, worktreeID, unitID, { from: 5 }))
        .resolves.toEqual([]);
      for (const [id, unit] of [["missing", unitID], [worktreeID, "missing"]] as const) {
        await expect(adapter.getDraftChangesets(context, id, unit, { from: 0 }))
          .resolves.toBeNull();
      }
      await expect(adapter.getDraftChangesets(context, worktreeID, unitID, { from: 0, to: 0 }))
        .resolves.toEqual([]);
    });

    it("rejects new draft submissions after markReady", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-not-editable";
      const unitID = "unit-not-editable";
      await createWorktree(adapter, worktreeID, unitID);
      await adapter.markReady(context, worktreeID);

      await expect(
        adapter.commitDraftChangeset(context, {
          unitMetadata: {},
          worktreeID,
          changeset: createChangeset({
            unitID,
            type: UniverType.UNIVER_SHEET,
            revision: 2,
            sid: "sid-not-editable",
            reqId: 1,
          }),
        })
      ).resolves.toEqual({
        status: "not-editable",
        worktreeStatus: "ready",
      });
    });

    it("allows one winner for the same draft head CAS", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-cas";
      const unitID = "unit-cas";
      await createWorktree(adapter, worktreeID, unitID);
      const first = createChangeset({
        unitID,
        type: UniverType.UNIVER_SHEET,
        revision: 2,
        sid: "sid-cas-a",
        reqId: 1,
      });
      const second = createChangeset({
        unitID,
        type: UniverType.UNIVER_SHEET,
        revision: 2,
        sid: "sid-cas-b",
        reqId: 1,
      });

      const results = await Promise.all([
        adapter.commitDraftChangeset(context, {
          unitMetadata: {},
          worktreeID,
          changeset: first,
        }),
        adapter.commitDraftChangeset(context, {
          unitMetadata: {},
          worktreeID,
          changeset: second,
        }),
      ]);

      expect(results.filter(({ status }) => status === "committed")).toHaveLength(
        1
      );
      expect(
        results.filter(({ status }) => status === "revision-mismatch")
      ).toEqual([{ status: "revision-mismatch", actualHeadRevision: 2 }]);
    });

    it("freezes draft heads and clears only unfinished results on reopen", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-reopen";
      const unitID = "unit-reopen";
      await createWorktree(adapter, worktreeID, unitID);
      await commitRevision2(adapter, worktreeID, unitID);

      await expect(
        adapter.markReady(context, worktreeID)
      ).resolves.toMatchObject({
        status: "transitioned",
        previousStatus: "draft",
        aggregate: {
          worktree: { status: "ready" },
          units: [{ draftHeadRevision: 2, readyDraftHeadRevision: 2 }],
        },
      });
      await adapter.startOrResumeMerge(context, worktreeID);
      await adapter.recordUnitMergeResult(context, {
        worktreeID,
        unitID,
        readyDraftHeadRevision: 2,
        mergeResult: failure("OT_CONFLICT"),
      });
      await adapter.finishMerge(context, worktreeID);

      const reopened = await adapter.reopenWorktree(context, worktreeID);
      expect(reopened).toMatchObject({
        status: "transitioned",
        previousStatus: "ready",
        aggregate: {
          worktree: { status: "draft" },
          units: [{ draftHeadRevision: 2 }],
        },
      });
      const unit = resultAggregate(reopened).units[0]!;
      expect(unit.readyDraftHeadRevision).toBeUndefined();
      expect(unit.mergeResult).toBeUndefined();
    });

    it("resumes merging and finishes partial results back at ready", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-merge";
      await createWorktree(adapter, worktreeID, "unit-a", "unit-b");
      await adapter.markReady(context, worktreeID);

      await expect(
        adapter.startOrResumeMerge(context, worktreeID)
      ).resolves.toMatchObject({ status: "started" });
      await expect(
        adapter.startOrResumeMerge(context, worktreeID)
      ).resolves.toMatchObject({ status: "resumed" });
      await adapter.recordUnitMergeResult(context, {
        worktreeID,
        unitID: "unit-a",
        readyDraftHeadRevision: 1,
        mergeResult: { status: "unchanged" },
      });
      await adapter.recordUnitMergeResult(context, {
        worktreeID,
        unitID: "unit-b",
        readyDraftHeadRevision: 1,
        mergeResult: failure("TEMPORARY"),
      });

      await expect(
        adapter.finishMerge(context, worktreeID)
      ).resolves.toMatchObject({
        status: "transitioned",
        aggregate: { worktree: { status: "ready" } },
      });
    });

    it("allows a later success to replace a non-terminal result", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-result-recovery";
      const unitID = "unit-result-recovery";
      await createWorktree(adapter, worktreeID, unitID);
      await adapter.markReady(context, worktreeID);
      await adapter.startOrResumeMerge(context, worktreeID);
      await adapter.recordUnitMergeResult(context, {
        worktreeID,
        unitID,
        readyDraftHeadRevision: 1,
        mergeResult: failure("TEMPORARY"),
      });

      await expect(
        adapter.recordUnitMergeResult(context, {
          worktreeID,
          unitID,
          readyDraftHeadRevision: 1,
          mergeResult: { status: "merged", trunkRevision: 12 },
        })
      ).resolves.toMatchObject({
        status: "recorded",
        aggregate: {
          worktree: { status: "merging" },
          units: [
            {
              unitID,
              mergeResult: { status: "merged", trunkRevision: 12 },
            },
          ],
        },
      });
      await expect(
        adapter.finishMerge(context, worktreeID)
      ).resolves.toMatchObject({
        status: "transitioned",
        aggregate: {
          worktree: { status: "merged" },
          units: [
            {
              mergeResult: { status: "merged", trunkRevision: 12 },
            },
          ],
        },
      });
      await expect(
        adapter.startOrResumeMerge(context, worktreeID)
      ).resolves.toMatchObject({ status: "already-merged" });
    });

    it("keeps successfully merged Units frozen after a partial merge is reopened", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-terminal-freeze";
      await createWorktree(adapter, worktreeID, "unit-merged", "unit-failed");
      await adapter.markReady(context, worktreeID);
      await adapter.startOrResumeMerge(context, worktreeID);
      await adapter.recordUnitMergeResult(context, {
        worktreeID,
        unitID: "unit-merged",
        readyDraftHeadRevision: 1,
        mergeResult: { status: "merged", trunkRevision: 8 },
      });
      await adapter.recordUnitMergeResult(context, {
        worktreeID,
        unitID: "unit-failed",
        readyDraftHeadRevision: 1,
        mergeResult: failure("TEMPORARY"),
      });
      await adapter.finishMerge(context, worktreeID);
      await adapter.reopenWorktree(context, worktreeID);

      await expect(
        adapter.commitDraftChangeset(context, {
          unitMetadata: {},
          worktreeID,
          changeset: createChangeset({
            unitID: "unit-merged",
            type: UniverType.UNIVER_SHEET,
            revision: 2,
            sid: "sid-frozen",
            reqId: 1,
          }),
        })
      ).resolves.toEqual({ status: "unit-frozen" });
    });

    it("rejects stale results and never overwrites terminal merge results", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-stale";
      const unitID = "unit-stale";
      await createWorktree(adapter, worktreeID, unitID);
      await adapter.markReady(context, worktreeID);
      await adapter.startOrResumeMerge(context, worktreeID);

      await expect(
        adapter.recordUnitMergeResult(context, {
          worktreeID,
          unitID,
          readyDraftHeadRevision: 2,
          mergeResult: { status: "unchanged" },
        })
      ).resolves.toEqual({ status: "stale-merge" });
      await expect(
        adapter.recordUnitMergeResult(context, {
          worktreeID,
          unitID,
          readyDraftHeadRevision: 1,
          mergeResult: { status: "unchanged" },
        })
      ).resolves.toMatchObject({
        status: "recorded",
        aggregate: {
          worktree: { status: "merging" },
          units: [
            {
              unitID,
              mergeResult: { status: "unchanged" },
            },
          ],
        },
      });
      await expect(
        adapter.recordUnitMergeResult(context, {
          worktreeID,
          unitID,
          readyDraftHeadRevision: 1,
          mergeResult: failure("LATE_FAILURE"),
        })
      ).resolves.toEqual({ status: "stale-merge" });
    });

    it("makes discard terminal and idempotent", async () => {
      const context = createDatabaseContext();
      const worktreeID = "worktree-discard";
      await createWorktree(adapter, worktreeID);

      await expect(
        adapter.discardWorktree(context, worktreeID)
      ).resolves.toMatchObject({
        status: "transitioned",
        aggregate: { worktree: { status: "discarded" } },
      });
      await expect(
        adapter.discardWorktree(context, worktreeID)
      ).resolves.toMatchObject({ status: "already-in-target" });
      await expect(
        adapter.markReady(context, worktreeID)
      ).resolves.toMatchObject({ status: "status-mismatch" });
    });
  });
}

async function createWorktree(
  adapter: IWorktreeDatabaseAdapter,
  worktreeID: string,
  ...unitIDs: readonly string[]
): Promise<void> {
  const context = createDatabaseContext();
  await adapter.createWorktree(context, {
    record: createWorktreeRecord(worktreeID),
    units: unitIDs.map((unitID) =>
      createWorktreeUnitRecord({ worktreeID, unitID })
    ),
  });
}

async function commitRevision2(
  adapter: IWorktreeDatabaseAdapter,
  worktreeID: string,
  unitID: string
): Promise<void> {
  await adapter.commitDraftChangeset(createDatabaseContext(), {
    unitMetadata: {},
    worktreeID,
    changeset: createChangeset({
      unitID,
      type: UniverType.UNIVER_SHEET,
      revision: 2,
      sid: "sid-revision-2",
      reqId: 1,
    }),
  });
}

function failure(code: string): WorktreeUnitMergeResult {
  return {
    status: code === "OT_CONFLICT" ? "conflict" : "failed",
    error: {
      code,
      message: code,
      retryable: true,
    },
  };
}

function resultAggregate(
  result: Awaited<ReturnType<IWorktreeDatabaseAdapter["reopenWorktree"]>>
): WorktreeAggregateRecord {
  if (result.status === "not-found") {
    throw new Error("Expected Worktree aggregate");
  }
  return result.aggregate;
}
