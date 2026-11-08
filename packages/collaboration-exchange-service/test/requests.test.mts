import { FileSource } from "@univerjs-pro/collaboration-file-service";
import { CollabError } from "@univerjs-pro/collaboration-service";
import { exportSnapshotToBuffer, importBufferToSnapshot } from "@univerjs-pro/exchange-node";
import { UniverType, type ISnapshot } from "@univerjs/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExchangeServiceError, type ExportMiddlewareContext, type ImportMiddlewareContext } from "../src/index.js";
import { encodeSnapshotJson } from "../src/snapshot-json.js";
import { alice, bob, createHost, listFiles, settle, storeFile } from "./helpers.mjs";

// Request stage and task orchestration: conversion functions are replaced, so the cases only cover
// validation, ownership, middleware, task states and file cleanup.
vi.mock("@univerjs-pro/exchange-node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@univerjs-pro/exchange-node")>()),
  importBufferToSnapshot: vi.fn(),
  exportSnapshotToBuffer: vi.fn(),
}));

const importMock = vi.mocked(importBufferToSnapshot);
const exportMock = vi.mocked(exportSnapshotToBuffer);

function sheetSnapshot(unitID: string): ISnapshot {
  const originalMeta = new TextEncoder().encode(JSON.stringify({ id: unitID, sheetOrder: [], styles: {} }));
  return {
    unitID,
    type: UniverType.UNIVER_SHEET,
    rev: 1,
    workbook: {
      unitID,
      rev: 1,
      creator: "",
      name: "Budget",
      sheetOrder: [],
      sheets: {},
      resources: [],
      blockMeta: {},
      originalMeta,
    },
    doc: undefined,
    slide: undefined,
    board: undefined,
  };
}

function expectServiceError(code: string) {
  return expect.objectContaining({ name: "ExchangeServiceError", code });
}

beforeEach(() => {
  importMock.mockReset();
  exportMock.mockReset();
  importMock.mockImplementation(async (_bytes, options) => ({
    snapshot: sheetSnapshot((options as { unitId?: string }).unitId ?? "json-unit"),
    sheetBlocks: [],
  }));
  exportMock.mockResolvedValue(Buffer.from("exported"));
});

describe("createImportTask", () => {
  it("rejects without creating a task when the upload is missing or not the caller's HttpImport file", async () => {
    const { service, fileService } = createHost();
    const bobs = await storeFile(fileService, Buffer.from("x"), "a.xlsx", { context: bob });
    const exported = await storeFile(fileService, Buffer.from("x"), "a.xlsx", { source: FileSource.HttpExport });
    const embedded = await storeFile(fileService, Buffer.from("x"), "a.xlsx", { source: FileSource.UnitEmbedded, assign: "alice" });

    for (const fileID of ["missing", bobs, exported, embedded]) {
      await expect(
        service.createImportTask({ type: UniverType.UNIVER_SHEET, outputType: 1, fileID }, alice)
      ).rejects.toEqual(expectServiceError("FILE_NOT_FOUND"));
    }
    expect(importMock).not.toHaveBeenCalled();
  });

  it.each([
    ["Board", { type: UniverType.UNIVER_BOARD, outputType: 1 }],
    ["an unknown type", { type: 42, outputType: 1 }],
    ["an unknown outputType", { type: UniverType.UNIVER_SHEET, outputType: 3 }],
    ["sourceUnitID with outputType 2", { type: UniverType.UNIVER_SHEET, outputType: 2, sourceUnitID: "host-unit" }],
    ["an extension the type does not import", { type: UniverType.UNIVER_DOC, outputType: 1 }],
    ["an invalid option", { type: UniverType.UNIVER_SHEET, outputType: 1, options: { sheet: { minSheetRowCount: -1 } } }],
  ])("rejects %s with INVALID_REQUEST", async (_case, input) => {
    const { service, fileService } = createHost();
    const fileID = await storeFile(fileService, Buffer.from("x"), "a.xlsx");
    await expect(
      service.createImportTask({ fileID, ...input } as Parameters<typeof service.createImportTask>[0], alice)
    ).rejects.toEqual(expectServiceError("INVALID_REQUEST"));
    expect(await fileService.getFile(fileID, alice)).not.toBeNull();
  });

  it("rejects a sourceUnitID import unless the file is a UnitEmbedded attachment of that Unit", async () => {
    const { service, fileService } = createHost();
    const upload = await storeFile(fileService, Buffer.from("x"), "a.xlsx");
    const other = await storeFile(fileService, Buffer.from("x"), "a.xlsx", { source: FileSource.UnitEmbedded, assign: "other-unit" });

    for (const fileID of ["missing", upload, other]) {
      await expect(
        service.createImportTask({ type: UniverType.UNIVER_SHEET, outputType: 1, fileID, sourceUnitID: "host-unit" }, alice)
      ).rejects.toEqual(expectServiceError("FILE_NOT_FOUND"));
    }
    expect(importMock).not.toHaveBeenCalled();
  });

  it("converts a stored attachment, shows sourceUnitID to middleware and keeps the attachment", async () => {
    const { service, fileService } = createHost();
    const fileID = await storeFile(fileService, Buffer.from("x"), "Budget.xlsx", { source: FileSource.UnitEmbedded, assign: "host-unit" });
    const seen: ImportMiddlewareContext[] = [];
    service.use("import", async (ctx, next) => {
      seen.push(ctx);
      await next();
    });

    const task = await settle(
      service,
      await service.createImportTask({ type: UniverType.UNIVER_SHEET, outputType: 1, fileID, sourceUnitID: "host-unit" }, alice)
    );

    expect(seen[0]!.request).toEqual({ type: UniverType.UNIVER_SHEET, outputType: 1, fileID, sourceUnitID: "host-unit" });
    expect(task).toMatchObject({ status: "done", result: { outputType: 1 } });
    expect(importMock).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ fileName: "Budget.xlsx" }));
    expect(await fileService.getFile(fileID, alice)).toMatchObject({ source: FileSource.UnitEmbedded, assign: "host-unit" });
  });

  it("runs import middleware with a frozen request and the caller's customData before the task exists", async () => {
    const { service, fileService } = createHost();
    const fileID = await storeFile(fileService, Buffer.from("x"), "Report.XLSX");
    const customData = { tenant: "t1" };
    const seen: ImportMiddlewareContext[] = [];
    service.use("import", async (ctx, next) => {
      seen.push(ctx);
      await next();
    });

    const taskID = await service.createImportTask(
      { type: UniverType.UNIVER_SHEET, outputType: 1, fileID, options: { sheet: { minSheetRowCount: 10 } } },
      { userID: "alice", customData }
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.customData).toBe(customData);
    expect(seen[0]!.request).toEqual({
      type: UniverType.UNIVER_SHEET,
      outputType: 1,
      fileID,
      options: { sheet: { minSheetRowCount: 10 } },
    });
    expect(Object.isFrozen(seen[0]!.request)).toBe(true);
    await settle(service, taskID);
    expect(importMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ type: UniverType.UNIVER_SHEET, format: "xlsx", fileName: "Report.XLSX", minSheetRowCount: 10 })
    );
  });

  it("creates no task and keeps the upload when import middleware rejects", async () => {
    const { service, fileService } = createHost();
    const fileID = await storeFile(fileService, Buffer.from("x"), "a.xlsx");
    service.use("import", () => {
      throw new Error("quota exceeded");
    });

    await expect(service.createImportTask({ type: UniverType.UNIVER_SHEET, outputType: 1, fileID }, alice)).rejects.toThrow(
      "quota exceeded"
    );
    expect(importMock).not.toHaveBeenCalled();
    expect(await fileService.getFile(fileID, alice)).not.toBeNull();
  });

  it("passes files.store only for Unit imports of Sheet, Doc and Slide", async () => {
    const { service, fileService } = createHost();
    const run = async (type: UniverType, outputType: 1 | 2, name: string) => {
      const fileID = await storeFile(fileService, Buffer.from("x"), name);
      await settle(service, await service.createImportTask({ type, outputType, fileID }, alice));
      return importMock.mock.lastCall![1] as { files?: unknown; unitId?: string };
    };
    expect((await run(UniverType.UNIVER_SHEET, 1, "a.xlsx")).files).toBeDefined();
    expect((await run(UniverType.UNIVER_SHEET, 2, "a.xlsx")).files).toBeUndefined();
    expect((await run(UniverType.UNIVER_SHEET, 2, "a.xlsx")).unitId).toBeUndefined();
    expect((await run(UniverType.UNIVER_BASE, 1, "a.xlsx")).files).toBeUndefined();
    expect((await run(UniverType.UNIVER_PDF, 1, "a.pdf")).files).toBeUndefined();
  });

  it("maps Base and Doc import options to exchange-node names", async () => {
    const { service, fileService } = createHost();
    const baseFile = await storeFile(fileService, Buffer.from("x"), "a.xlsx");
    await settle(
      service,
      await service.createImportTask(
        {
          type: UniverType.UNIVER_BASE,
          outputType: 2,
          fileID: baseFile,
          options: { base: { xlsx: { baseMode: "hybrid", baseFormulaPolicy: "convert-then-values" } } },
        },
        alice
      )
    );
    expect(importMock.mock.lastCall![1]).toMatchObject({ mode: "hybrid", formulaPolicy: "convertThenValues" });

    const docFile = await storeFile(fileService, Buffer.from("x"), "a.docx");
    await settle(
      service,
      await service.createImportTask(
        { type: UniverType.UNIVER_DOC, outputType: 2, fileID: docFile, options: { doc: { docType: "traditional" } } },
        alice
      )
    );
    expect(importMock.mock.lastCall![1]).toMatchObject({ compatibilityMode: "traditional" });
  });

  it("removes files stored during a failed conversion", async () => {
    const { service, fileService } = createHost();
    importMock.mockImplementation(async (_bytes, options) => {
      const store = (options as { files: { store: (file: unknown) => Promise<unknown> } }).files.store;
      await store({ name: "image1.png", mimeType: "image/png", size: 1, bytes: new Uint8Array([1]) });
      throw new Error("conversion failed late");
    });
    const fileID = await storeFile(fileService, Buffer.from("x"), "a.xlsx");

    const task = await settle(service, await service.createImportTask({ type: UniverType.UNIVER_SHEET, outputType: 1, fileID }, alice));

    expect(task).toMatchObject({ status: "failed", error: new Error("conversion failed late") });
    expect(await listFiles(fileService, FileSource.UnitEmbedded)).toEqual([]);
  });

  it("logs a failed early delete and still completes the task", async () => {
    const host = createHost();
    const deleteFile = vi.spyOn(host.fileService, "deleteFile").mockRejectedValue(new Error("disk unavailable"));
    const fileID = await storeFile(host.fileService, Buffer.from("x"), "a.xlsx");

    const task = await settle(host.service, await host.service.createImportTask({ type: UniverType.UNIVER_SHEET, outputType: 1, fileID }, alice));

    expect(task.status).toBe("done");
    expect(deleteFile).toHaveBeenCalledWith(fileID, expect.objectContaining({ userID: "alice" }));
    expect(host.logger.warn).toHaveBeenCalledWith("Exchange could not delete a file", { fileID, error: "disk unavailable" });
  });
});

describe("createExportTask", () => {
  async function createSheetUnit(host: ReturnType<typeof createHost>, unitID = "sheet-unit"): Promise<string> {
    await host.collabService.createUnitFromData(
      {
        type: UniverType.UNIVER_SHEET,
        data: {
          id: unitID,
          name: "Budget",
          rev: 1,
          appVersion: "1.3.1",
          locale: "enUS",
          styles: {},
          sheetOrder: ["s1"],
          sheets: { s1: { id: "s1", name: "Sheet1", rowCount: 20, columnCount: 10, cellData: {} } },
          resources: [],
        },
      } as Parameters<typeof host.collabService.createUnitFromData>[0],
      alice
    );
    return unitID;
  }

  it.each([
    ["neither unitID nor jsonID", {}],
    ["both unitID and jsonID", { unitID: "u", jsonID: "j" }],
    ["Board", { type: UniverType.UNIVER_BOARD, unitID: "u", format: "pptx" }],
    ["a format the type does not export", { unitID: "u", format: "docx" }],
    ["Base TSV", { type: UniverType.UNIVER_BASE, unitID: "u", format: "tsv", options: { base: { csv: { tableId: "t" } } } }],
    ["Sheet CSV without sheetId", { unitID: "u", format: "csv" }],
    ["Base CSV without tableId", { type: UniverType.UNIVER_BASE, unitID: "u", format: "csv" }],
    ["online OLE attachments for CSV", { unitID: "u", format: "csv", options: { sheet: { csv: { sheetId: "s" } }, oleAttachmentSource: "online" } }],
    ["online OLE attachments for Base", { type: UniverType.UNIVER_BASE, unitID: "u", options: { oleAttachmentSource: "online" } }],
    ["an unknown OLE source", { unitID: "u", options: { oleAttachmentSource: "latest" } }],
    ["an invalid Base export mode", { type: UniverType.UNIVER_BASE, unitID: "u", options: { base: { xlsx: { baseExportMode: "rows" } } } }],
  ])("rejects %s with INVALID_REQUEST before reading the Unit", async (_case, input) => {
    const host = createHost();
    const read = vi.spyOn(host.collabService, "getUnitLoadDataWithBlocks");
    await expect(
      host.service.createExportTask(
        { type: UniverType.UNIVER_SHEET, format: "xlsx", ...input } as Parameters<typeof host.service.createExportTask>[0],
        alice
      )
    ).rejects.toEqual(expectServiceError("INVALID_REQUEST"));
    expect(read).not.toHaveBeenCalled();
  });

  it("names the export that cannot embed online attachments", async () => {
    const { service } = createHost();
    await expect(
      service.createExportTask(
        { type: UniverType.UNIVER_SHEET, unitID: "u", format: "csv", options: { sheet: { csv: { sheetId: "s" } }, oleAttachmentSource: "online" } },
        alice
      )
    ).rejects.toThrow('options.oleAttachmentSource "online" is not supported for this export');
  });

  describe("online attachment versions", () => {
    type OnlineOptions = {
      ole: { attachmentSource: string; loadOnlineUnit: (ref: { unitId: string; type: number }) => Promise<{ snapshot: ISnapshot }> };
      files: { load: (ref: { sourceType: "UUID"; source: string; unitId: string }) => Promise<{ bytes: Uint8Array }> };
    };

    async function hostWithChild(host: ReturnType<typeof createHost>) {
      const unitID = await createSheetUnit(host);
      await createSheetUnit(host, "child-unit");
      const childFile = await storeFile(host.fileService, Buffer.from("child image"), "a.png", { source: FileSource.UnitEmbedded, assign: "child-unit" });
      return { unitID, childFile };
    }

    it("passes an ole loader that reads each child Unit with the caller's context and releases its files", async () => {
      const host = createHost();
      const { unitID, childFile } = await hostWithChild(host);
      const read = vi.spyOn(host.collabService, "getUnitLoadDataWithBlocks");
      const loaded: string[] = [];
      exportMock.mockImplementation(async (_snapshot, options) => {
        const { ole, files } = options as unknown as OnlineOptions;
        const child = await ole.loadOnlineUnit({ unitId: "child-unit", type: UniverType.UNIVER_SHEET });
        loaded.push(child.snapshot.unitID);
        loaded.push(Buffer.from((await files.load({ sourceType: "UUID", source: childFile, unitId: "child-unit" })).bytes).toString());
        return Buffer.from("exported");
      });

      const task = await settle(
        host.service,
        await host.service.createExportTask(
          { type: UniverType.UNIVER_SHEET, unitID, format: "xlsx", options: { oleAttachmentSource: "online" } },
          alice
        )
      );

      expect(task.status).toBe("done");
      expect(exportMock.mock.lastCall![1]).toMatchObject({ ole: { attachmentSource: "online", loadOnlineUnit: expect.any(Function) } });
      expect(loaded).toEqual(["child-unit", "child image"]);
      expect(read).toHaveBeenCalledWith(
        { unitID: "child-unit", type: UniverType.UNIVER_SHEET, revision: 0 },
        expect.objectContaining({ userID: "alice" })
      );
    });

    it("fails the task when the caller may not read a child Unit", async () => {
      const host = createHost();
      const { unitID } = await hostWithChild(host);
      host.collabService.use("readUnitData", async (ctx, next) => {
        if (ctx.request.unitID === "child-unit") throw new CollabError("PERMISSION_DENIED", "No view permission");
        await next();
      });
      exportMock.mockImplementation(async (_snapshot, options) => {
        await (options as unknown as OnlineOptions).ole.loadOnlineUnit({ unitId: "child-unit", type: UniverType.UNIVER_SHEET });
        return Buffer.from("exported");
      });

      const task = await settle(
        host.service,
        await host.service.createExportTask(
          { type: UniverType.UNIVER_SHEET, unitID, format: "xlsx", options: { oleAttachmentSource: "online" } },
          alice
        )
      );

      expect(task).toMatchObject({ status: "failed", error: expect.objectContaining({ code: "PERMISSION_DENIED" }) });
    });

    it("releases a child Unit's files only after that Unit was loaded", async () => {
      const host = createHost();
      const { unitID, childFile } = await hostWithChild(host);
      exportMock.mockImplementation(async (_snapshot, options) => {
        await (options as unknown as OnlineOptions).files.load({ sourceType: "UUID", source: childFile, unitId: "child-unit" });
        return Buffer.from("exported");
      });

      const task = await settle(
        host.service,
        await host.service.createExportTask(
          { type: UniverType.UNIVER_SHEET, unitID, format: "xlsx", options: { oleAttachmentSource: "online" } },
          alice
        )
      );

      expect(task).toMatchObject({ status: "failed", error: expectServiceError("FILE_NOT_FOUND") });
    });

    it("applies to jsonID exports as well", async () => {
      const host = createHost();
      await createSheetUnit(host, "child-unit");
      const jsonID = await storeFile(host.fileService, encodeSnapshotJson({ snapshot: sheetSnapshot("json-unit"), sheetBlocks: [] }), "s.json");
      const loaded: string[] = [];
      exportMock.mockImplementation(async (_snapshot, options) => {
        const child = await (options as unknown as OnlineOptions).ole.loadOnlineUnit({ unitId: "child-unit", type: UniverType.UNIVER_SHEET });
        loaded.push(child.snapshot.unitID);
        return Buffer.from("exported");
      });

      const task = await settle(
        host.service,
        await host.service.createExportTask(
          { type: UniverType.UNIVER_SHEET, jsonID, format: "xlsx", options: { oleAttachmentSource: "online" } },
          alice
        )
      );

      expect(task.status).toBe("done");
      expect(loaded).toEqual(["child-unit"]);
    });
  });

  it("materializes a unitID export in-process when the runtime asks for it", async () => {
    const host = createHost({ runtime: { execution: { mode: "in-process" } } });
    const unitID = await createSheetUnit(host);

    const task = await settle(
      host.service,
      await host.service.createExportTask({ type: UniverType.UNIVER_SHEET, unitID, format: "xlsx" }, alice)
    );

    expect(task.status).toBe("done");
    expect(exportMock.mock.lastCall![0].snapshot.unitID).toBe(unitID);
  });

  it("returns the readUnitData rejection in the request and creates no task", async () => {
    const host = createHost();
    const unitID = await createSheetUnit(host);
    host.collabService.use("readUnitData", async (ctx, next) => {
      if (ctx.userID === "bob") throw new CollabError("PERMISSION_DENIED", "No view permission");
      await next();
    });
    const middleware = vi.fn();
    host.service.use("export", middleware);

    await expect(
      host.service.createExportTask({ type: UniverType.UNIVER_SHEET, unitID, format: "xlsx" }, bob)
    ).rejects.toMatchObject({ name: "CollabError", code: "PERMISSION_DENIED" });
    expect(middleware).not.toHaveBeenCalled();
    expect(exportMock).not.toHaveBeenCalled();
  });

  it("exports by unitID with mapped options, a files loader and a named result file", async () => {
    const host = createHost();
    const unitID = await createSheetUnit(host);
    const seen: ExportMiddlewareContext[] = [];
    host.service.use("export", async (ctx, next) => {
      seen.push(ctx);
      await next();
    });

    const task = await settle(
      host.service,
      await host.service.createExportTask(
        { type: UniverType.UNIVER_SHEET, unitID, format: "xlsx", options: { oleAttachmentSource: "original", sheet: { useImageUrl: true } } },
        alice
      )
    );

    expect(seen[0]!.request).toEqual({
      type: UniverType.UNIVER_SHEET,
      unitID,
      format: "xlsx",
      options: { oleAttachmentSource: "original", sheet: { useImageUrl: true } },
    });
    expect(seen[0]!.snapshot).toBeUndefined();
    const [snapshot, options] = exportMock.mock.lastCall!;
    expect(snapshot.snapshot.unitID).toBe(unitID);
    expect(options).toMatchObject({ type: UniverType.UNIVER_SHEET, format: "xlsx", files: { load: expect.any(Function) } });
    expect(options).not.toHaveProperty("ole");
    expect(options).not.toHaveProperty("useImageUrl");
    if (task.status !== "done" || task.kind !== "export") throw new Error("export failed");
    expect(await host.fileService.getFile(task.result.fileID, alice)).toMatchObject({
      name: "Budget.xlsx",
      source: FileSource.HttpExport,
      assign: "alice",
    });
  });

  it("maps CSV selectors and leaves files out of CSV exports", async () => {
    const host = createHost();
    const unitID = await createSheetUnit(host);
    await settle(
      host.service,
      await host.service.createExportTask(
        { type: UniverType.UNIVER_SHEET, unitID, format: "tsv", options: { sheet: { csv: { sheetId: "s1" } } } },
        alice
      )
    );
    expect(exportMock.mock.lastCall![1]).toEqual({ type: UniverType.UNIVER_SHEET, format: "tsv", csv: { worksheetId: "s1" } });
  });

  it("decodes a jsonID upload, shows the snapshot to export middleware and deletes the upload", async () => {
    const host = createHost();
    const jsonID = await storeFile(host.fileService, encodeSnapshotJson({ snapshot: sheetSnapshot("json-unit"), sheetBlocks: [] }), "s.json");
    const seen: ExportMiddlewareContext[] = [];
    host.service.use("export", async (ctx, next) => {
      seen.push(ctx);
      await next();
    });

    const task = await settle(
      host.service,
      await host.service.createExportTask({ type: UniverType.UNIVER_SHEET, jsonID, format: "xlsx" }, alice)
    );

    expect(task.status).toBe("done");
    expect(seen[0]!.request).toEqual({ type: UniverType.UNIVER_SHEET, jsonID, format: "xlsx" });
    expect(seen[0]!.snapshot?.snapshot.unitID).toBe("json-unit");
    expect(exportMock.mock.lastCall![0]).toBe(seen[0]!.snapshot);
    expect(await host.fileService.getFile(jsonID, alice)).toBeNull();
  });

  it("rejects a jsonID upload that is not the caller's, not JSON or of another type", async () => {
    const host = createHost();
    const bobs = await storeFile(host.fileService, encodeSnapshotJson({ snapshot: sheetSnapshot("u"), sheetBlocks: [] }), "s.json", { context: bob });
    const broken = await storeFile(host.fileService, Buffer.from("{"), "s.json");
    const doc = await storeFile(
      host.fileService,
      encodeSnapshotJson({ snapshot: { ...sheetSnapshot("u"), type: UniverType.UNIVER_DOC }, sheetBlocks: [] }),
      "s.json"
    );
    const exportJson = (jsonID: string) =>
      host.service.createExportTask({ type: UniverType.UNIVER_SHEET, jsonID, format: "xlsx" }, alice);

    await expect(exportJson(bobs)).rejects.toEqual(expectServiceError("FILE_NOT_FOUND"));
    await expect(exportJson(broken)).rejects.toEqual(expectServiceError("INVALID_REQUEST"));
    await expect(exportJson(doc)).rejects.toThrow("does not match");
  });

  it("fails the task with the exchange-node error and keeps no result file", async () => {
    const host = createHost();
    const unitID = await createSheetUnit(host);
    exportMock.mockRejectedValue(Object.assign(new Error("Export quota exceeded"), { name: "ExchangeError", code: "LICENSE_EXPORT_QUOTA_EXCEEDED" }));

    const task = await settle(host.service, await host.service.createExportTask({ type: UniverType.UNIVER_SHEET, unitID, format: "xlsx" }, alice));

    expect(task).toMatchObject({ status: "failed", error: { code: "LICENSE_EXPORT_QUOTA_EXCEEDED" } });
    expect(await listFiles(host.fileService, FileSource.HttpExport)).toEqual([]);
  });
});

describe("tasks and lifecycle", () => {
  it("hides a task from everyone but its creator", async () => {
    const { service, fileService } = createHost();
    const fileID = await storeFile(fileService, Buffer.from("x"), "a.xlsx");
    const taskID = await service.createImportTask({ type: UniverType.UNIVER_SHEET, outputType: 1, fileID }, alice);

    await expect(service.getTask(taskID, bob)).rejects.toEqual(expectServiceError("TASK_NOT_FOUND"));
    await expect(service.getTask("missing", alice)).rejects.toEqual(expectServiceError("TASK_NOT_FOUND"));
    await settle(service, taskID);
  });

  it("passes the runtime execution to the snapshot materializer", () => {
    expect(() => createHost({ runtime: { execution: { mode: "worker", workerCount: 0 } } })).toThrow(
      new TypeError("workerCount must be a positive safe integer")
    );
  });

  it("requires a userID", async () => {
    const { service } = createHost();
    await expect(service.getTask("t", { userID: "" })).rejects.toEqual(expectServiceError("INVALID_REQUEST"));
  });

  it("rejects every call after dispose and drops a conversion that finishes later", async () => {
    const host = createHost();
    const create = vi.spyOn(host.collabService, "createUnitFromSnapshot");
    let finish!: () => void;
    importMock.mockImplementation(async (_bytes, options) => {
      await new Promise<void>((resolve) => (finish = resolve));
      return { snapshot: sheetSnapshot((options as { unitId: string }).unitId), sheetBlocks: [] };
    });
    const fileID = await storeFile(host.fileService, Buffer.from("x"), "a.xlsx");
    const taskID = await host.service.createImportTask({ type: UniverType.UNIVER_SHEET, outputType: 1, fileID }, alice);
    await vi.waitFor(() => expect(importMock).toHaveBeenCalled());

    await host.service.dispose();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(create).not.toHaveBeenCalled();
    expect(await host.fileService.getFile(fileID, alice)).not.toBeNull();
    await expect(host.service.getTask(taskID, alice)).rejects.toEqual(expectServiceError("SERVICE_DISPOSED"));
    await expect(
      host.service.createImportTask({ type: UniverType.UNIVER_SHEET, outputType: 1, fileID }, alice)
    ).rejects.toEqual(expectServiceError("SERVICE_DISPOSED"));
    expect(() => host.service.use("import", vi.fn())).toThrow(ExchangeServiceError);
  });
});
