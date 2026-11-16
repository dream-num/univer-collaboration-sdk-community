import { randomUUID } from "node:crypto";
import { PostgresDatabaseAdapter } from "@univerjs-pro/collaboration-database-postgres";
import { createChangeset, createDatabaseContext, createWorktreeRecord, createWorktreeUnitRecord, worktreeDatabaseAdapterContract } from "@univerjs-pro/collaboration-worktree-database-testkit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresWorktreeDatabaseAdapter } from "../src/index.js";

// The adapter always uses the fixed `collaboration` schema, so these tests run in a database of their
// own: the core adapter's tests use the configured database at the same time.
const url = process.env.UNIVER_COLLAB_POSTGRES_URL;

if (url === undefined) {
  describe("PostgreSQL IWorktreeDatabaseAdapter contract", () => {
    it.skip("requires UNIVER_COLLAB_POSTGRES_URL to point at a PostgreSQL server", () => {});
  });
} else {
  const database = `collaboration_worktree_test_${randomUUID().replace(/-/g, "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${database}`);
    const connection = new URL(url);
    connection.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: connection.toString(), max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
    try {
      await admin?.query(`DROP DATABASE IF EXISTS ${database}`);
    } finally {
      await admin?.end();
    }
  });

  async function resetSchema(): Promise<void> {
    await pool.query("DROP SCHEMA IF EXISTS collaboration CASCADE");
  }

  worktreeDatabaseAdapterContract("PostgreSQL", async () => {
    await resetSchema();
    const adapter = await PostgresWorktreeDatabaseAdapter.create({ pool });
    return { adapter, dispose: () => adapter.dispose() };
  });

  describe("PostgresWorktreeDatabaseAdapter", () => {
    it("initializes once when several nodes start together and leaves the pool open", async () => {
      await resetSchema();
      const adapters = await Promise.all(Array.from({ length: 4 }, () => PostgresWorktreeDatabaseAdapter.create({ pool })));
      const versions = await pool.query("SELECT component, version FROM collaboration.schema_versions");
      expect(versions.rows).toEqual([{ component: "worktree", version: 1 }]);
      await Promise.all(adapters.map((adapter) => adapter.dispose()));
      expect((await pool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
    });

    it("shares the collaboration schema and its version table with the core adapter", async () => {
      await resetSchema();
      await Promise.all([
        PostgresDatabaseAdapter.create({ pool }),
        PostgresWorktreeDatabaseAdapter.create({ pool }),
      ]);
      const versions = await pool.query(
        "SELECT component, version FROM collaboration.schema_versions ORDER BY component"
      );
      expect(versions.rows).toEqual([
        { component: "core", version: 2 },
        { component: "worktree", version: 1 },
      ]);
    });

    it("rejects a different worktree schema version", async () => {
      await resetSchema();
      await PostgresWorktreeDatabaseAdapter.create({ pool });
      await pool.query("UPDATE collaboration.schema_versions SET version = 2 WHERE component = 'worktree'");
      await expect(PostgresWorktreeDatabaseAdapter.create({ pool })).rejects.toThrow(/version 2 is not supported/);
    });

    it("serializes draft commits and freezes the winning head across pools", async () => {
      await resetSchema();
      const otherPool = new pg.Pool({ connectionString: pool.options.connectionString, max: 1 });
      try {
        const a = await PostgresWorktreeDatabaseAdapter.create({ pool });
        const b = await PostgresWorktreeDatabaseAdapter.create({ pool: otherPool });
        const ctx = createDatabaseContext();
        const worktreeID = "concurrent";
        const unit = createWorktreeUnitRecord({ worktreeID, unitID: "sheet" });
        const creation = { record: createWorktreeRecord(worktreeID), units: [unit] };
        const created = await Promise.all([a.createWorktree(ctx, creation), b.createWorktree(ctx, creation)]);
        expect(created.map(result => result.status).sort()).toEqual(["already-exists", "created"]);
        const input = {
          worktreeID, unitMetadata: { winner: true },
          changeset: createChangeset({ unitID: unit.unitID, type: unit.type, revision: 2, sid: "s", reqId: 1 }),
        };
        const commits = await Promise.all([a.commitDraftChangeset(ctx, input), b.commitDraftChangeset(ctx, input)]);
        expect(commits.map(result => result.status).sort()).toEqual(["committed", "revision-mismatch"]);

        // A failed history insert after the CAS must roll back both the head and Unit metadata.
        const next = { ...input, unitMetadata: {}, changeset: { ...input.changeset, revision: 3, baseRev: 2 } };
        await expect(b.commitDraftChangeset(ctx, next)).rejects.toMatchObject({ code: "23505" });
        expect(await a.getWorktreeUnit(ctx, worktreeID, unit.unitID)).toMatchObject({ draftHeadRevision: 2, metadata: { winner: true } });

        const [commit, ready] = await Promise.all([
          a.commitDraftChangeset(ctx, { ...next, changeset: { ...next.changeset, reqId: 2 } }),
          b.markReady(ctx, worktreeID),
        ]);
        expect(["committed", "not-editable"]).toContain(commit.status);
        expect(ready.status).toBe("transitioned");
        const revision = commit.status === "committed" ? 3 : 2;
        expect(await b.getWorktreeUnit(ctx, worktreeID, unit.unitID)).toMatchObject({
          draftHeadRevision: revision, readyDraftHeadRevision: revision,
        });
        await Promise.all([a.dispose(), b.dispose()]);
      } finally {
        await otherPool.end();
      }
    });
  });
}
