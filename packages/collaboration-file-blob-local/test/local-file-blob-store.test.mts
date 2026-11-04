import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileBlobStoreContract } from "@univerjs-pro/collaboration-file-blob-testkit";
import { FileError } from "@univerjs-pro/collaboration-file-service";
import { describe, expect, it } from "vitest";
import { LocalFileBlobStore } from "../src/index.js";

fileBlobStoreContract("Local", async () => {
  const directory = await mkdtemp(join(tmpdir(), "univer-collab-file-blob-local-"));
  const store = new LocalFileBlobStore({ directory });
  return {
    store,
    countObjects: async () => (await readdir(directory)).length,
    dispose: async () => {
      await store.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
});

const context = { userID: "u", customData: {}, request: { fileID: "f" } };

describe("LocalFileBlobStore", () => {
  it("stores objects under the fileID and rejects names that would escape the directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "univer-collab-file-blob-local-"));
    try {
      const store = new LocalFileBlobStore({ directory: join(directory, "nested") });
      const put = await store.put(
        { fileID: "abc-1", contentType: "text/plain", content: (async function* () { yield new TextEncoder().encode("x"); })() },
        context
      );
      expect(put.blobKey).toBe("abc-1");
      expect(await readdir(join(directory, "nested"))).toEqual(["abc-1"]);
      const error = await store
        .put({ fileID: "../evil", contentType: "text/plain", content: (async function* () {})() }, context)
        .catch((reason: unknown) => reason);
      expect((error as FileError).code).toBe("INVALID_REQUEST");
      expect(((await store.open("../abc-1", context).catch((reason: unknown) => reason)) as FileError).code).toBe("FILE_NOT_FOUND");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
