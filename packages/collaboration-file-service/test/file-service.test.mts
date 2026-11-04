import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileError,
  UniverFileService,
  type DeleteFileDatabaseResult,
  type FileBlobContext,
  type FileContent,
  type FileDatabaseContext,
  type FileRecord,
  type IFileBlobStore,
  type IFileDatabaseAdapter,
  type ListFilesQuery,
  type ListFilesResult,
} from "../src/index.js";

// Minimal adapters for these tests; file-memory depends on this package, so this package does not depend on it.
class FakeDatabase implements IFileDatabaseAdapter {
  readonly records = new Map<string, FileRecord>();
  readonly contexts: FileDatabaseContext[] = [];
  failCreate: unknown;
  failDelete = new Set<string>();
  releaseNothing = false;

  async create(record: FileRecord, context: FileDatabaseContext): Promise<void> {
    this.contexts.push(context);
    if (this.failCreate) throw this.failCreate;
    if (this.records.has(record.fileID)) throw new FileError("INVALID_REQUEST", "duplicate");
    this.records.set(record.fileID, record);
  }

  async get(fileID: string, context: FileDatabaseContext): Promise<FileRecord | null> {
    this.contexts.push(context);
    return this.records.get(fileID) ?? null;
  }

  async delete(fileID: string, context: FileDatabaseContext): Promise<DeleteFileDatabaseResult | null> {
    this.contexts.push(context);
    if (this.failDelete.has(fileID)) throw new Error(`cannot delete ${fileID}`);
    const record = this.records.get(fileID);
    if (!record) return null;
    this.records.delete(fileID);
    return { record, releasedBlobKey: this.releaseNothing ? null : record.blobKey };
  }

  async list(query: ListFilesQuery, context: FileDatabaseContext): Promise<ListFilesResult> {
    this.contexts.push(context);
    const sorted = [...this.records.values()]
      .filter((item) => item.source === query.source)
      .filter((item) => query.assign === undefined || item.assign === query.assign)
      .filter((item) => query.createdBefore === undefined || item.createdAt < query.createdBefore)
      .sort((a, b) => a.createdAt - b.createdAt || (a.fileID < b.fileID ? -1 : 1));
    // Keyset cursor: paging continues after the last record of the previous page even when records were deleted.
    const after = query.cursor === undefined ? undefined : (JSON.parse(query.cursor) as [number, string]);
    const remaining = after
      ? sorted.filter((item) => item.createdAt > after[0] || (item.createdAt === after[0] && item.fileID > after[1]))
      : sorted;
    const records = remaining.slice(0, query.limit);
    const last = records.at(-1);
    return {
      records,
      nextCursor: remaining.length > query.limit && last ? JSON.stringify([last.createdAt, last.fileID]) : null,
    };
  }

  async dispose(): Promise<void> {}
}

class FakeBlobStore implements IFileBlobStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly contexts: FileBlobContext[] = [];
  readonly deleted: string[] = [];
  failDelete = false;
  direct: { url: string; expiresAt: number } | null | undefined;
  signUrl?: IFileBlobStore["signUrl"];

  constructor(options: { signing?: boolean } = {}) {
    if (options.signing) {
      this.signUrl = async (_input, context) => {
        this.contexts.push(context);
        return this.direct ?? null;
      };
    }
  }

  async put(input: { fileID: string; content: FileContent }, context: FileBlobContext) {
    this.contexts.push(context);
    const parts: Uint8Array[] = [];
    for await (const chunk of input.content) parts.push(chunk);
    const bytes = Buffer.concat(parts);
    const blobKey = `blob/${input.fileID}`;
    this.objects.set(blobKey, bytes);
    return { blobKey, size: bytes.byteLength };
  }

  async open(blobKey: string, context: FileBlobContext): Promise<FileContent> {
    this.contexts.push(context);
    const bytes = this.objects.get(blobKey);
    if (!bytes) throw new FileError("FILE_NOT_FOUND", "missing");
    return (async function* () {
      yield bytes;
    })();
  }

  async delete(blobKey: string, context: FileBlobContext): Promise<void> {
    this.contexts.push(context);
    if (this.failDelete) throw new Error("object store down");
    this.deleted.push(blobKey);
    this.objects.delete(blobKey);
  }

  async dispose(): Promise<void> {}
}

const encoder = new TextEncoder();
async function* bytes(...parts: string[]): FileContent {
  for (const part of parts) yield encoder.encode(part);
}

async function text(content: FileContent): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const chunk of content) parts.push(chunk);
  return Buffer.concat(parts).toString("utf8");
}

async function rejection(promise: Promise<unknown>): Promise<FileError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(FileError);
  return error as FileError;
}

const logger = { warn: vi.fn(), error: vi.fn() };

function setup(options: { signing?: boolean } = {}) {
  const database = new FakeDatabase();
  const blobStore = new FakeBlobStore(options);
  const service = new UniverFileService({ database, blobStore, logger });
  return { database, blobStore, service };
}

function upload(overrides: Partial<Parameters<UniverFileService["upload"]>[0]> = {}) {
  return {
    name: "image.png",
    contentType: "image/png",
    source: 3,
    assign: "unit-1",
    flate: false,
    content: bytes("png-bytes"),
    ...overrides,
  };
}

const alice = { userID: "alice" };
const bob = { userID: "bob" };

afterEach(() => {
  vi.useRealTimers();
  logger.warn.mockReset();
  logger.error.mockReset();
});

describe("UniverFileService construction", () => {
  it("requires both adapters", () => {
    const database = new FakeDatabase();
    const blobStore = new FakeBlobStore();
    expect(() => new UniverFileService({ blobStore } as never)).toThrow(TypeError);
    expect(() => new UniverFileService({ database } as never)).toThrow(TypeError);
  });

  it("requires a cleanup identity when the timer is enabled", () => {
    expect(
      () =>
        new UniverFileService({
          database: new FakeDatabase(),
          blobStore: new FakeBlobStore(),
          cleanup: { context: { userID: "" } },
        })
    ).toThrow(TypeError);
  });
});

describe("upload", () => {
  it("writes content first, records the actual size and hands the same context to both adapters", async () => {
    const { database, blobStore, service } = setup();
    const customData = { trace: "t-1" };
    const record = await service.upload(upload({ size: 999, content: bytes("ab", "cd") }), { userID: "alice", customData });
    expect(record).toMatchObject({ name: "image.png", size: 4, source: 3, assign: "unit-1", blobKey: `blob/${record.fileID}` });
    expect(record.fileID).toMatch(/^[0-9a-f-]{36}$/);
    expect(database.records.get(record.fileID)).toEqual(record);
    const [blobContext] = blobStore.contexts;
    const [databaseContext] = database.contexts;
    expect(blobContext).toBe(databaseContext);
    expect(blobContext!.customData).toBe(customData);
    expect(blobContext!.request).toMatchObject({ source: 3, assign: "unit-1", size: 999 });
  });

  it("forces assign to the uploader for HttpImport and HttpExport", async () => {
    const { service } = setup();
    expect((await service.upload(upload({ source: 1, assign: "someone-else" }), alice)).assign).toBe("alice");
    expect((await service.upload(upload({ source: 2, assign: "" }), alice)).assign).toBe("alice");
  });

  it("stores a non-integer source as 0", async () => {
    const { service } = setup();
    expect((await service.upload(upload({ source: 1.5 }), alice)).source).toBe(0);
  });

  it("rejects UnitEmbedded without a unitID", async () => {
    const { blobStore, service } = setup();
    expect((await rejection(service.upload(upload({ assign: "" }), alice))).code).toBe("INVALID_REQUEST");
    expect(blobStore.objects.size).toBe(0);
  });

  it("runs upload middleware on a frozen request before any byte is read", async () => {
    const { blobStore, service } = setup();
    let read = false;
    const content = (async function* () {
      read = true;
      yield encoder.encode("x");
    })();
    service.use("upload", async (ctx, next) => {
      expect(read).toBe(false);
      expect(Object.isFrozen(ctx.request)).toBe(true);
      expect(ctx.request).toEqual({ name: "image.png", contentType: "image/png", source: 3, assign: "unit-1", flate: false });
      if (ctx.userID === "bob") throw new FileError("PERMISSION_DENIED", "no edit right");
      await next();
    });
    expect((await rejection(service.upload(upload({ content }), bob))).code).toBe("PERMISSION_DENIED");
    expect(read).toBe(false);
    expect(blobStore.objects.size).toBe(0);
    await service.upload(upload(), alice);
  });

  it("removes the written content when the metadata write fails", async () => {
    const { database, blobStore, service } = setup();
    database.failCreate = new Error("db down");
    const error = await rejection(service.upload(upload(), alice));
    expect(error.code).toBe("STORAGE_FAILURE");
    expect(error.cause).toBeInstanceOf(Error);
    expect(blobStore.objects.size).toBe(0);
    expect(blobStore.deleted).toHaveLength(1);
  });

  it("logs an orphan when the compensating delete also fails", async () => {
    const { database, blobStore, service } = setup();
    database.failCreate = new FileError("INVALID_REQUEST", "duplicate");
    blobStore.failDelete = true;
    expect((await rejection(service.upload(upload(), alice))).code).toBe("INVALID_REQUEST");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Orphan"), expect.objectContaining({ blobKey: expect.any(String) }));
  });
});

describe("signUrl and openDownload", () => {
  it("only lets the owner reach HttpImport and HttpExport files", async () => {
    const { service } = setup();
    const record = await service.upload(upload({ source: 2 }), alice);
    expect((await service.signUrl({ fileID: record.fileID }, alice)).record.fileID).toBe(record.fileID);
    expect((await rejection(service.signUrl({ fileID: record.fileID }, bob))).code).toBe("PERMISSION_DENIED");
    expect((await rejection(service.openDownload({ fileID: record.fileID }, bob))).code).toBe("PERMISSION_DENIED");
  });

  it("reports FILE_NOT_FOUND for an unknown fileID", async () => {
    const { service } = setup();
    expect((await rejection(service.signUrl({ fileID: "missing" }, alice))).code).toBe("FILE_NOT_FOUND");
  });

  it("returns a direct link only when the blob store signs one", async () => {
    const signing = setup({ signing: true });
    const record = await signing.service.upload(upload(), alice);
    expect((await signing.service.signUrl({ fileID: record.fileID }, alice)).direct).toBeUndefined();
    signing.blobStore.direct = { url: "https://cdn.example.com/a", expiresAt: 2 };
    expect((await signing.service.signUrl({ fileID: record.fileID }, alice)).direct).toEqual(signing.blobStore.direct);

    const plain = setup();
    const other = await plain.service.upload(upload(), alice);
    expect((await plain.service.signUrl({ fileID: other.fileID }, alice)).direct).toBeUndefined();
  });

  it("passes the record to signUrl and download middleware and lets them deny", async () => {
    const { service } = setup();
    const record = await service.upload(upload(), alice);
    const seen: string[] = [];
    service.use("signUrl", async (ctx, next) => {
      seen.push(`sign:${ctx.record.fileID}`);
      await next();
    });
    service.use("download", async (ctx) => {
      seen.push(`download:${ctx.request.fileID}`);
      throw new FileError("PERMISSION_DENIED", "no view right");
    });
    await service.signUrl({ fileID: record.fileID }, bob);
    expect((await rejection(service.openDownload({ fileID: record.fileID }, bob))).code).toBe("PERMISSION_DENIED");
    expect(seen).toEqual([`sign:${record.fileID}`, `download:${record.fileID}`]);
  });

  it("streams the stored content", async () => {
    const { service } = setup();
    const record = await service.upload(upload({ content: bytes("hello") }), alice);
    const { content } = await service.openDownload({ fileID: record.fileID }, bob);
    expect(await text(content)).toBe("hello");
  });
});

describe("internal methods", () => {
  it("skip ownership checks and middleware", async () => {
    const { service } = setup();
    const middleware = vi.fn();
    service.use("upload", middleware);
    service.use("download", middleware);
    const record = await service.createFile(
      { name: "out.xlsx", contentType: "text/csv", source: 2, assign: "alice", content: bytes("a,b") },
      { userID: "exchange" }
    );
    expect(record.assign).toBe("alice");
    expect((await service.getFile(record.fileID, bob))?.fileID).toBe(record.fileID);
    expect(await text((await service.openFile(record.fileID, bob)).content)).toBe("a,b");
    expect(middleware).not.toHaveBeenCalled();
    expect(await service.getFile("missing", bob)).toBeNull();
    expect((await rejection(service.openFile("missing", bob))).code).toBe("FILE_NOT_FOUND");
  });

  it("deletes metadata first and the content only when it was released", async () => {
    const { database, blobStore, service } = setup();
    const kept = await service.upload(upload(), alice);
    database.releaseNothing = true;
    expect(await service.deleteFile(kept.fileID, alice)).toBe(true);
    expect(blobStore.objects.has(kept.blobKey)).toBe(true);
    database.releaseNothing = false;
    const released = await service.upload(upload(), alice);
    expect(await service.deleteFile(released.fileID, alice)).toBe(true);
    expect(blobStore.objects.has(released.blobKey)).toBe(false);
    expect(await service.deleteFile(released.fileID, alice)).toBe(false);
  });

  it("keeps the metadata delete when the content delete fails", async () => {
    const { database, blobStore, service } = setup();
    const record = await service.upload(upload(), alice);
    blobStore.failDelete = true;
    expect(await service.deleteFile(record.fileID, alice)).toBe(true);
    expect(database.records.has(record.fileID)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Orphan"), expect.objectContaining({ fileID: record.fileID }));
  });

  it("validates listFiles limit", async () => {
    const { service } = setup();
    expect((await rejection(service.listFiles({ source: 1, limit: 0 }, alice))).code).toBe("INVALID_REQUEST");
  });

  it("requires a userID on every call", async () => {
    const { service } = setup();
    expect((await rejection(service.getFile("x", { userID: "" }))).code).toBe("INVALID_REQUEST");
  });
});

describe("cleanupExpiredFiles", () => {
  async function seed(service: UniverFileService, database: FakeDatabase, items: Array<[string, number, number]>) {
    for (const [fileID, source, createdAt] of items) {
      const record = await service.createFile(
        { name: fileID, contentType: "text/plain", source, assign: "alice", content: bytes(fileID) },
        alice
      );
      database.records.delete(record.fileID);
      database.records.set(fileID, { ...record, fileID, createdAt });
    }
  }

  it("deletes only expired HttpImport and HttpExport files", async () => {
    const { database, service } = setup();
    const now = Date.now();
    const old = now - 3 * 60 * 60 * 1000;
    await seed(service, database, [
      ["import-old", 1, old],
      ["export-old", 2, old],
      ["import-new", 1, now],
      ["embedded-old", 3, old],
      ["undefined-old", 0, old],
    ]);
    const result = await service.cleanupExpiredFiles({ userID: "cleanup" }, { batchGapMs: 0 });
    expect(result).toEqual({ scanned: 2, deleted: 2, failed: 0 });
    expect([...database.records.keys()].sort()).toEqual(["embedded-old", "import-new", "undefined-old"]);
  });

  it("stops at maxPerRun and skips failed records through the cursor", async () => {
    const { database, service } = setup();
    const old = Date.now() - 3 * 60 * 60 * 1000;
    await seed(
      service,
      database,
      Array.from({ length: 6 }, (_, index) => [`f${index}`, 1, old + index] as [string, number, number])
    );
    database.failDelete.add("f0");
    const result = await service.cleanupExpiredFiles(alice, { batchSize: 2, maxPerRun: 5, batchGapMs: 0 });
    expect(result).toEqual({ scanned: 5, deleted: 4, failed: 1 });
    expect([...database.records.keys()].sort()).toEqual(["f0", "f5"]);
  });

  it("gives every adapter call the CleanupRequest and the caller identity", async () => {
    const { database, blobStore, service } = setup();
    await seed(service, database, [["old", 1, 1]]);
    database.contexts.length = 0;
    blobStore.contexts.length = 0;
    await service.cleanupExpiredFiles({ userID: "ops" }, { batchGapMs: 0 });
    const contexts = [...database.contexts, ...blobStore.contexts];
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) {
      expect(context.userID).toBe("ops");
      expect(context.request).toMatchObject({ sources: [1, 2], batchSize: 100, maxPerRun: 500 });
    }
  });

  it("skips a run while another one is in progress in the same process", async () => {
    const { database, service } = setup();
    await seed(service, database, [["old", 1, 1]]);
    const first = service.cleanupExpiredFiles(alice, { batchGapMs: 0 });
    expect(await service.cleanupExpiredFiles(alice)).toEqual({ scanned: 0, deleted: 0, failed: 0 });
    expect((await first).deleted).toBe(1);
  });

  it("validates per-run options", async () => {
    const { service } = setup();
    expect((await rejection(service.cleanupExpiredFiles(alice, { batchSize: 0 }))).code).toBe("INVALID_REQUEST");
  });

  it("runs from the built-in timer after a randomized first delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const database = new FakeDatabase();
    const listSpy = vi.spyOn(database, "list");
    const service = new UniverFileService({
      database,
      blobStore: new FakeBlobStore(),
      logger,
      cleanup: { intervalMs: 1000, batchGapMs: 0, context: { userID: "timer" } },
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(listSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(listSpy).toHaveBeenCalled();
    const calls = listSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(listSpy.mock.calls.length).toBeGreaterThan(calls);
    expect(listSpy.mock.calls[0]![1].userID).toBe("timer");
    await service.dispose();
    vi.restoreAllMocks();
  });
});

describe("dispose", () => {
  it("waits for in-flight calls, rejects new ones and leaves adapters alone", async () => {
    const { database, blobStore, service } = setup();
    const databaseDispose = vi.spyOn(database, "dispose");
    const blobDispose = vi.spyOn(blobStore, "dispose");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const content = (async function* () {
      await gate;
      yield encoder.encode("late");
    })();
    const pending = service.upload(upload({ content }), alice);
    let disposed = false;
    const disposing = service.dispose().then(() => (disposed = true));
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect((await rejection(service.getFile("x", alice))).code).toBe("SERVICE_DISPOSED");
    release();
    await pending;
    await disposing;
    expect(databaseDispose).not.toHaveBeenCalled();
    expect(blobDispose).not.toHaveBeenCalled();
  });
});
