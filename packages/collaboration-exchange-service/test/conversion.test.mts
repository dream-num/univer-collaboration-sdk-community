import { FileSource } from "@univerjs-pro/collaboration-file-service";
import { CollabError } from "@univerjs-pro/collaboration-service";
import { importBufferToSnapshot, type BufferImportOptions } from "@univerjs-pro/exchange-node";
import { UniverType } from "@univerjs/protocol";
import { describe, expect, it } from "vitest";
import { ExchangeFiles } from "../src/files.js";
import { decodeSnapshotJson, encodeSnapshotJson } from "../src/snapshot-json.js";
import { alice, createHost, fixture, listFiles, readStoredFile, settle, storeFile } from "./helpers.mjs";

// End-to-end cases with real exchange-node conversions: import to a collaboration Unit or JSON, export to
// an HttpExport file. A successful export uses the machine's monthly export quota (10 per month on Free),
// so export cases are skipped unless EXCHANGE_REAL_EXPORT=1 is set.
const realExport = process.env.EXCHANGE_REAL_EXPORT === "1";

describe("import", () => {
  it.each([
    ["seed.xlsx", UniverType.UNIVER_SHEET],
    ["seed.xls", UniverType.UNIVER_SHEET],
    ["seed.docx", UniverType.UNIVER_DOC],
    ["seed.doc", UniverType.UNIVER_DOC],
    ["seed.pptx", UniverType.UNIVER_SLIDE],
  ] as const)("imports %s into a new collaborative Unit and deletes the upload", async (name, type) => {
    const { service, collabService, fileService } = createHost();
    const fileID = await storeFile(fileService, await fixture(name), name);

    const task = await settle(service, await service.createImportTask({ type, outputType: 1, fileID }, alice));

    expect(task).toMatchObject({ kind: "import", status: "done", result: { outputType: 1 } });
    const unitID = task.status === "done" && task.kind === "import" && task.result.outputType === 1 ? task.result.unitID : "";
    const unit = await collabService.getUnitLoadData({ unitID, type, revision: 0 }, alice);
    expect(unit.snapshot).toMatchObject({ unitID, type, rev: 1 });
    expect(await fileService.getFile(fileID, alice)).toBeNull();
  });

  it("stores embedded attachments as UnitEmbedded files of the new Unit", async () => {
    const { service, fileService } = createHost();
    const fileID = await storeFile(fileService, await fixture("nested-ole.pptx"), "nested-ole.pptx");

    const task = await settle(
      service,
      await service.createImportTask({ type: UniverType.UNIVER_SLIDE, outputType: 1, fileID }, alice)
    );

    if (task.status !== "done" || task.kind !== "import" || task.result.outputType !== 1) throw new Error("import failed");
    const embedded = await listFiles(fileService, FileSource.UnitEmbedded);
    expect(embedded.length).toBeGreaterThan(0);
    expect(embedded.every((record) => record.assign === (task.result as { unitID: string }).unitID)).toBe(true);
  });

  it("removes the stored attachments when createUnit rejects the import", async () => {
    const { service, collabService, fileService } = createHost();
    collabService.use("createUnit", () => {
      throw new CollabError("PERMISSION_DENIED", "No create permission");
    });
    const fileID = await storeFile(fileService, await fixture("nested-ole.pptx"), "nested-ole.pptx");

    const task = await settle(
      service,
      await service.createImportTask({ type: UniverType.UNIVER_SLIDE, outputType: 1, fileID }, alice)
    );

    expect(task.status).toBe("failed");
    expect(task.status === "failed" && task.error).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await listFiles(fileService, FileSource.UnitEmbedded)).toEqual([]);
    expect(await fileService.getFile(fileID, alice)).toBeNull();
  });

  it("returns snapshot JSON for outputType 2 with images kept inline", async () => {
    const { service, fileService } = createHost();
    const fileID = await storeFile(fileService, await fixture("nested-ole.pptx"), "nested-ole.pptx");

    const task = await settle(
      service,
      await service.createImportTask({ type: UniverType.UNIVER_SLIDE, outputType: 2, fileID }, alice)
    );

    if (task.status !== "done" || task.kind !== "import" || task.result.outputType !== 2) throw new Error("import failed");
    const record = await fileService.getFile(task.result.jsonID, alice);
    expect(record).toMatchObject({ source: FileSource.HttpExport, assign: "alice", contentType: "application/json", name: "nested-ole.json" });
    const decoded = decodeSnapshotJson(await readStoredFile(fileService, task.result.jsonID));
    expect(decoded.snapshot.type).toBe(UniverType.UNIVER_SLIDE);
    expect(await listFiles(fileService, FileSource.UnitEmbedded)).toEqual([]);
  });

  it("fails the task with the exchange-node error for a file that is not the claimed format", async () => {
    const { service, fileService } = createHost();
    const fileID = await storeFile(fileService, Buffer.from("not a workbook"), "broken.xlsx");

    const task = await settle(
      service,
      await service.createImportTask({ type: UniverType.UNIVER_SHEET, outputType: 1, fileID }, alice)
    );

    expect(task.status).toBe("failed");
    expect(task.status === "failed" && task.error).toMatchObject({ name: "ExchangeError" });
    expect(await fileService.getFile(fileID, alice)).toBeNull();
  });
});

describe.skipIf(!realExport)("export", () => {
  async function importUnit(host: ReturnType<typeof createHost>, name: string, type: UniverType): Promise<string> {
    const fileID = await storeFile(host.fileService, await fixture(name), name);
    const task = await settle(host.service, await host.service.createImportTask({ type, outputType: 1, fileID }, alice));
    if (task.status !== "done" || task.kind !== "import" || task.result.outputType !== 1) throw new Error("import failed");
    return task.result.unitID;
  }

  it.each([
    ["seed.xlsx", UniverType.UNIVER_SHEET, "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["seed.docx", UniverType.UNIVER_DOC, "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["nested-ole.pptx", UniverType.UNIVER_SLIDE, "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ] as const)("exports a %s Unit by unitID into an HttpExport file", async (name, type, format, contentType) => {
    const host = createHost();
    const unitID = await importUnit(host, name, type);

    const task = await settle(host.service, await host.service.createExportTask({ type, unitID, format }, alice));

    if (task.status !== "done" || task.kind !== "export") throw new Error(`export failed: ${String((task as { error?: unknown }).error)}`);
    const record = await host.fileService.getFile(task.result.fileID, alice);
    expect(record).toMatchObject({ source: FileSource.HttpExport, assign: "alice", contentType });
    expect(record?.name.endsWith(`.${format}`)).toBe(true);
    expect((await readStoredFile(host.fileService, task.result.fileID)).subarray(0, 2).toString()).toBe("PK");
  });

  it("exports a Sheet worksheet as CSV with the requested sheetId", async () => {
    const host = createHost();
    const unitID = await importUnit(host, "seed.xlsx", UniverType.UNIVER_SHEET);
    const unit = await host.collabService.getUnitLoadData({ unitID, type: UniverType.UNIVER_SHEET, revision: 0 }, alice);
    const sheetId = unit.snapshot.workbook!.sheetOrder[0]!;

    const task = await settle(
      host.service,
      await host.service.createExportTask(
        { type: UniverType.UNIVER_SHEET, unitID, format: "csv", options: { sheet: { csv: { sheetId } } } },
        alice
      )
    );

    if (task.status !== "done" || task.kind !== "export") throw new Error("export failed");
    expect(await host.fileService.getFile(task.result.fileID, alice)).toMatchObject({ contentType: "text/csv; charset=utf-8" });
  });

  // These two cases build the snapshot through files.store without the Runtime, so files.load and the
  // exchange-node attachment check are exercised for real.
  async function snapshotWithStoredAttachments(host: ReturnType<typeof createHost>, unitId: string) {
    const files = new ExchangeFiles(host.fileService, host.logger);
    return importBufferToSnapshot(await fixture("nested-ole.pptx"), {
      type: UniverType.UNIVER_SLIDE,
      fileName: "nested-ole.pptx",
      unitId,
      files: { store: files.createUnitFileSink(unitId, alice).store },
    } as BufferImportOptions);
  }

  it("exports an uploaded snapshot JSON with its stored attachments and deletes the upload", async () => {
    const host = createHost();
    const snapshot = await snapshotWithStoredAttachments(host, "json-unit");
    const jsonID = await storeFile(host.fileService, encodeSnapshotJson(snapshot), "snapshot.json");

    const task = await settle(
      host.service,
      await host.service.createExportTask({ type: UniverType.UNIVER_SLIDE, jsonID, format: "pptx" }, alice)
    );

    if (task.status !== "done" || task.kind !== "export") throw new Error(`export failed: ${String((task as { error?: unknown }).error)}`);
    expect((await readStoredFile(host.fileService, task.result.fileID)).subarray(0, 2).toString()).toBe("PK");
    expect(await host.fileService.getFile(jsonID, alice)).toBeNull();
  });

  it("fails a jsonID export whose stored attachments belong to another Unit", async () => {
    const host = createHost();
    const snapshot = await snapshotWithStoredAttachments(host, "real-unit");
    const forged = { ...snapshot, snapshot: { ...snapshot.snapshot, unitID: "forged-unit" } };
    const jsonID = await storeFile(host.fileService, encodeSnapshotJson(forged), "snapshot.json");

    const task = await settle(
      host.service,
      await host.service.createExportTask({ type: UniverType.UNIVER_SLIDE, jsonID, format: "pptx" }, alice)
    );

    // The placeholder is rejected by exchange-node's attachment check.
    expect(task).toMatchObject({ status: "failed", error: { code: "INVALID_FILE" } });
    expect(task.status === "failed" && String(task.error)).toContain("integrity mismatch");
    expect(await listFiles(host.fileService, FileSource.HttpExport)).toEqual([]);
  });
});
