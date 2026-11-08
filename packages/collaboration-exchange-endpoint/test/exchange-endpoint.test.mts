import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryDatabaseAdapter } from "@univerjs-pro/collaboration-database-memory";
import { ExchangeServiceError, UniverExchangeService, type IUniverExchangeService } from "@univerjs-pro/collaboration-exchange-service";
import { MemoryFileBlobStore, MemoryFileDatabaseAdapter } from "@univerjs-pro/collaboration-file-memory";
import { FileError, FileSource, UniverFileService } from "@univerjs-pro/collaboration-file-service";
import { CollabError, UniverCollabService } from "@univerjs-pro/collaboration-service";
import { createNodeTransport, NodeTransportError } from "@univerjs-pro/collaboration-transport-node";
import { importBufferToSnapshot } from "@univerjs-pro/exchange-node";
import { ErrorCode, UniverType } from "@univerjs/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UniverExchangeEndpoint, type UniverExchangeEndpointOptions } from "../src/index.js";
import { protocolError } from "../src/protocol-errors.js";

vi.mock("@univerjs-pro/exchange-node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@univerjs-pro/exchange-node")>()),
  importBufferToSnapshot: vi.fn(),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createHost(options: UniverExchangeEndpointOptions = {}, override?: IUniverExchangeService) {
  const collabService = new UniverCollabService({
    dbAdapter: new MemoryDatabaseAdapter(),
    runtime: { execution: { mode: "in-process" } },
  });
  const fileService = new UniverFileService({
    database: new MemoryFileDatabaseAdapter(),
    blobStore: new MemoryFileBlobStore(),
    cleanup: false,
  });
  const service = new UniverExchangeService({ collabService, fileService });
  const transport = createNodeTransport();
  transport.use(async (ctx, next) => {
    const userID = ctx.incomingMessage.headers["x-user-id"];
    if (typeof userID === "string") ctx.userID = userID;
    await next();
  });
  const endpoint = new UniverExchangeEndpoint(override ?? service, options);
  transport.register(endpoint);
  const server = createServer((request, response) => transport.handleRequest(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(async () => {
    await transport.dispose();
    await service.dispose();
    await fileService.dispose();
    await collabService.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${port}`, service, fileService, endpoint };
}

async function post(url: string, body: unknown, user: string | null = "alice", raw = false) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(user ? { "x-user-id": user } : {}) },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

async function getTask(base: string, taskID: string, user: string | null = "alice") {
  const response = await fetch(`${base}/universer-api/exchange/task/${taskID}`, {
    headers: user ? { "x-user-id": user } : {},
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

async function* single(bytes: Uint8Array) {
  yield bytes;
}

async function upload(fileService: UniverFileService, name: string, bytes = Buffer.from("x")) {
  const record = await fileService.createFile(
    { name, contentType: "application/octet-stream", source: FileSource.HttpImport, assign: "alice", content: single(bytes) },
    { userID: "alice" }
  );
  return record.fileID;
}

async function waitForTerminal(base: string, taskID: string) {
  return vi.waitFor(
    async () => {
      const task = await getTask(base, taskID);
      if (task.json.status === "pending") throw new Error("pending");
      return task;
    },
    { timeout: 10_000, interval: 10 }
  );
}

function jsonSnapshot() {
  const originalMeta = new TextEncoder().encode("{}");
  return {
    snapshot: {
      unitID: "converted",
      type: UniverType.UNIVER_SHEET,
      rev: 1,
      workbook: { unitID: "converted", rev: 1, creator: "", name: "", sheetOrder: [], sheets: {}, resources: [], blockMeta: {}, originalMeta },
      doc: undefined,
      slide: undefined,
      board: undefined,
    },
    sheetBlocks: [],
  };
}

describe("UniverExchangeEndpoint", () => {
  it("creates an import task and reports the JSON result through the task route", async () => {
    vi.mocked(importBufferToSnapshot).mockResolvedValue(jsonSnapshot());
    const { base, fileService } = await createHost();
    const fileID = await upload(fileService, "a.xlsx");

    const created = await post(`${base}/universer-api/exchange/2/import`, { fileID, outputType: 2 });

    expect(created).toMatchObject({ status: 200, json: { error: { code: ErrorCode.OK, message: "" } } });
    expect(created.json.taskID).toMatch(/^[0-9a-f-]{36}$/);
    const task = await waitForTerminal(base, created.json.taskID);
    expect(task.status).toBe(200);
    expect(task.json).toMatchObject({
      error: { code: ErrorCode.OK },
      taskID: created.json.taskID,
      status: "done",
      import: { outputType: 2, unitID: "" },
    });
    expect(task.json.import.jsonID).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reports a pending task with OK and never exposes running", async () => {
    let finish!: () => void;
    vi.mocked(importBufferToSnapshot).mockImplementation(async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      return jsonSnapshot();
    });
    const { base, fileService } = await createHost();
    const fileID = await upload(fileService, "a.xlsx");
    const created = await post(`${base}/universer-api/exchange/2/import`, { fileID, outputType: 2 });

    await vi.waitFor(() => expect(finish).toBeDefined());
    const task = await getTask(base, created.json.taskID);

    expect(task.json).toEqual({ error: { code: ErrorCode.OK, message: "" }, taskID: created.json.taskID, status: "pending" });
    finish();
    await waitForTerminal(base, created.json.taskID);
  });

  it("answers a failed task with HTTP 200, the mapped code and the original message", async () => {
    vi.mocked(importBufferToSnapshot).mockRejectedValue(
      Object.assign(new Error("Workbook is damaged"), { name: "ExchangeError", code: "INVALID_FILE" })
    );
    const { base, fileService } = await createHost();
    const fileID = await upload(fileService, "a.xlsx");
    const created = await post(`${base}/universer-api/exchange/2/import`, { fileID, outputType: 2 });

    const task = await waitForTerminal(base, created.json.taskID);

    expect(task.status).toBe(200);
    expect(task.json).toEqual({
      error: { code: ErrorCode.INVALID_ARGUMENT, message: "Workbook is damaged" },
      taskID: created.json.taskID,
      status: "failed",
    });
  });

  it.each([
    ["import", { fileID: "f", outputType: 1 }],
    ["export", { unitID: "u", format: "xlsx" }],
  ])("requires an authenticated user on %s", async (route, body) => {
    const { base } = await createHost();
    const { status, json } = await post(`${base}/universer-api/exchange/2/${route}`, body, null);
    expect(status).toBe(200);
    expect(json).toMatchObject({ error: { code: ErrorCode.UNAUTHENTICATED }, taskID: "" });
  });

  it("requires an authenticated user on the task route", async () => {
    const { base } = await createHost();
    const { status, json } = await getTask(base, "t", null);
    expect(status).toBe(200);
    expect(json.error.code).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it.each([
    ["a non-numeric type", "abc", { fileID: "f", outputType: 1 }, ErrorCode.INVALID_ARGUMENT],
    ["Board", String(UniverType.UNIVER_BOARD), { fileID: "f", outputType: 1 }, ErrorCode.INVALID_ARGUMENT],
    ["a non-object body", "2", [], ErrorCode.INVALID_ARGUMENT],
    ["a file that does not exist", "2", { fileID: "missing", outputType: 1 }, ErrorCode.NOT_FOUND],
    ["a sourceUnitID whose attachment does not exist", "2", { fileID: "f", outputType: 1, sourceUnitID: "host" }, ErrorCode.NOT_FOUND],
  ])("rejects an import with %s in the response", async (_case, type, body, code) => {
    const { base } = await createHost();
    const { status, json } = await post(`${base}/universer-api/exchange/${type}/import`, body);
    expect(status).toBe(200);
    expect(json).toMatchObject({ error: { code }, taskID: "" });
  });

  it("reports malformed JSON as INVALID_ARGUMENT", async () => {
    const { base } = await createHost();
    const { status, json } = await post(`${base}/universer-api/exchange/2/import`, "{", "alice", true);
    expect(status).toBe(200);
    expect(json.error.code).toBe(ErrorCode.INVALID_ARGUMENT);
  });

  it("rejects online OLE export for CSV and a missing Unit in the export response", async () => {
    const { base } = await createHost();
    const online = await post(`${base}/universer-api/exchange/2/export`, {
      unitID: "u",
      type: 2,
      format: "csv",
      options: { sheet: { csv: { sheetId: "s" } }, oleAttachmentSource: "online" },
    });
    expect(online.json).toMatchObject({ error: { code: ErrorCode.INVALID_ARGUMENT }, taskID: "" });
    expect(online.json.error.message).toContain("oleAttachmentSource");

    const missing = await post(`${base}/universer-api/exchange/2/export`, { unitID: "missing", format: "xlsx" });
    expect(missing).toMatchObject({ status: 200, json: { error: { code: ErrorCode.NOT_FOUND }, taskID: "" } });
  });

  it("uses the route type over the body type", async () => {
    const createExportTask = vi.fn(async () => "task-1");
    const { base } = await createHost({}, { createExportTask } as unknown as IUniverExchangeService);

    await post(`${base}/universer-api/exchange/1/export`, { unitID: "u", type: 2, format: "docx" });

    expect(createExportTask).toHaveBeenCalledWith(
      { type: 1, unitID: "u", format: "docx" },
      expect.objectContaining({ userID: "alice" })
    );
  });

  it("passes the body fields and the Transport customData to the Service", async () => {
    const createImportTask = vi.fn(async () => "task-1");
    const { base } = await createHost({}, { createImportTask } as unknown as IUniverExchangeService);

    await post(`${base}/universer-api/exchange/2/import`, { fileID: "f", outputType: 1, sourceUnitID: "host", options: { sheet: {} } });

    expect(createImportTask).toHaveBeenCalledWith(
      { type: 2, fileID: "f", outputType: 1, sourceUnitID: "host", options: { sheet: {} } },
      { userID: "alice", customData: expect.any(Object) }
    );
  });

  it("hides another user's task behind NOT_FOUND", async () => {
    vi.mocked(importBufferToSnapshot).mockResolvedValue(jsonSnapshot());
    const { base, fileService } = await createHost();
    const fileID = await upload(fileService, "a.xlsx");
    const created = await post(`${base}/universer-api/exchange/2/import`, { fileID, outputType: 2 });

    const task = await getTask(base, created.json.taskID, "bob");

    expect(task).toMatchObject({ status: 200, json: { error: { code: ErrorCode.NOT_FOUND }, status: "failed" } });
    await waitForTerminal(base, created.json.taskID);
  });

  it("maps a done export task with an empty fileUrl", async () => {
    const getTaskMock = vi.fn(async () => ({ taskID: "t", kind: "export", status: "done", result: { fileID: "f" } }));
    const { base } = await createHost({}, { getTask: getTaskMock } as unknown as IUniverExchangeService);

    const task = await getTask(base, "t");

    expect(task.json).toEqual({
      error: { code: ErrorCode.OK, message: "" },
      taskID: "t",
      status: "done",
      export: { fileID: "f", fileUrl: "" },
    });
  });

  it("maps a done Unit import with an empty jsonID", async () => {
    const getTaskMock = vi.fn(async () => ({ taskID: "t", kind: "import", status: "done", result: { outputType: 1, unitID: "u" } }));
    const { base } = await createHost({}, { getTask: getTaskMock } as unknown as IUniverExchangeService);

    const task = await getTask(base, "t");

    expect(task.json.import).toEqual({ outputType: 1, unitID: "u", jsonID: "" });
  });

  it("honours routePrefix", async () => {
    const { base } = await createHost({ routePrefix: "/api" });
    const { json } = await post(`${base}/api/exchange/2/import`, { fileID: "missing", outputType: 1 });
    expect(json.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("rejects an invalid routePrefix and a missing service", () => {
    const service = {} as IUniverExchangeService;
    for (const routePrefix of ["api", "/", "/api/", "//api"]) {
      expect(() => new UniverExchangeEndpoint(service, { routePrefix })).toThrow(TypeError);
    }
    expect(() => new UniverExchangeEndpoint(undefined as unknown as IUniverExchangeService)).toThrow(TypeError);
  });

  it("answers INTERNAL_ERROR after dispose without touching the Service", async () => {
    const createImportTask = vi.fn(async () => "task-1");
    const { base, endpoint } = await createHost({}, { createImportTask } as unknown as IUniverExchangeService);
    await endpoint.dispose();

    const { status, json } = await post(`${base}/universer-api/exchange/2/import`, { fileID: "f", outputType: 1 });

    expect(status).toBe(200);
    expect(json.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(createImportTask).not.toHaveBeenCalled();
  });
});

describe("protocolError", () => {
  const exchangeError = (code: string) => Object.assign(new Error(code), { name: "ExchangeError", code });

  it.each([
    ["INVALID_ARGUMENT", ErrorCode.INVALID_ARGUMENT],
    ["UNSUPPORTED_FORMAT", ErrorCode.INVALID_ARGUMENT],
    ["INVALID_FILE", ErrorCode.INVALID_ARGUMENT],
    ["INCOMPLETE_SNAPSHOT", ErrorCode.INVALID_ARGUMENT],
    ["IO_ERROR", ErrorCode.INTERNAL_ERROR],
    ["NATIVE_LOAD_FAILED", ErrorCode.INTERNAL_ERROR],
    ["CONVERSION_FAILED", ErrorCode.INTERNAL_ERROR],
    ["LICENSE_EXPORT_QUOTA_EXCEEDED", ErrorCode.LICENSE_EXPORT_QUOTA_EXCEEDED],
    ["LICENSE_INVALID", ErrorCode.LICENSE_INVALID],
    ["LICENSE_POLICY_INVALID", ErrorCode.LICENSE_POLICY_INVALID],
    ["LICENSE_NOT_YET_EFFECTIVE", ErrorCode.LICENSE_NOT_YET_EFFECTIVE],
    ["LICENSE_UNIT_TYPE_REJECTED", ErrorCode.LICENSE_UNIT_TYPE_REJECTED],
    ["LICENSE_VERSION_NOT_ALLOWED", ErrorCode.LICENSE_VERSION_NOT_ALLOWED],
    ["LICENSE_CONCURRENCY_TIMEOUT", ErrorCode.LICENSE_CONCURRENCY_TIMEOUT],
    ["LICENSE_USAGE_STATE_INVALID", ErrorCode.LICENSE_USAGE_STATE_INVALID],
    ["LICENSE_USAGE_STORAGE_ERROR", ErrorCode.LICENSE_USAGE_STORAGE_ERROR],
  ])("maps exchange-node %s", (code, expected) => {
    expect(protocolError(exchangeError(code))).toEqual({ code: expected, message: code });
  });

  it.each([
    [new ExchangeServiceError("INVALID_REQUEST", "m"), ErrorCode.INVALID_ARGUMENT],
    [new ExchangeServiceError("UNAUTHENTICATED", "m"), ErrorCode.UNAUTHENTICATED],
    [new ExchangeServiceError("FILE_NOT_FOUND", "m"), ErrorCode.NOT_FOUND],
    [new ExchangeServiceError("TASK_NOT_FOUND", "m"), ErrorCode.NOT_FOUND],
    [new ExchangeServiceError("SERVICE_DISPOSED", "m"), ErrorCode.INTERNAL_ERROR],
    [new FileError("INVALID_REQUEST", "m"), ErrorCode.INVALID_ARGUMENT],
    [new FileError("PAYLOAD_TOO_LARGE", "m"), ErrorCode.INVALID_ARGUMENT],
    [new FileError("UNAUTHENTICATED", "m"), ErrorCode.UNAUTHENTICATED],
    [new FileError("PERMISSION_DENIED", "m"), ErrorCode.PERMISSION_DENIED],
    [new FileError("FILE_NOT_FOUND", "m"), ErrorCode.NOT_FOUND],
    [new FileError("STORAGE_FAILURE", "m"), ErrorCode.INTERNAL_ERROR],
    [new FileError("SERVICE_DISPOSED", "m"), ErrorCode.INTERNAL_ERROR],
    [new CollabError("UNAUTHENTICATED", "m"), ErrorCode.UNAUTHENTICATED],
    [new CollabError("INVALID_REQUEST", "m"), ErrorCode.INVALID_ARGUMENT],
    [new CollabError("UNIT_NOT_FOUND", "m"), ErrorCode.NOT_FOUND],
    [new CollabError("PERMISSION_DENIED", "m"), ErrorCode.PERMISSION_DENIED],
    [new CollabError("ADAPTER_FAILURE", "m"), ErrorCode.INTERNAL_ERROR],
    [new CollabError("INTERNAL_ERROR", "m"), ErrorCode.INTERNAL_ERROR],
    [new CollabError("LICENSE_UNIT_TYPE_REJECTED", "m"), ErrorCode.LICENSE_UNIT_TYPE_REJECTED],
    [new NodeTransportError("INVALID_JSON", "m"), ErrorCode.INVALID_ARGUMENT],
    [new NodeTransportError("REQUEST_BODY_TOO_LARGE", "m"), ErrorCode.INVALID_ARGUMENT],
    [new NodeTransportError("TRANSPORT_DISPOSED", "m"), ErrorCode.INTERNAL_ERROR],
    [new Error("m"), ErrorCode.INTERNAL_ERROR],
  ])("maps %s and keeps the message", (error, expected) => {
    expect(protocolError(error)).toEqual({ code: expected, message: "m" });
  });

  it("treats an unknown exchange-node code and a non-Error value as INTERNAL_ERROR", () => {
    expect(protocolError(exchangeError("LICENSE_SOMETHING_NEW")).code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(protocolError("plain string")).toEqual({ code: ErrorCode.INTERNAL_ERROR, message: "plain string" });
  });
});
