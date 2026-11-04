import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import type { CommentMemberDatabaseContext } from "@univerjs-pro/collaboration-comment-service";
import { CommentSolvedStatus } from "@univerjs/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteCommentDatabaseAdapter } from "../src/index.js";

const context = {
  userID: "user-1",
  memberID: "member-1",
  customData: {},
  request: { unitID: "unit-1", threadIDs: [] },
} as unknown as CommentMemberDatabaseContext;

function root() {
  return { unitID: "unit-1", threadID: "thread-1", authorUserID: "user-1", content: "root", mentions: [] };
}

describe("SQLiteCommentDatabaseAdapter", () => {
  let directory: string;
  let filename: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "univer-collab-comment-sqlite-"));
    filename = join(directory, "comments.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("requires a filename", () => {
    expect(() => new SQLiteCommentDatabaseAdapter({ filename: "" })).toThrow(TypeError);
  });

  it("registers its schema version next to other components without touching the rest of the file", async () => {
    const database = new Database(filename);
    database.exec(`
      PRAGMA user_version = 17;
      CREATE TABLE application_data (id TEXT PRIMARY KEY);
      CREATE TABLE collaboration_schema_versions (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1)
      );
      INSERT INTO collaboration_schema_versions (component, version) VALUES ('core', 3);
    `);
    database.close();

    const adapter = new SQLiteCommentDatabaseAdapter({ filename });
    await adapter.dispose();

    const inspect = new Database(filename);
    try {
      expect(inspect.prepare("SELECT component, version FROM collaboration_schema_versions ORDER BY component").all()).toMatchObject([
        { component: "comment", version: 1 },
        { component: "core", version: 3 },
      ]);
      expect(inspect.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 17 });
      expect(inspect.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "delete" });
      expect(inspect.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'application_data'").get()).toMatchObject({
        name: "application_data",
      });
    } finally {
      inspect.close();
    }
  });

  it("rejects a different comment schema version", () => {
    const database = new Database(filename);
    database.exec(`
      CREATE TABLE collaboration_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO collaboration_schema_versions (component, version) VALUES ('comment', 2);
    `);
    database.close();

    expect(() => new SQLiteCommentDatabaseAdapter({ filename })).toThrow(/version 2 is not supported/);
  });

  it("lets only one of two connections win an identical create", async () => {
    const first = new SQLiteCommentDatabaseAdapter({ filename });
    const second = new SQLiteCommentDatabaseAdapter({ filename });
    try {
      const roots = await Promise.all([first.createRoot(root(), context), second.createRoot(root(), context)]);
      expect(roots.map((result) => result.status).sort()).toEqual(["created", "duplicate"]);

      const replies = await Promise.all([
        first.createReply({ ...root(), replyID: "reply-1" }, context),
        second.createReply({ ...root(), replyID: "reply-1" }, context),
      ]);
      expect(replies.map((result) => result.status).sort()).toEqual(["created", "duplicate"]);
      expect(
        (await second.listThreads({ unitID: "unit-1", threadIDs: [] }, context)).map((record) => record.replyID),
      ).toEqual(["thread-1", "reply-1"]);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it("makes solve and delete decisions visible to another connection atomically", async () => {
    const first = new SQLiteCommentDatabaseAdapter({ filename });
    const second = new SQLiteCommentDatabaseAdapter({ filename });
    try {
      const created = await first.createRoot(root(), context);
      if (created.status !== "created") throw new Error("fixture failed");

      const [solved, lateReply] = await Promise.all([
        second.setThreadSolved({ unitID: "unit-1", threadID: "thread-1", solved: CommentSolvedStatus.Solved }, context),
        first.createReply({ ...root(), replyID: "reply-late" }, context),
      ]);
      expect(solved.status).toBe("updated");
      expect(lateReply.status).toBe("closed");

      await second.setThreadSolved({ unitID: "unit-1", threadID: "thread-1", solved: CommentSolvedStatus.OpenOrReOpen }, context);
      const reply = await first.createReply({ ...root(), replyID: "reply-edit", content: "before" }, context);
      if (reply.status !== "created") throw new Error("fixture failed");
      const [deleted, lateEdit] = await Promise.all([
        second.deleteComment({
          unitID: "unit-1", threadID: "thread-1", replyID: "reply-edit", expectedGeneration: reply.record.generation,
        }, context),
        first.editComment({
          unitID: "unit-1", threadID: "thread-1", replyID: "reply-edit",
          expectedAuthorUserID: "user-1", content: "after", mentions: [],
        }, context),
      ]);
      expect(deleted.status).toBe("deleted");
      expect(lateEdit.status).toBe("not-found");

      expect(
        (await second.deleteComment({ unitID: "unit-1", threadID: "thread-1", expectedGeneration: created.record.generation }, context)).status,
      ).toBe("deleted");
      const recreated = await first.createRoot(root(), context);
      if (recreated.status !== "created") throw new Error("fixture failed");
      expect(
        (await second.deleteComment({ unitID: "unit-1", threadID: "thread-1", expectedGeneration: created.record.generation }, context)).status,
      ).toBe("generation-mismatch");
      expect(
        (await first.getComment({ unitID: "unit-1", threadID: "thread-1", replyID: "thread-1" }, context))?.generation,
      ).toBe(recreated.record.generation);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
