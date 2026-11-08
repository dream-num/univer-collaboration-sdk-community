import { FileSource } from "@univerjs-pro/collaboration-file-service";
import { describe, expect, it, vi } from "vitest";
import { ExchangeFiles } from "../src/files.js";
import { alice, createHost, listFiles, readStoredFile, storeFile } from "./helpers.mjs";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function setup() {
  const host = createHost();
  return { ...host, files: new ExchangeFiles(host.fileService, host.logger) };
}

function uuidRef(source: string, unitId: string) {
  return { sourceType: "UUID", source, unitId } as const;
}

describe("exportLoader with a trusted host", () => {
  it("loads an UnitEmbedded file of the exported Unit", async () => {
    const { files, fileService } = setup();
    const fileID = await storeFile(fileService, Buffer.from("image"), "a.png", { source: FileSource.UnitEmbedded, assign: "unit-1" });

    const { bytes } = await files.exportLoader("unit-1", alice, { trustedHost: true }).load(uuidRef(fileID, "unit-1"));

    expect(Buffer.from(bytes).toString()).toBe("image");
  });

  it("rejects a reference to another Unit, another Unit's file, a non-embedded file and a missing file", async () => {
    const { files, fileService } = setup();
    const other = await storeFile(fileService, Buffer.from("x"), "a.png", { source: FileSource.UnitEmbedded, assign: "unit-2" });
    const upload = await storeFile(fileService, Buffer.from("x"), "a.png", { assign: "unit-1" });
    const { load } = files.exportLoader("unit-1", alice, { trustedHost: true });

    await expect(load(uuidRef(other, "unit-2"))).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await expect(load(uuidRef(other, "unit-1"))).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await expect(load(uuidRef(upload, "unit-1"))).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await expect(load(uuidRef("missing", "unit-1"))).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("loads files of online child Units once they are listed and still rejects their foreign files", async () => {
    const { files, fileService } = setup();
    const childFile = await storeFile(fileService, Buffer.from("child"), "a.png", { source: FileSource.UnitEmbedded, assign: "child-1" });
    const hostFile = await storeFile(fileService, Buffer.from("host"), "a.png", { source: FileSource.UnitEmbedded, assign: "unit-1" });
    const children = new Set<string>();
    const { load } = files.exportLoader("unit-1", alice, { trustedHost: true, children });

    await expect(load(uuidRef(childFile, "child-1"))).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    children.add("child-1");
    expect(Buffer.from((await load(uuidRef(childFile, "child-1"))).bytes).toString()).toBe("child");
    await expect(load(uuidRef(hostFile, "child-1"))).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await expect(load(uuidRef(childFile, "unit-1"))).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("returns the placeholder for URL images without fetching them", async () => {
    const { files } = setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { bytes } = await files.exportLoader("unit-1", alice, { trustedHost: true }).load({ sourceType: "URL", source: "http://169.254.169.254/", unitId: "unit-1" });

    expect([...bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("exportLoader with a client-supplied host", () => {
  it("loads files of snapshot.unitID and answers everything else with the placeholder", async () => {
    const { files, fileService } = setup();
    const own = await storeFile(fileService, Buffer.from("image"), "a.png", { source: FileSource.UnitEmbedded, assign: "unit-1" });
    const foreign = await storeFile(fileService, Buffer.from("secret"), "a.png", { source: FileSource.UnitEmbedded, assign: "unit-2" });
    const { load } = files.exportLoader("unit-1", alice, { trustedHost: false });

    expect(Buffer.from((await load(uuidRef(own, "unit-1"))).bytes).toString()).toBe("image");
    for (const ref of [uuidRef(foreign, "unit-1"), uuidRef(foreign, "unit-2"), uuidRef("missing", "unit-1")]) {
      expect([...(await load(ref)).bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
    }
  });

  it("checks online child Units strictly and keeps the placeholder for the client snapshot", async () => {
    const { files, fileService } = setup();
    const childFile = await storeFile(fileService, Buffer.from("child"), "a.png", { source: FileSource.UnitEmbedded, assign: "child-1" });
    const foreign = await storeFile(fileService, Buffer.from("secret"), "a.png", { source: FileSource.UnitEmbedded, assign: "unit-2" });
    const { load } = files.exportLoader("unit-1", alice, { trustedHost: false, children: new Set(["child-1"]) });

    expect(Buffer.from((await load(uuidRef(childFile, "child-1"))).bytes).toString()).toBe("child");
    await expect(load(uuidRef(foreign, "child-1"))).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    expect([...(await load(uuidRef(childFile, "unit-1"))).bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
  });

  it("fails the export on a storage error instead of hiding it behind the placeholder", async () => {
    const { files, fileService } = setup();
    const own = await storeFile(fileService, Buffer.from("image"), "a.png", { source: FileSource.UnitEmbedded, assign: "unit-1" });
    vi.spyOn(fileService, "openFile").mockRejectedValue(new Error("disk unavailable"));

    await expect(files.exportLoader("unit-1", alice, { trustedHost: false }).load(uuidRef(own, "unit-1"))).rejects.toThrow("disk unavailable");
  });
});

describe("createUnitFileSink", () => {
  const imported = { name: "image1.png", mimeType: "image/png", size: 5, bytes: Buffer.from("image") };

  it("stores each file as UnitEmbedded and answers with a reference", async () => {
    const { files, fileService } = setup();

    const result = await files.createUnitFileSink("unit-1", alice).store(imported);

    if (result.mode !== "reference") throw new Error("expected a reference");
    expect(await fileService.getFile(result.source, alice)).toMatchObject({
      name: "image1.png",
      contentType: "image/png",
      source: FileSource.UnitEmbedded,
      assign: "unit-1",
    });
    expect((await readStoredFile(fileService, result.source)).toString()).toBe("image");
  });

  it("discards everything it stored and logs what it could not delete", async () => {
    const { files, fileService, logger } = setup();
    const sink = files.createUnitFileSink("unit-1", alice);
    await sink.store(imported);
    await sink.store(imported);
    const realDelete = fileService.deleteFile.bind(fileService);
    vi.spyOn(fileService, "deleteFile").mockImplementationOnce(async () => {
      throw new Error("disk unavailable");
    }).mockImplementation(realDelete);

    await sink.discard();

    expect(await listFiles(fileService, FileSource.UnitEmbedded)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
