import { readFile } from "node:fs/promises";
import { MemoryDatabaseAdapter } from "@univerjs-pro/collaboration-database-memory";
import { MemoryFileBlobStore, MemoryFileDatabaseAdapter } from "@univerjs-pro/collaboration-file-memory";
import { FileSource, UniverFileService, type FileContent } from "@univerjs-pro/collaboration-file-service";
import { UniverCollabService, type CollabContext, type ILogger } from "@univerjs-pro/collaboration-service";
import { afterEach, vi } from "vitest";
import {
  UniverExchangeService,
  type ExchangeTask,
  type IExchangeCollabService,
  type UniverExchangeServiceOptions,
} from "../src/index.js";

export const alice: CollabContext = { userID: "alice" };
export const bob: CollabContext = { userID: "bob" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export interface TestHost {
  readonly collabService: UniverCollabService;
  readonly fileService: UniverFileService;
  readonly service: UniverExchangeService;
  readonly logger: { [K in keyof ILogger]: ReturnType<typeof vi.fn> };
}

export function createHost(
  overrides: { collabService?: IExchangeCollabService; fileService?: UniverExchangeServiceOptions["fileService"] } = {}
): TestHost {
  const collabService = new UniverCollabService({
    dbAdapter: new MemoryDatabaseAdapter(),
    runtime: { execution: { mode: "in-process" } },
  });
  const fileService = new UniverFileService({
    database: new MemoryFileDatabaseAdapter(),
    blobStore: new MemoryFileBlobStore(),
  });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new UniverExchangeService({
    collabService: overrides.collabService ?? collabService,
    fileService: overrides.fileService ?? fileService,
    logger,
  });
  cleanups.push(async () => {
    await collabService.dispose();
    await fileService.dispose();
    await service.dispose();
  });
  return { collabService, fileService, service, logger };
}

export function fixture(name: string): Promise<Buffer> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url));
}

export async function* single(bytes: Uint8Array): FileContent {
  yield bytes;
}

/** Stores a file the way the File upload route would, owned by `context.userID` unless `assign` is given. */
export async function storeFile(
  fileService: UniverFileService,
  bytes: Uint8Array,
  name: string,
  options: { context?: CollabContext; source?: number; assign?: string; contentType?: string } = {}
): Promise<string> {
  const context = options.context ?? alice;
  const record = await fileService.createFile(
    {
      name,
      contentType: options.contentType ?? "application/octet-stream",
      source: options.source ?? FileSource.HttpImport,
      assign: options.assign ?? context.userID,
      content: single(bytes),
    },
    context
  );
  return record.fileID;
}

export async function readStoredFile(fileService: UniverFileService, fileID: string): Promise<Buffer> {
  const { content } = await fileService.openFile(fileID, alice);
  const chunks: Uint8Array[] = [];
  for await (const chunk of content) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Polls until the task leaves `pending`; the input file is deleted right after, so wait for that too. */
export async function settle(service: UniverExchangeService, taskID: string, context: CollabContext = alice): Promise<ExchangeTask> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const task = await service.getTask(taskID, context);
    if (task.status !== "pending") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return task;
    }
    if (Date.now() > deadline) throw new Error(`Task ${taskID} is still pending`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function listFiles(fileService: UniverFileService, source: number, assign?: string) {
  const { records } = await fileService.listFiles(
    { source, limit: 1000, ...(assign === undefined ? {} : { assign }) },
    alice
  );
  return records;
}
