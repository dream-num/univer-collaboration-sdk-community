import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "libsql";
import {
  createChangeset,
  createDatabaseContext,
  createWorktreeRecord,
  createWorktreeUnitSeed,
  createWorktreeUnitRecord,
} from "@univerjs-pro/collaboration-worktree-database-testkit";
import { UniverType } from "@univerjs/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateSQLiteWorktree, migrateSQLiteWorktreeV1ToV2, SQLiteWorktreeDatabaseAdapter } from "../src/index.js";

describe("SQLiteWorktreeDatabaseAdapter", () => {
  let directory: string;
  let filename: string;
  const context = createDatabaseContext();

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), "univer-worktree-sqlite-")
    );
    filename = join(directory, "collaboration.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each([undefined, 0, 2])("uses the revision index bounds for draft reads (to: %s)", async (to) => {
    const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });
    const database = (adapter as unknown as { _database: Database.Database })._database;
    const prepare = database.prepare.bind(database);
    let readSQL = "";
    database.prepare = ((source: string) => {
      if (source.includes("FROM collaboration_worktree_units AS units")) readSQL = source;
      return prepare(source);
    }) as typeof database.prepare;
    try {
      await expect(adapter.getDraftChangesets(context, "worktree", "unit", {
        from: 0, ...(to === undefined ? {} : { to }),
      })).resolves.toBeNull();
      const plan = prepare(`EXPLAIN QUERY PLAN ${readSQL}`)
        .all(0, ...(to === undefined ? [] : [to]), "worktree", "unit") as { detail: string }[];
      const rangeRead = plan.find(({ detail }) => detail.includes("SEARCH changesets "))?.detail;
      expect(rangeRead).toContain("revision>?");
      expect(rangeRead?.includes("revision<?")).toBe(to !== undefined);
    } finally {
      await adapter.dispose();
    }
  });

  it("explicitly upgrades v1 without losing draft data and persists reversible removal across restart", async () => {
    const worktreeID = "migration-removal";
    const unitID = "migration-unit";
    const before = new SQLiteWorktreeDatabaseAdapter({ filename });
    await before.createWorktree(context, {
      record: createWorktreeRecord(worktreeID), units: [createWorktreeUnitRecord({ worktreeID, unitID })],
    });
    await before.commitDraftChangeset(context, {
      unitMetadata: {},
      worktreeID, changeset: createChangeset({ unitID, type: UniverType.UNIVER_SHEET, revision: 2, sid: "migration-draft", reqId: 1 }),
    });
    await before.dispose();
    const legacy = new Database(filename);
    legacy.exec("ALTER TABLE collaboration_worktree_changesets DROP COLUMN created_at_ms; ALTER TABLE collaboration_worktree_changesets DROP COLUMN metadata_json; ALTER TABLE collaboration_worktree_units DROP COLUMN removed; ALTER TABLE collaboration_worktree_units DROP COLUMN creator_id; ALTER TABLE collaboration_worktree_units DROP COLUMN created_at_ms; ALTER TABLE collaboration_worktree_units DROP COLUMN metadata_json;");
    legacy.prepare("UPDATE collaboration_schema_versions SET version = 1 WHERE component = 'worktree'").run();
    legacy.close();
    expect(() => new SQLiteWorktreeDatabaseAdapter({ filename })).toThrow("run migrateSQLiteWorktree first");
    const result = await migrateSQLiteWorktree({
      filename,
      resolveChangesetCreatedAt: () => 1700000000123,
      resolveUnitCreation: async () => ({ creatorID: "original-creator", createdAt: 1700000000123 }),
    });
    expect(result).toEqual({ from: 1, to: 4, backupFilename: `${filename}.worktree-v1.backup` });
    const backup = new Database(result.backupFilename!, { readonly: true });
    try {
      expect(backup.prepare("SELECT version FROM collaboration_schema_versions WHERE component = 'worktree'").get()).toMatchObject({ version: 1 });
      expect(backup.prepare("SELECT unit_id FROM collaboration_worktree_changesets").get()).toMatchObject({ unit_id: unitID });
    } finally {
      backup.close();
    }
    const migrated = new SQLiteWorktreeDatabaseAdapter({ filename });
    expect(await migrated.getWorktreeUnit(context, worktreeID, unitID)).toMatchObject({ creatorID: "original-creator", createdAt: 1700000000123 });
    expect((await migrated.getWorktreeUnit(context, worktreeID, unitID))?.draftHeadRevision).toBe(2);
    expect(await migrated.getDraftChangesets(context, worktreeID, unitID, { from: 1, to: 2 })).toMatchObject([{ createTime: 1700000000, metadata: {} }]);
    await migrated.setUnitRemoved(context, { worktreeID, unitID, removed: true });
    await migrated.dispose();
    const restarted = new SQLiteWorktreeDatabaseAdapter({ filename });
    expect(await restarted.getWorktreeUnit(context, worktreeID, unitID)).toMatchObject({ removed: true, draftHeadRevision: 2 });
    await restarted.setUnitRemoved(context, { worktreeID, unitID, removed: false });
    await restarted.dispose();
    const check = new Database(filename);
    expect(check.prepare("SELECT version FROM collaboration_schema_versions WHERE component = 'worktree'").get()).toMatchObject({ version: 4 });
    expect(check.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    expect(check.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    check.close();
  });

  it("rolls back the v1 upgrade if version publication fails", async () => {
    const initial = new SQLiteWorktreeDatabaseAdapter({ filename });
    await initial.createWorktree(context, {
      record: createWorktreeRecord("rollback-worktree"),
      units: [createWorktreeUnitRecord({ worktreeID: "rollback-worktree", unitID: "rollback-unit" })],
    });
    await initial.dispose();
    const legacy = new Database(filename);
    legacy.exec(`
      ALTER TABLE collaboration_worktree_units DROP COLUMN removed;
      UPDATE collaboration_schema_versions SET version = 1 WHERE component = 'worktree';
      CREATE TRIGGER reject_worktree_upgrade BEFORE UPDATE ON collaboration_schema_versions
      BEGIN SELECT RAISE(ABORT, 'test migration failure'); END;
    `);
    legacy.close();
    expect(() => migrateSQLiteWorktreeV1ToV2({ filename })).toThrow("test migration failure");
    const check = new Database(filename);
    expect(check.prepare("SELECT version FROM collaboration_schema_versions WHERE component = 'worktree'").get()).toMatchObject({ version: 1 });
    const columns = check.prepare("PRAGMA table_info(collaboration_worktree_units)").all() as Array<{ name: string }>;
    expect(columns.some(column => column.name === "removed")).toBe(false);
    expect(check.prepare("SELECT unit_id FROM collaboration_worktree_units").get()).toMatchObject({ unit_id: "rollback-unit" });
    expect(check.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    check.close();
  });

  it("rejects a draft commit after another connection persists removal", async () => {
    const worktreeID = "removal-race";
    const unitID = "removal-race-unit";
    const first = new SQLiteWorktreeDatabaseAdapter({ filename });
    const second = new SQLiteWorktreeDatabaseAdapter({ filename });
    try {
      await first.createWorktree(context, {
        record: createWorktreeRecord(worktreeID),
        units: [createWorktreeUnitRecord({ worktreeID, unitID })],
      });
      await second.setUnitRemoved(context, { worktreeID, unitID, removed: true });
      const result = await first.commitDraftChangeset(context, {
        unitMetadata: {},
        worktreeID,
        changeset: createChangeset({ unitID, type: UniverType.UNIVER_SHEET, revision: 2, sid: "racing-writer", reqId: 1 }),
      });
      expect(result.status).toBe("unit-frozen");
      expect((await second.getWorktreeUnit(context, worktreeID, unitID))?.draftHeadRevision).toBe(1);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it("rolls back changeset metadata and Unit metadata when publishing the head fails", async () => {
    const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });
    const unit = { ...createWorktreeUnitRecord({ worktreeID: "atomic-metadata", unitID: "u" }), metadata: { name: "Before" } };
    await adapter.createWorktree(context, { record: createWorktreeRecord(unit.worktreeID), units: [unit] });
    const control = new Database(filename);
    try {
      control.exec(`CREATE TRIGGER reject_metadata_head BEFORE UPDATE ON collaboration_worktree_units
        BEGIN SELECT RAISE(ABORT, 'head failure'); END;`);
      const changeset = createChangeset({ unitID: "u", type: unit.type, revision: 2, sid: "atomic", reqId: 1, metadata: { actor: "editor" } });
      await expect(adapter.commitDraftChangeset(context, {
        worktreeID: unit.worktreeID, changeset, unitMetadata: { name: "After" },
      })).rejects.toThrow("head failure");
      expect(await adapter.getWorktreeUnit(context, unit.worktreeID, "u")).toMatchObject({ draftHeadRevision: 1, metadata: { name: "Before" } });
      expect(await adapter.getDraftChangesets(context, unit.worktreeID, "u", { from: 1 })).toEqual([]);
      control.exec("DROP TRIGGER reject_metadata_head;");
      await adapter.commitDraftChangeset(context, { worktreeID: unit.worktreeID, changeset, unitMetadata: { name: "After" } });
      expect((await adapter.getWorktreeUnit(context, unit.worktreeID, "u"))!.metadata).toEqual({ name: "After" });
      expect((await adapter.getDraftChangesets(context, unit.worktreeID, "u", { from: 1 }))![0].metadata).toEqual({ actor: "editor" });
    } finally {
      control.close();
      await adapter.dispose();
    }
  });

  it("stores application metadata separately from the protocol changeset payload", async () => {
    const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });
    const unit = createWorktreeUnitRecord({ worktreeID: "metadata-storage", unitID: "u" });
    const metadata = JSON.parse('{"__proto__":{"label":"application"},"tag":{"__univerCollaborationBinary":"AQID"},"nested":{"metadata":{"source":"application"}}}');
    const changeset = createChangeset({
      unitID: unit.unitID, type: unit.type, revision: 2, sid: "metadata", reqId: 1, metadata,
    });
    const control = new Database(filename);
    try {
      await adapter.createWorktree(context, { record: createWorktreeRecord(unit.worktreeID), units: [unit] });
      const committed = await adapter.commitDraftChangeset(context, {
        worktreeID: unit.worktreeID, changeset, unitMetadata: { name: "Document" },
      });
      const stored = control.prepare("SELECT payload_json, metadata_json FROM collaboration_worktree_changesets").get() as { payload_json: string; metadata_json: string };
      expect(JSON.parse(stored.payload_json)).not.toHaveProperty("metadata");
      expect(JSON.parse(stored.metadata_json)).toEqual(metadata);
      expect(control.prepare("SELECT json_extract(metadata_json, '$.nested.metadata.source') AS source FROM collaboration_worktree_changesets").get()).toMatchObject({ source: "application" });
      const saved = (await adapter.getDraftChangesets(context, unit.worktreeID, unit.unitID, { from: 1 }))![0];
      expect(saved.metadata).toEqual(metadata);
      expect(Object.hasOwn(saved.metadata, "__proto__")).toBe(true);
      expect(saved.mutations).toEqual(changeset.mutations);
      expect(committed).toEqual({ status: "committed", changeset: saved, headRevision: 2 });
      for (const [table, originalMetadata] of [
        ["collaboration_worktree_changesets", stored.metadata_json],
        ["collaboration_worktree_units", JSON.stringify({ name: "Document" })],
      ]) {
        const updateMetadata = control.prepare(`UPDATE ${table} SET metadata_json = ?`);
        for (const valid of ["[]", "null", "1", '"text"', "true"]) {
          updateMetadata.run(valid);
          expect(control.prepare(`SELECT metadata_json FROM ${table}`).get()).toMatchObject({ metadata_json: valid });
        }
        for (const invalid of ["not-json", null]) {
          expect(() => updateMetadata.run(invalid)).toThrow();
        }
        updateMetadata.run(originalMetadata);
      }
      expect((await adapter.getDraftChangesets(context, unit.worktreeID, unit.unitID, { from: 1 }))![0]).toEqual(saved);
    } finally {
      control.close();
      await adapter.dispose();
    }
  });

  it("persists draft and merge recovery state across reopen", async () => {
    const worktreeID = "persistent-worktree";
    const unitID = "persistent-unit";
    const record = createWorktreeRecord(worktreeID);
    const unit = createWorktreeUnitRecord({ worktreeID, unitID });
    const changeset = createChangeset({
      unitID,
      type: UniverType.UNIVER_SHEET,
      revision: 2,
      sid: "persistent-draft",
      reqId: 1,
    });
    const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });
    await adapter.createWorktree(context, { record, units: [unit] });
    const committed = await adapter.commitDraftChangeset(context, {
      unitMetadata: {},
      worktreeID,
      changeset,
    });
    await adapter.markReady(context, worktreeID);
    await adapter.startOrResumeMerge(context, worktreeID);
    await adapter.recordUnitMergeResult(context, {
      worktreeID,
      unitID,
      readyDraftHeadRevision: 2,
      mergeResult: {
        status: "failed",
        error: {
          code: "TEMPORARY",
          message: "retry later",
          retryable: true,
        },
      },
    });
    await adapter.dispose();

    const timeDatabase = new Database(filename);
    const stored = timeDatabase.prepare("SELECT created_at_ms, payload_json FROM collaboration_worktree_changesets").get() as { created_at_ms: number; payload_json: string };
    expect(stored.created_at_ms).toEqual(expect.any(Number));
    expect(committed).toMatchObject({ status: "committed", changeset: JSON.parse(stored.payload_json) });
    expect(JSON.parse(stored.payload_json).createTime).toBe(Math.floor(stored.created_at_ms / 1000));
    timeDatabase.close();

    const reopened = new SQLiteWorktreeDatabaseAdapter({ filename });
    await expect(
      reopened.getWorktree(context, worktreeID)
    ).resolves.toMatchObject({
      worktree: { status: "merging", sid: record.sid },
      units: [
        {
          unitID,
          draftHeadRevision: 2,
          readyDraftHeadRevision: 2,
          mergeResult: {
            status: "failed",
            error: { code: "TEMPORARY" },
          },
        },
      ],
    });
    await expect(
      reopened.getDraftChangesets(context, worktreeID, unitID, {
        from: 1,
      })
    ).resolves.toEqual([{ ...changeset, createTime: Math.floor(stored.created_at_ms / 1000) }]);
    await reopened.recordUnitMergeResult(context, {
      worktreeID,
      unitID,
      readyDraftHeadRevision: 2,
      mergeResult: { status: "merged", trunkRevision: 9 },
    });
    await reopened.finishMerge(context, worktreeID);
    await reopened.dispose();

    const completed = new SQLiteWorktreeDatabaseAdapter({ filename });
    await expect(
      completed.getWorktree(context, worktreeID)
    ).resolves.toMatchObject({
      worktree: { status: "merged" },
      units: [
        {
          mergeResult: { status: "merged", trunkRevision: 9 },
        },
      ],
    });
    await completed.dispose();
  });

  it("allows only one connection to win a draft revision CAS", async () => {
    const worktreeID = "two-connections";
    const unitID = "shared-unit";
    const first = new SQLiteWorktreeDatabaseAdapter({ filename });
    const second = new SQLiteWorktreeDatabaseAdapter({ filename });
    await first.createWorktree(context, {
      record: createWorktreeRecord(worktreeID),
      units: [createWorktreeUnitRecord({ worktreeID, unitID })],
    });

    const results = await Promise.all([
      first.commitDraftChangeset(context, {
        unitMetadata: {},
        worktreeID,
        changeset: createChangeset({
          unitID,
          type: UniverType.UNIVER_SHEET,
          revision: 2,
          sid: "connection-a",
          reqId: 1,
        }),
      }),
      second.commitDraftChangeset(context, {
        unitMetadata: {},
        worktreeID,
        changeset: createChangeset({
          unitID,
          type: UniverType.UNIVER_SHEET,
          revision: 2,
          sid: "connection-b",
          reqId: 1,
        }),
      }),
    ]);

    expect(
      results.filter(({ status }) => status === "committed")
    ).toHaveLength(1);
    expect(
      results.filter(({ status }) => status === "revision-mismatch")
    ).toEqual([
      { status: "revision-mismatch", actualHeadRevision: 2 },
    ]);
    await first.dispose();
    await second.dispose();
  });

  it("persists Worktree-created Unit seeds across reopen", async () => {
    const worktreeID = "persistent-local-unit";
    const unitID = "local-unit";
    const seed = {
      ...createWorktreeUnitSeed(unitID),
      sheetBlocks: [{ id: "binary-block", startRow: 0, endRow: 0, data: Buffer.from([0, 128, 255]) }],
    };
    const expectedSeed = structuredClone(seed);
    const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });
    await adapter.createWorktree(context, {
      record: createWorktreeRecord(worktreeID),
      units: [],
    });
    await adapter.createUnit(context, {
      unit: createWorktreeUnitRecord({
        worktreeID,
        unitID,
        source: "worktree",
      }),
      seed,
    });
    await adapter.markReady(context, worktreeID);
    await adapter.startOrResumeMerge(context, worktreeID);
    await adapter.saveUnitMergeArtifact(context, {
      worktreeID,
      unitID,
      artifact: {
        readyDraftHeadRevision: 1,
        unit: seed,
      },
    });
    await adapter.dispose();

    const reopened = new SQLiteWorktreeDatabaseAdapter({ filename });
    await expect(
      reopened.getUnitSeed(context, worktreeID, unitID)
    ).resolves.toEqual(expectedSeed);
    await expect(
      reopened.getWorktreeUnit(context, worktreeID, unitID)
    ).resolves.toMatchObject({
      source: "worktree",
      draftHeadRevision: 1,
    });
    await expect(
      reopened.getUnitMergeArtifact(context, worktreeID, unitID)
    ).resolves.toEqual({
      readyDraftHeadRevision: 1,
      unit: expectedSeed,
    });
    await reopened.dispose();
  });

  it("initializes the complete Worktree database v4 schema", async () => {
    const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });
    await adapter.dispose();

    const inspector = new Database(filename);
    const version = inspector
      .prepare(
        `SELECT version
         FROM collaboration_schema_versions
         WHERE component = 'worktree'`
      )
      .get() as { readonly version: number };
    expect(version.version).toBe(4);
    expect(inspector.prepare("PRAGMA journal_mode").get()).toMatchObject({
      journal_mode: "delete",
    });
    const changesetColumns = inspector
      .prepare("PRAGMA table_info(collaboration_worktree_changesets)")
      .all() as Array<{ readonly name: string }>;
    expect(changesetColumns.map(({ name }) => name)).toEqual([
      "worktree_id",
      "unit_id",
      "revision",
      "base_revision",
      "sid",
      "req_id",
      "created_at_ms",
      "payload_json",
      "metadata_json",
    ]);
    const changesetUniqueIndexes = inspector
      .prepare(
        `SELECT group_concat(info.name, ',') AS columns
         FROM pragma_index_list('collaboration_worktree_changesets') AS list
         JOIN pragma_index_info(list.name) AS info
         WHERE list.[unique] = 1
         GROUP BY list.name
         ORDER BY columns`
      )
      .all();
    expect(changesetUniqueIndexes).toEqual([
      { columns: "worktree_id,unit_id,revision" },
      { columns: "worktree_id,unit_id,sid,req_id" },
    ]);
    const tables = inspector
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all() as Array<{ readonly name: string }>;
    expect(tables.map(({ name }) => ({ name }))).toEqual([
      { name: "collaboration_schema_versions" },
      { name: "collaboration_worktree_changesets" },
      { name: "collaboration_worktree_unit_merge_artifacts" },
      { name: "collaboration_worktree_unit_seeds" },
      { name: "collaboration_worktree_units" },
      { name: "collaboration_worktrees" },
    ]);
    inspector.close();
  });

  it("does not claim the database-wide user_version namespace", async () => {
    const database = new Database(filename);
    database.exec(`
      PRAGMA user_version = 17;
      CREATE TABLE application_data (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE collaboration_schema_versions (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1)
      );
      INSERT INTO collaboration_schema_versions (component, version)
      VALUES ('application', 4);
    `);
    database.close();
    const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });

    await expect(
      adapter.createWorktree(context, {
        record: createWorktreeRecord("coexisting-worktree"),
        units: [],
      })
    ).resolves.toMatchObject({ status: "created" });
    await adapter.dispose();

    const inspector = new Database(filename);
    const version = inspector.prepare("PRAGMA user_version").get() as {
      readonly user_version: number;
    };
    expect(version.user_version).toBe(17);
    const versions = inspector
      .prepare(
        `SELECT component, version
         FROM collaboration_schema_versions
         ORDER BY component`
      )
      .all() as Array<{ readonly component: string; readonly version: number }>;
    expect(versions.map(({ component, version }) => ({ component, version }))).toEqual([
      { component: "application", version: 4 },
      { component: "worktree", version: 4 },
    ]);
    expect(
      inspector
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'application_data'"
        )
        .get()
    ).toBeDefined();
    inspector.close();
  });

  it("has idempotent disposal and rejects later operations", async () => {
    const adapter = new SQLiteWorktreeDatabaseAdapter({ filename });
    await adapter.dispose();
    await adapter.dispose();

    await expect(
      adapter.getWorktree(context, "after-dispose")
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("rejects a different Worktree schema version", () => {
    const database = new Database(filename);
    database.exec(`
      CREATE TABLE collaboration_schema_versions (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1)
      );
      INSERT INTO collaboration_schema_versions (component, version)
      VALUES ('worktree', 99);
    `);
    database.close();

    expect(
      () => new SQLiteWorktreeDatabaseAdapter({ filename })
    ).toThrow("Worktree schema version 99 is not supported");
  });

  it("rejects Worktree tables without a schema version", () => {
    const database = new Database(filename);
    database.exec(`
      CREATE TABLE collaboration_worktrees (
        worktree_id TEXT PRIMARY KEY
      );
    `);
    database.close();

    expect(
      () => new SQLiteWorktreeDatabaseAdapter({ filename })
    ).toThrow("Worktree tables exist without a schema version");
  });

  it("rejects an incomplete Worktree database v4", () => {
    const database = new Database(filename);
    database.exec(`
      CREATE TABLE collaboration_schema_versions (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1)
      );
      INSERT INTO collaboration_schema_versions (component, version)
      VALUES ('worktree', 4);
    `);
    database.close();

    expect(
      () => new SQLiteWorktreeDatabaseAdapter({ filename })
    ).toThrow("Worktree schema v4 is incomplete");
  });
});
