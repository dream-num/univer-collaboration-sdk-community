import {
  createChangeset,
  createDatabaseContext,
  createSheetBlock,
  createSnapshot,
  createUnitRecord,
  databaseAdapterContract,
} from "@univerjs-pro/collaboration-database-testkit";
import { UniverType } from "@univerjs/protocol";
import { describe, expect, it } from "vitest";
import { MemoryDatabaseAdapter } from "../src/memory-database-adapter.js";

databaseAdapterContract("MemoryDatabaseAdapter", () => {
  const adapter = new MemoryDatabaseAdapter();
  return {
    adapter,
    dispose: () => adapter.dispose(),
  };
});

describe("MemoryDatabaseAdapter atomic publication", () => {
  it("does not expose partial snapshot dependencies when staging fails", async () => {
    const adapter = new MemoryDatabaseAdapter();
    const context = createDatabaseContext();
    const unitID = "unit-snapshot-staging-failure";
    const type = UniverType.UNIVER_SHEET;
    const initial = createSnapshot(unitID, type, 1);
    await adapter.createUnit(context, {
      record: createUnitRecord(unitID, type),
      snapshot: initial,
    });
    await adapter.commitChangeset(context, {
      changeset: createChangeset({
        unitID,
        type,
        revision: 2,
        sid: "sid-staging-failure",
        reqId: 1,
      }),
    });

    const invalidBlock = {
      ...createSheetBlock("block-invalid", 2),
      data: (() => undefined) as unknown as Uint8Array,
    };

    await expect(
      adapter.saveSnapshot(context, {
        snapshot: createSnapshot(unitID, type, 2),
        sheetBlocks: [
          createSheetBlock("block-must-not-leak", 2),
          invalidBlock,
        ],
      })
    ).rejects.toThrow();

    await expect(
      adapter.getSheetBlock(context, unitID, "block-must-not-leak")
    ).resolves.toBeNull();
    await expect(
      adapter.getSnapshot(context, unitID, { revision: 2 })
    ).resolves.toEqual(initial);
  });
});
