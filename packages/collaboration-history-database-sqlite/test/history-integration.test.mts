import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteDatabaseAdapter } from "@univerjs-pro/collaboration-database-sqlite";
import {
  createChangeset,
  createDatabaseContext,
  createSnapshot,
  createUnitRecord,
} from "@univerjs-pro/collaboration-database-testkit";
import { DefaultHistoryPolicy, UniverHistoryService } from "@univerjs-pro/collaboration-history-service";
import { CollabError, UniverCollabService } from "@univerjs-pro/collaboration-service";
import { UniverType } from "@univerjs/protocol";
import { expect, it, vi } from "vitest";
import { SQLiteHistoryDatabaseAdapter } from "../src/index.js";

// The History Service indexes real core persistence in the same SQLite file and reads it back
// through a reopened adapter, with core read permissions and Unit deletion honored.
it("indexes core persistence in a shared file, reopens it and hides deleted Units", async () => {
  const directory = await mkdtemp(join(tmpdir(), "univer-collab-history-integration-"));
  const filename = join(directory, "collaboration.sqlite");
  const core = new SQLiteDatabaseAdapter({ filename });
  const history = new SQLiteHistoryDatabaseAdapter({ filename });
  const collabService = new UniverCollabService({ runtime: { execution: { mode: "in-process" } }, dbAdapter: core });
  let allowRead = true;
  collabService.use("readUnitData", async (_ctx, next) => {
    if (!allowRead) throw new CollabError("PERMISSION_DENIED", "Read denied");
    await next();
  });
  const context = createDatabaseContext();
  const record = createUnitRecord("u", UniverType.UNIVER_DOC);
  const time = vi.spyOn(Date, "now").mockReturnValue(record.createdAt + 1000);
  const service = new UniverHistoryService({
    collabService,
    dbAdapter: history,
    policy: new DefaultHistoryPolicy({ timeIntervalMs: 0 }),
  });
  try {
    await core.createUnit(context, { record, snapshot: createSnapshot("u", record.type, 1) });
    for (let revision = 2; revision <= 4; revision++) {
      await core.commitChangeset(context, {
        changeset: createChangeset({ unitID: "u", type: record.type, revision, sid: "s", reqId: revision }),
      });
    }
    const first = await service.getHistoryList({ unitID: "u", length: 2 }, context);
    expect(first.historyIds).toEqual(["u:4", "u:3"]);
    await service.dispose();

    const reopened = new SQLiteHistoryDatabaseAdapter({ filename });
    const reader = new UniverHistoryService({ collabService, dbAdapter: reopened });
    try {
      const next = await reader.getHistoryList({ unitID: "u", length: 2, lastLabel: first.lastLabel }, context);
      expect(next.historyIds).toEqual(["u:2", "u:1"]);
      expect(next.entities.datas["u:1"]?.createTime).toBe(String(record.createdAt));
      allowRead = false;
      await expect(reader.getHistoryList({ unitID: "u", length: 2 }, context)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      allowRead = true;
      await core.deleteUnits(context, { unitIDs: ["u"], hardDelete: false });
      await expect(reader.getHistoryList({ unitID: "u", length: 2 }, context)).rejects.toMatchObject({
        code: "UNIT_NOT_FOUND",
      });
    } finally {
      await reader.dispose();
      await reopened.dispose();
    }
  } finally {
    time.mockRestore();
    await service.dispose();
    await collabService.dispose();
    await history.dispose();
    await core.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
