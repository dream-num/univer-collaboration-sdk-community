import {
  FileError,
  type FileDatabaseContext,
  type FileRecord,
  type IFileDatabaseAdapter,
} from "@univerjs-pro/collaboration-file-service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export interface FileDatabaseAdapterHarness {
  readonly adapter: IFileDatabaseAdapter;
  dispose?(): void | Promise<void>;
}

export type FileDatabaseAdapterHarnessFactory = () =>
  | FileDatabaseAdapterHarness
  | Promise<FileDatabaseAdapterHarness>;

const context: FileDatabaseContext = {
  userID: "user-1",
  customData: Object.create(null),
  request: { fileID: "contract" },
};

function record(fileID: string, overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    fileID,
    name: `${fileID}.png`,
    size: 3,
    contentType: "image/png",
    source: 3,
    assign: "unit-1",
    blobKey: `blob-${fileID}`,
    createdAt: 1_000,
    ...overrides,
  };
}

async function expectFileError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(FileError);
  expect((error as FileError).code).toBe(code);
}

/**
 * Registers the complete file metadata contract in the caller's suite. Records are stored one to
 * one with their content, so `delete` always releases the record's own `blobKey`.
 */
export function fileDatabaseAdapterContract(
  name: string,
  createHarness: FileDatabaseAdapterHarnessFactory,
): void {
  describe(`${name} IFileDatabaseAdapter contract`, () => {
    let harness: FileDatabaseAdapterHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.dispose?.();
    });

    async function create(): Promise<IFileDatabaseAdapter> {
      return harness.adapter;
    }

    it("stores and reads back every field", async () => {
      const adapter = await create();
      const stored = record("file-a", {
        name: "Übersicht 2026.xlsx",
        size: 0,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        source: 2,
        assign: "user-9",
        createdAt: 1_762_000_000_123,
      });
      await adapter.create(stored, context);
      expect(await adapter.get("file-a", context)).toEqual(stored);
    });

    it("keeps unknown source values as they are", async () => {
      const adapter = await create();
      await adapter.create(record("zero", { source: 0, assign: "" }), context);
      await adapter.create(record("other", { source: 99 }), context);
      expect((await adapter.get("zero", context))?.source).toBe(0);
      expect((await adapter.get("other", context))?.source).toBe(99);
    });

    it("rejects a duplicate fileID with INVALID_REQUEST and keeps the first record", async () => {
      const adapter = await create();
      await adapter.create(record("dup"), context);
      await expectFileError(adapter.create(record("dup", { name: "second" }), context), "INVALID_REQUEST");
      expect((await adapter.get("dup", context))?.name).toBe("dup.png");
    });

    it("returns null for a missing record", async () => {
      const adapter = await create();
      expect(await adapter.get("missing", context)).toBeNull();
      expect(await adapter.delete("missing", context)).toBeNull();
    });

    it("deletes a record and releases its blobKey", async () => {
      const adapter = await create();
      const stored = record("gone");
      await adapter.create(stored, context);
      expect(await adapter.delete("gone", context)).toEqual({ record: stored, releasedBlobKey: stored.blobKey });
      expect(await adapter.get("gone", context)).toBeNull();
      expect(await adapter.delete("gone", context)).toBeNull();
    });

    it("lists by source, assign and exclusive createdBefore", async () => {
      const adapter = await create();
      await adapter.create(record("a", { source: 1, assign: "u1", createdAt: 10 }), context);
      await adapter.create(record("b", { source: 1, assign: "u2", createdAt: 20 }), context);
      await adapter.create(record("c", { source: 1, assign: "u1", createdAt: 30 }), context);
      await adapter.create(record("d", { source: 2, assign: "u1", createdAt: 5 }), context);

      const bySource = await adapter.list({ source: 1, limit: 10 }, context);
      expect(bySource.records.map((item) => item.fileID)).toEqual(["a", "b", "c"]);
      expect(bySource.nextCursor).toBeNull();

      const byAssign = await adapter.list({ source: 1, assign: "u1", limit: 10 }, context);
      expect(byAssign.records.map((item) => item.fileID)).toEqual(["a", "c"]);

      const before = await adapter.list({ source: 1, createdBefore: 30, limit: 10 }, context);
      expect(before.records.map((item) => item.fileID)).toEqual(["a", "b"]);
    });

    it("orders by (createdAt, fileID) and pages with an opaque cursor", async () => {
      const adapter = await create();
      const ids = ["e", "c", "a", "d", "b"];
      for (const fileID of ids) await adapter.create(record(fileID, { createdAt: fileID < "c" ? 2 : 1 }), context);
      // createdAt 1: c d e; createdAt 2: a b
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await adapter.list({ source: 3, limit: 2, ...(cursor === undefined ? {} : { cursor }) }, context);
        expect(page.records.length).toBeLessThanOrEqual(2);
        seen.push(...page.records.map((item) => item.fileID));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
        expect(pages).toBeLessThan(10);
      } while (cursor !== undefined);
      expect(seen).toEqual(["c", "d", "e", "a", "b"]);
    });

    it("keeps the cursor stable when earlier records are deleted between pages", async () => {
      const adapter = await create();
      for (let index = 0; index < 5; index += 1) {
        await adapter.create(record(`f${index}`, { createdAt: 100 + index }), context);
      }
      const first = await adapter.list({ source: 3, limit: 2 }, context);
      expect(first.records.map((item) => item.fileID)).toEqual(["f0", "f1"]);
      await adapter.delete("f0", context);
      await adapter.delete("f1", context);
      const second = await adapter.list({ source: 3, limit: 2, cursor: first.nextCursor! }, context);
      expect(second.records.map((item) => item.fileID)).toEqual(["f2", "f3"]);
    });

    it("rejects a cursor it cannot decode with INVALID_REQUEST", async () => {
      const adapter = await create();
      await expectFileError(adapter.list({ source: 3, limit: 1, cursor: "not-a-cursor" }, context), "INVALID_REQUEST");
    });

    it("returns an empty page without a cursor when nothing matches", async () => {
      const adapter = await create();
      expect(await adapter.list({ source: 1, limit: 5 }, context)).toEqual({ records: [], nextCursor: null });
    });
  });
}
