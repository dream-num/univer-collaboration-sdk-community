import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChangeset, createDatabaseContext, createSnapshot } from "@univerjs-pro/collaboration-database-testkit";
import { UniverType } from "@univerjs/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SQLiteDatabaseAdapter, migrateSQLiteCoreV1ToV2, migrateSQLiteCoreV2ToV3 } from "../../src/index.js";
import { createV1Database, encodeLegacy, exec } from "./fixtures.mjs";

let directory: string;
let filename: string;
const context = createDatabaseContext();
const type = UniverType.UNIVER_DOC;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "univer-collab-chain-"));
  filename = join(directory, "collaboration.sqlite");
  createV1Database(filename);
  exec(filename, `
    INSERT INTO collaboration_units VALUES ('active', ${type}, 2, NULL), ('deleted', ${type}, 1, 123);
    INSERT INTO collaboration_unit_tombstones VALUES ('gone', 456);
    INSERT INTO collaboration_snapshots VALUES
      ('active', 1, ${type}, '${encodeLegacy(createSnapshot("active", type, 1))}'),
      ('deleted', 1, ${type}, '${encodeLegacy(createSnapshot("deleted", type, 1))}');
    INSERT INTO collaboration_changesets VALUES
      ('active', 2, 1, 's', 1, '${encodeLegacy(createChangeset({ unitID: "active", type, revision: 2, sid: "s", reqId: 1 }))}');
  `);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("migrates a v1 database through v2 to v3 and serves it with the adapter", async () => {
  await migrateSQLiteCoreV1ToV2({
    filename,
    resolveUnitCreation: (unitID) => ({ creatorID: `creator-${unitID}`, createdAt: 1700000000000 }),
    resolveChangesetCreatedAt: () => 1700000000123,
  });
  await migrateSQLiteCoreV2ToV3({ filename });

  const adapter = new SQLiteDatabaseAdapter({ filename });
  try {
    await expect(adapter.getUnit(context, "active")).resolves.toEqual({
      unitID: "active", type, headRevision: 2, creatorID: "creator-active", createdAt: 1700000000000,
    });
    await expect(adapter.getSnapshot(context, "active")).resolves.toEqual(createSnapshot("active", type, 1));
    const changesets = await adapter.getChangesets(context, "active", { from: 1 });
    expect(changesets).toHaveLength(1);
    expect(changesets?.[0]?.createTime).toBe(1700000000);

    await expect(adapter.recoverUnits(context, { unitIDs: ["deleted"] })).resolves.toEqual({
      units: [{ unitID: "deleted", status: "recovered" }],
    });
    await expect(adapter.getUnit(context, "deleted")).resolves.toMatchObject({ creatorID: "creator-deleted" });
    await expect(adapter.recoverUnits(context, { unitIDs: ["gone"] })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await expect(
      adapter.commitChangeset(context, {
        changeset: createChangeset({ unitID: "active", type, revision: 3, sid: "s", reqId: 2 }),
      }),
    ).resolves.toMatchObject({ status: "committed", headRevision: 3 });
  } finally {
    await adapter.dispose();
  }
});
