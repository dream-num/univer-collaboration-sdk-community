import type {
  CommentMemberDatabaseContext,
  ICommentDatabaseAdapter,
} from "@univerjs-pro/collaboration-comment-service";
import { CommentSolvedStatus } from "@univerjs/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

export interface CommentDatabaseAdapterHarness {
  readonly adapter: ICommentDatabaseAdapter;
  dispose?(): void | Promise<void>;
}

export type CommentDatabaseAdapterHarnessFactory = () =>
  | CommentDatabaseAdapterHarness
  | Promise<CommentDatabaseAdapterHarness>;

// Adapters receive the context for logging and extension; the contract never reads it back.
const context = {
  userID: "user-1",
  memberID: "member-1",
  customData: {},
  request: { unitID: "unit-1", threadIDs: [] },
} as unknown as CommentMemberDatabaseContext;

function root(unitID = "unit-1", threadID = "thread-1") {
  return {
    unitID,
    threadID,
    authorUserID: "user-1",
    content: "root",
    mentions: ["mentioned-1"],
  };
}

/** Registers the complete Thread Comment persistence contract in the caller's suite. */
export function commentDatabaseAdapterContract(
  name: string,
  createHarness: CommentDatabaseAdapterHarnessFactory,
): void {
  describe(`${name} ICommentDatabaseAdapter contract`, () => {
    let harness: CommentDatabaseAdapterHarness;
    let adapter: ICommentDatabaseAdapter;

    beforeEach(async () => {
      harness = await createHarness();
      adapter = harness.adapter;
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.dispose?.();
    });

    it("creates a root and its replies, lists the root first and isolates returned records", async () => {
      vi.spyOn(Date, "now").mockReturnValue(100);
      const created = await adapter.createRoot(root(), context);
      expect(created.status).toBe("created");
      if (created.status !== "created") return;
      expect(created.record.replyID).toBe("thread-1");
      expect(created.record.generation).not.toBe("");
      expect((await adapter.createRoot(root(), context)).status).toBe("duplicate");

      await adapter.createReply({ ...root(), replyID: "reply-b", content: "b" }, context);
      await adapter.createReply({ ...root(), replyID: "reply-a", content: "a" }, context);
      const listed = await adapter.listThreads({ unitID: "unit-1", threadIDs: [] }, context);
      expect(listed.map((item) => item.replyID)).toEqual(["thread-1", "reply-a", "reply-b"]);
      (listed[0]!.mentions as string[]).push("mutated");
      expect(
        (await adapter.getComment({ unitID: "unit-1", threadID: "thread-1", replyID: "thread-1" }, context))?.mentions,
      ).toEqual(["mentioned-1"]);
    });

    it("isolates Units, deduplicates thread filters and omits unknown thread IDs", async () => {
      await adapter.createRoot(root("unit-1", "thread-1"), context);
      await adapter.createRoot(root("unit-2", "thread-1"), context);
      await adapter.createRoot(root("unit-1", "thread-2"), context);
      const listed = await adapter.listThreads(
        { unitID: "unit-1", threadIDs: ["thread-2", "thread-2", "missing"] },
        context,
      );
      expect(listed.map((item) => item.threadID)).toEqual(["thread-2"]);
    });

    it("accepts replies and edits only on open threads and edits only by the author", async () => {
      await adapter.createRoot(root(), context);
      expect((await adapter.createReply({ ...root(), replyID: "reply-1" }, context)).status).toBe("created");
      expect(
        (await adapter.editComment({
          unitID: "unit-1", threadID: "thread-1", replyID: "reply-1",
          expectedAuthorUserID: "user-2", content: "edit", mentions: [],
        }, context)).status,
      ).toBe("author-mismatch");
      expect(
        (await adapter.setThreadSolved({
          unitID: "unit-1", threadID: "thread-1", solved: CommentSolvedStatus.Solved,
        }, context)).status,
      ).toBe("updated");
      expect((await adapter.createReply({ ...root(), replyID: "reply-2" }, context)).status).toBe("closed");
      expect(
        (await adapter.editComment({
          unitID: "unit-1", threadID: "thread-1", replyID: "reply-1",
          expectedAuthorUserID: "user-1", content: "edit", mentions: [],
        }, context)).status,
      ).toBe("closed");
    });

    it("lets exactly one of two concurrent identical creates win", async () => {
      const roots = await Promise.all([
        adapter.createRoot(root(), context),
        adapter.createRoot(root(), context),
      ]);
      expect(roots.map((result) => result.status).sort()).toEqual(["created", "duplicate"]);

      const replies = await Promise.all([
        adapter.createReply({ ...root(), replyID: "reply-1" }, context),
        adapter.createReply({ ...root(), replyID: "reply-1" }, context),
      ]);
      expect(replies.map((result) => result.status).sort()).toEqual(["created", "duplicate"]);
      expect(
        (await adapter.listThreads({ unitID: "unit-1", threadIDs: [] }, context)).map((record) => record.replyID),
      ).toEqual(["thread-1", "reply-1"]);
    });

    it("keeps replies and edits that race with solve or delete atomic", async () => {
      const created = await adapter.createRoot(root(), context);
      if (created.status !== "created") throw new Error("fixture failed");

      const [reply, solved] = await Promise.all([
        adapter.createReply({ ...root(), replyID: "reply-1", content: "reply" }, context),
        adapter.setThreadSolved({
          unitID: "unit-1", threadID: "thread-1", solved: CommentSolvedStatus.Solved,
        }, context),
      ]);
      expect(solved.status).toBe("updated");
      expect(["created", "closed"]).toContain(reply.status);
      const afterSolve = await adapter.listThreads({ unitID: "unit-1", threadIDs: [] }, context);
      expect(afterSolve[0]?.solved).toBe(CommentSolvedStatus.Solved);
      expect(afterSolve.some((record) => record.replyID === "reply-1")).toBe(reply.status === "created");

      await adapter.setThreadSolved({
        unitID: "unit-1", threadID: "thread-1", solved: CommentSolvedStatus.OpenOrReOpen,
      }, context);
      const editTarget = await adapter.createReply({ ...root(), replyID: "reply-edit", content: "before" }, context);
      if (editTarget.status !== "created") throw new Error("fixture failed");
      const [edit, deleted] = await Promise.all([
        adapter.editComment({
          unitID: "unit-1", threadID: "thread-1", replyID: "reply-edit",
          expectedAuthorUserID: "user-1", content: "after", mentions: [],
        }, context),
        adapter.deleteComment({
          unitID: "unit-1", threadID: "thread-1", replyID: "reply-edit",
          expectedGeneration: editTarget.record.generation,
        }, context),
      ]);
      expect(["edited", "not-found"]).toContain(edit.status);
      expect(deleted.status).toBe("deleted");
      expect(
        await adapter.getComment({ unitID: "unit-1", threadID: "thread-1", replyID: "reply-edit" }, context),
      ).toBeNull();

      const [lateReply, rootDelete] = await Promise.all([
        adapter.createReply({ ...root(), replyID: "reply-late" }, context),
        adapter.deleteComment({
          unitID: "unit-1", threadID: "thread-1", expectedGeneration: created.record.generation,
        }, context),
      ]);
      expect(["created", "not-found"]).toContain(lateReply.status);
      expect(rootDelete.status).toBe("deleted");
      expect(await adapter.listThreads({ unitID: "unit-1", threadIDs: [] }, context)).toEqual([]);
    });

    it("deletes a reply or a whole thread only with the current generation", async () => {
      const first = await adapter.createRoot(root(), context);
      if (first.status !== "created") throw new Error("fixture failed");
      const reply = await adapter.createReply({ ...root(), replyID: "reply-1" }, context);
      if (reply.status !== "created") throw new Error("fixture failed");
      expect(
        (await adapter.deleteComment({
          unitID: "unit-1", threadID: "thread-1", replyID: "reply-1",
          expectedGeneration: reply.record.generation,
        }, context)).status,
      ).toBe("deleted");
      expect(
        await adapter.getComment({ unitID: "unit-1", threadID: "thread-1", replyID: "thread-1" }, context),
      ).not.toBeNull();

      expect(
        (await adapter.deleteComment({
          unitID: "unit-1", threadID: "thread-1", expectedGeneration: "stale",
        }, context)).status,
      ).toBe("generation-mismatch");
      expect(
        (await adapter.deleteComment({
          unitID: "unit-1", threadID: "thread-1", expectedGeneration: first.record.generation,
        }, context)).status,
      ).toBe("deleted");
      expect(await adapter.listThreads({ unitID: "unit-1", threadIDs: [] }, context)).toEqual([]);

      // A recreated thread gets a new generation, so a stale generation cannot delete it.
      const recreated = await adapter.createRoot(root(), context);
      expect(recreated.status).toBe("created");
      if (recreated.status !== "created") return;
      expect(recreated.record.generation).not.toBe(first.record.generation);
      expect(
        (await adapter.deleteComment({
          unitID: "unit-1", threadID: "thread-1", expectedGeneration: first.record.generation,
        }, context)).status,
      ).toBe("generation-mismatch");
      expect(
        await adapter.getComment({ unitID: "unit-1", threadID: "thread-1", replyID: "thread-1" }, context),
      ).not.toBeNull();
    });
  });
}
