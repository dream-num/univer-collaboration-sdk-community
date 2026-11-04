import { Buffer } from "node:buffer";
import Database from "libsql";

// Frozen DDL of the schemas written by earlier releases. The adapter only creates v3, so the
// migration tests build their inputs from these definitions.
const V2_UNITS = `
  CREATE TABLE collaboration_units (
    unit_id TEXT PRIMARY KEY,
    type INTEGER NOT NULL,
    head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
    creator_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    soft_deleted_at_ms INTEGER
  );`;
const V1_UNITS = `
  CREATE TABLE collaboration_units (
    unit_id TEXT PRIMARY KEY,
    type INTEGER NOT NULL,
    head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
    soft_deleted_at_ms INTEGER
  );`;
const V2_CHANGESETS = `
  CREATE TABLE collaboration_changesets (
    unit_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 2),
    base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
    sid TEXT NOT NULL,
    req_id INTEGER NOT NULL CHECK (req_id >= 1),
    created_at_ms INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (unit_id, revision),
    UNIQUE (unit_id, sid, req_id),
    FOREIGN KEY (unit_id) REFERENCES collaboration_units(unit_id) ON DELETE CASCADE
  );`;
const V1_CHANGESETS = V2_CHANGESETS.replace("    created_at_ms INTEGER NOT NULL,\n", "");
const SHARED_TABLES = `
  CREATE TABLE collaboration_schema_versions (
    component TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 1)
  );
  CREATE TABLE collaboration_unit_tombstones (
    unit_id TEXT PRIMARY KEY,
    purged_at INTEGER NOT NULL
  );
  CREATE TABLE collaboration_snapshots (
    unit_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    type INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (unit_id, revision),
    FOREIGN KEY (unit_id) REFERENCES collaboration_units(unit_id) ON DELETE CASCADE
  );
  CREATE TABLE collaboration_sheet_blocks (
    unit_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (unit_id, block_id),
    FOREIGN KEY (unit_id) REFERENCES collaboration_units(unit_id) ON DELETE CASCADE
  );
  CREATE INDEX collaboration_snapshots_nearest_revision
    ON collaboration_snapshots(unit_id, revision DESC);
  CREATE INDEX collaboration_changesets_revision_range
    ON collaboration_changesets(unit_id, revision ASC);`;

export function createV1Database(filename: string): void {
  exec(filename, `${V1_UNITS}${V1_CHANGESETS}${SHARED_TABLES}
    INSERT INTO collaboration_schema_versions (component, version) VALUES ('core', 1);`);
}

export function createV2Database(filename: string): void {
  exec(filename, `${V2_UNITS}${V2_CHANGESETS}${SHARED_TABLES}
    INSERT INTO collaboration_schema_versions (component, version) VALUES ('core', 2);`);
}

/** Objects that applications typically attach to the core tables; migrations must keep them working. */
export function addApplicationObjects(filename: string): void {
  exec(filename, `
    INSERT INTO collaboration_schema_versions VALUES ('other', 7);
    CREATE TABLE application_unit_links (unit_id TEXT REFERENCES collaboration_units(unit_id));
    CREATE INDEX application_unit_type ON collaboration_units(type);
    CREATE VIEW application_units AS SELECT unit_id FROM collaboration_units;
  `);
}

const BINARY_TAG = "__univerCollaborationBinary";

/** Serializes a protocol object the way the v1 and v2 adapters did: JSON with tagged base64 binary. */
export function encodeLegacy(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, current: unknown) {
    const original = this[key];
    return original instanceof Uint8Array
      ? { [BINARY_TAG]: Buffer.from(original).toString("base64") }
      : current;
  });
}

export function exec(filename: string, sql: string): void {
  const database = new Database(filename);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

export function query<T = Record<string, unknown>>(filename: string, sql: string, ...params: unknown[]): T[] {
  const database = new Database(filename);
  try {
    return database.prepare(sql).all(...params) as T[];
  } finally {
    database.close();
  }
}

/** Every schema object and every row, for asserting that a failed migration changed nothing. */
export function dumpDatabase(filename: string): { schema: unknown[]; rows: Record<string, unknown[]> } {
  const database = new Database(filename);
  try {
    const schema = database
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all() as { type: string; name: string }[];
    const rows: Record<string, unknown[]> = {};
    for (const object of schema) {
      if (object.type === "table") rows[object.name] = database.prepare(`SELECT * FROM "${object.name}"`).all();
    }
    return { schema, rows };
  } finally {
    database.close();
  }
}
