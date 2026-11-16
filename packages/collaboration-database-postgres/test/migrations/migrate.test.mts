import { Buffer } from "node:buffer";
import { encode } from "@msgpack/msgpack";
import { createDatabaseContext } from "@univerjs-pro/collaboration-database-testkit";
import { UniverType } from "@univerjs/protocol";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migratePostgresCore, migratePostgresCoreV1ToV2, PostgresDatabaseAdapter } from "../../src/index.js";
import { createTestPool, dropSchema, expectRequiredMetadataColumns, POSTGRES_URL } from "../helpers.mjs";
import { createV1Schema } from "./fixtures.mjs";

describe.skipIf(POSTGRES_URL === undefined)("PostgreSQL core migrations", () => {
  let pool: Pool;
  const context = createDatabaseContext();

  beforeAll(() => {
    pool = createTestPool();
  });

  beforeEach(async () => {
    await dropSchema(pool);
  });

  afterAll(async () => {
    await dropSchema(pool);
    await pool.end();
  });

  it("opens explicitly migrated v1 metadata with empty defaults", async () => {
    await createV1Schema(pool);
    const unitID = "migrated-metadata";
    const type = UniverType.UNIVER_DOC;
    const changeset = {
      unitID, type, baseRev: 1, revision: 2, sid: "migration", reqId: 1,
      userID: "editor", memberID: "member", mutations: [], createTime: 1,
    };
    const payload = Buffer.from(encode(changeset));
    await pool.query(`INSERT INTO collaboration.units
      (unit_id, type, head_revision, creator_id, created_at_ms) VALUES ($1, $2, 2, 'editor', 1000)`, [unitID, type]);
    await pool.query(`INSERT INTO collaboration.changesets
      (unit_id, revision, base_revision, sid, req_id, created_at_ms, payload)
      VALUES ($1, 2, 1, 'migration', 1, 1000, $2)`, [unitID, payload]);
    await expect(PostgresDatabaseAdapter.create({ pool })).rejects.toThrow(/version 1 is not supported/);
    const results = await Promise.all([migratePostgresCore({ pool }), migratePostgresCore({ pool })]);
    expect(results).toEqual(expect.arrayContaining([{ from: 1, to: 2 }, { from: 2, to: 2 }]));
    await expect(migratePostgresCoreV1ToV2({ pool })).rejects.toThrow("requires schema version 1");
    const migrated = await PostgresDatabaseAdapter.create({ pool });
    await expect(migrated.getUnit(context, unitID)).resolves.toMatchObject({ metadata: {} });
    const history = await migrated.getChangesets(context, unitID, { from: 1 });
    expect(history).toEqual([{ ...changeset, metadata: {} }]);
    const after = await pool.query("SELECT payload, metadata FROM collaboration.changesets WHERE unit_id = $1", [unitID]);
    expect(after.rows[0]!.payload).toEqual(payload);
    expect(after.rows[0]!.metadata).toEqual({});
    await expectRequiredMetadataColumns(pool, unitID);
  });

  it("rolls back a failed version step and allows an explicit retry", async () => {
    await createV1Schema(pool);
    // Make the second ALTER fail after the first one succeeds.
    await pool.query(`
      ALTER TABLE collaboration.changesets ADD COLUMN metadata JSONB;
      INSERT INTO collaboration.schema_versions VALUES ('file', 1);
    `);
    await expect(migratePostgresCore({ pool })).rejects.toMatchObject({ code: "42701" });
    const versions = () => pool.query("SELECT component, version FROM collaboration.schema_versions ORDER BY component");
    expect((await versions()).rows).toEqual([{ component: "core", version: 1 }, { component: "file", version: 1 }]);
    await expect(pool.query("SELECT metadata FROM collaboration.units")).rejects.toMatchObject({ code: "42703" });

    await pool.query("ALTER TABLE collaboration.changesets DROP COLUMN metadata");
    await migratePostgresCoreV1ToV2({ pool });
    expect((await versions()).rows).toEqual([{ component: "core", version: 2 }, { component: "file", version: 1 }]);
    await expect(migratePostgresCore({ pool })).resolves.toEqual({ from: 2, to: 2 });
  });

  it("requires an existing core version and leaves other components alone", async () => {
    await expect(migratePostgresCore({ pool })).rejects.toMatchObject({ code: "42P01" });
    await pool.query(`
      CREATE SCHEMA collaboration;
      CREATE TABLE collaboration.schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO collaboration.schema_versions VALUES ('core-s3', 1);
    `);
    await expect(migratePostgresCore({ pool })).rejects.toThrow("no PostgreSQL core schema version");
    expect((await pool.query("SELECT * FROM collaboration.schema_versions")).rows).toEqual([{ component: "core-s3", version: 1 }]);
  });

  it("rejects migration from a newer core schema version", async () => {
    await pool.query(`
      CREATE SCHEMA collaboration;
      CREATE TABLE collaboration.schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO collaboration.schema_versions VALUES ('core', 99);
    `);
    await expect(migratePostgresCore({ pool })).rejects.toThrow("newer than this package supports");
  });
});
