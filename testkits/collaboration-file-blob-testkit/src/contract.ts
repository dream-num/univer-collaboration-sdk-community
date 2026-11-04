import {
  FileError,
  type FileBlobContext,
  type FileContent,
  type FileRecord,
  type IFileBlobStore,
} from "@univerjs-pro/collaboration-file-service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export interface FileBlobStoreHarness {
  readonly store: IFileBlobStore;
  /**
   * Optional. Number of stored objects, used to check that a failed `put` leaves no partial
   * object behind. Harnesses that cannot count skip that assertion.
   */
  countObjects?(): Promise<number>;
  dispose?(): void | Promise<void>;
}

export type FileBlobStoreHarnessFactory = () => FileBlobStoreHarness | Promise<FileBlobStoreHarness>;

const context: FileBlobContext = {
  userID: "user-1",
  customData: Object.create(null),
  request: { fileID: "contract" },
};

const encoder = new TextEncoder();

async function* chunks(...parts: string[]): FileContent {
  for (const part of parts) yield encoder.encode(part);
}

async function* failingAfter(part: string): FileContent {
  yield encoder.encode(part);
  throw new Error("client went away");
}

async function readAll(content: FileContent): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of content) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

async function expectFileError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(FileError);
  expect((error as FileError).code).toBe(code);
}

function recordFor(fileID: string, blobKey: string): FileRecord {
  return {
    fileID,
    name: `${fileID}.txt`,
    size: 5,
    contentType: "text/plain",
    source: 3,
    assign: "unit-1",
    blobKey,
    createdAt: Date.now(),
  };
}

/** Registers the complete file content contract in the caller's suite. */
export function fileBlobStoreContract(name: string, createHarness: FileBlobStoreHarnessFactory): void {
  describe(`${name} IFileBlobStore contract`, () => {
    let harness: FileBlobStoreHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.dispose?.();
    });

    async function create(): Promise<FileBlobStoreHarness> {
      return harness;
    }

    it("writes a multi-chunk stream and reports the bytes actually written", async () => {
      const { store } = await create();
      const put = await store.put({ fileID: "file-a", contentType: "text/plain", content: chunks("he", "llo", " 世界") }, context);
      expect(put.blobKey).not.toBe("");
      expect(put.size).toBe(encoder.encode("hello 世界").byteLength);
      expect(await readAll(await store.open(put.blobKey, context))).toBe("hello 世界");
    });

    it("accepts empty content", async () => {
      const { store } = await create();
      const put = await store.put({ fileID: "empty", contentType: "application/octet-stream", content: chunks() }, context);
      expect(put.size).toBe(0);
      expect(await readAll(await store.open(put.blobKey, context))).toBe("");
    });

    it("gives different files different blobKeys", async () => {
      const { store } = await create();
      const a = await store.put({ fileID: "file-a", contentType: "text/plain", content: chunks("a") }, context);
      const b = await store.put({ fileID: "file-b", contentType: "text/plain", content: chunks("b") }, context);
      expect(a.blobKey).not.toBe(b.blobKey);
      expect(await readAll(await store.open(a.blobKey, context))).toBe("a");
      expect(await readAll(await store.open(b.blobKey, context))).toBe("b");
    });

    it("throws FILE_NOT_FOUND when opening a missing key", async () => {
      const { store } = await create();
      await expectFileError(store.open("missing-key", context), "FILE_NOT_FOUND");
    });

    it("deletes content and treats a missing key as success", async () => {
      const { store } = await create();
      const put = await store.put({ fileID: "gone", contentType: "text/plain", content: chunks("x") }, context);
      await store.delete(put.blobKey, context);
      await expectFileError(store.open(put.blobKey, context), "FILE_NOT_FOUND");
      await expect(store.delete(put.blobKey, context)).resolves.toBeUndefined();
      await expect(store.delete("never-existed", context)).resolves.toBeUndefined();
    });

    it("rejects when the content stream fails and leaves no partial object", async () => {
      const harness = await create();
      const before = await harness.countObjects?.();
      await expect(
        harness.store.put({ fileID: "broken", contentType: "text/plain", content: failingAfter("partial") }, context)
      ).rejects.toThrow();
      if (before !== undefined) expect(await harness.countObjects!()).toBe(before);
    });

    it("signs a direct URL with a future expiry when the optional method returns one", async () => {
      const { store } = await create();
      if (!store.signUrl) return;
      const put = await store.put({ fileID: "signed", contentType: "text/plain", content: chunks("hello") }, context);
      const direct = await store.signUrl({ blobKey: put.blobKey, record: recordFor("signed", put.blobKey) }, context);
      if (direct === null) return;
      expect(() => new URL(direct.url)).not.toThrow();
      expect(direct.expiresAt).toBeGreaterThan(Date.now());
    });
  });
}
