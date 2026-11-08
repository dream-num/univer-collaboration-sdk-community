import { UniverType, type ISnapshot } from "@univerjs/protocol";
import { describe, expect, it } from "vitest";
import { decodeSnapshotJson, encodeSnapshotJson } from "../src/snapshot-json.js";

const text = (value: string) => new TextEncoder().encode(value);
const base64 = (value: string) => Buffer.from(value).toString("base64");

function json(value: unknown): Uint8Array {
  return text(JSON.stringify(value));
}

describe("decodeSnapshotJson", () => {
  it("decodes the format exchange-client uploads for a Sheet", () => {
    // Output of the frontend transformWorkbookSnapshotMetaToString: doc is an empty object, and
    // slide/board/pdf are dropped by JSON.
    const decoded = decodeSnapshotJson(
      json({
        snapshot: {
          unitID: "u",
          type: UniverType.UNIVER_SHEET,
          rev: 3,
          workbook: {
            unitID: "u",
            name: "表格",
            originalMeta: base64('{"name":"表格"}'),
            sheets: { s1: { id: "s1", originalMeta: base64('{"id":"s1"}') } },
          },
          doc: {},
        },
        sheetBlocks: { b1: { id: "b1", startRow: 0, endRow: 9, data: base64("[]") } },
      })
    );

    const workbook = decoded.snapshot.workbook!;
    expect(new TextDecoder().decode(workbook.originalMeta)).toBe('{"name":"表格"}');
    expect(new TextDecoder().decode(workbook.sheets.s1!.originalMeta)).toBe('{"id":"s1"}');
    expect(decoded.snapshot.doc).toBeUndefined();
    expect(decoded.sheetBlocks).toHaveLength(1);
    expect(decoded.sheetBlocks[0]).toMatchObject({ id: "b1", startRow: 0, endRow: 9 });
    expect(new TextDecoder().decode(decoded.sheetBlocks[0]!.data)).toBe("[]");
  });

  it.each([
    ["doc", UniverType.UNIVER_DOC],
    ["slide", UniverType.UNIVER_SLIDE],
    ["board", UniverType.UNIVER_BOARD],
    ["pdf", UniverType.UNIVER_PDF],
  ] as const)("decodes originalMeta of %s meta and defaults sheetBlocks to empty", (field, type) => {
    const decoded = decodeSnapshotJson(json({ snapshot: { unitID: "u", type, rev: 1, [field]: { originalMeta: base64("{}") } } }));
    expect(new TextDecoder().decode(decoded.snapshot[field]!.originalMeta)).toBe("{}");
    expect(decoded.sheetBlocks).toEqual([]);
  });

  it.each([
    ["invalid JSON", text("{")],
    ["a non-object root", json([])],
    ["a missing snapshot", json({})],
    ["a missing unitID", json({ snapshot: { type: 2, rev: 1 } })],
    ["a non-numeric type", json({ snapshot: { unitID: "u", type: "2", rev: 1 } })],
    ["a missing rev", json({ snapshot: { unitID: "u", type: 2 } })],
    ["a meta without originalMeta", json({ snapshot: { unitID: "u", type: 2, rev: 1, workbook: { name: "x" } } })],
    ["a worksheet without originalMeta", json({ snapshot: { unitID: "u", type: 2, rev: 1, workbook: { originalMeta: "", sheets: { s: {} } } } })],
    ["a block without id", json({ snapshot: { unitID: "u", type: 2, rev: 1 }, sheetBlocks: { b: { data: "" } } })],
    ["a block without data", json({ snapshot: { unitID: "u", type: 2, rev: 1 }, sheetBlocks: { b: { id: "b" } } })],
  ])("rejects %s with INVALID_REQUEST", (_case, bytes) => {
    expect(() => decodeSnapshotJson(bytes)).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});

describe("encodeSnapshotJson", () => {
  it("round-trips binary fields and keys sheet blocks by id", () => {
    const snapshot: ISnapshot = {
      unitID: "u",
      type: UniverType.UNIVER_SHEET,
      rev: 1,
      workbook: {
        unitID: "u",
        rev: 1,
        creator: "",
        name: "表格",
        sheetOrder: ["s1"],
        sheets: { s1: { type: 0, id: "s1", name: "S", rowCount: 1, columnCount: 1, originalMeta: text('{"id":"s1"}') } },
        resources: [],
        blockMeta: {},
        originalMeta: text('{"name":"表格"}'),
      },
      doc: undefined,
      slide: undefined,
      board: undefined,
    };
    const sheetBlocks = [{ id: "b1", startRow: 0, endRow: 1, data: text("[1]") }];

    const encoded = encodeSnapshotJson({ snapshot, sheetBlocks });

    const raw = JSON.parse(Buffer.from(encoded).toString());
    expect(raw.snapshot.workbook.originalMeta).toBe(base64('{"name":"表格"}'));
    expect(Object.keys(raw.sheetBlocks)).toEqual(["b1"]);
    const decoded = decodeSnapshotJson(encoded);
    expect(decoded.snapshot.workbook).toEqual(snapshot.workbook);
    expect(decoded.sheetBlocks).toEqual(sheetBlocks);
  });
});
