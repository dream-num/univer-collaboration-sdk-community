import { Buffer } from "node:buffer";
import { Encoder } from "@msgpack/msgpack";
import type Database from "libsql";
import { UniverType } from "@univerjs/protocol";
import { CORE_SCHEMA_V3_SQL } from "../schema.js";
import {
  readDependents,
  readMigrationRows,
  requireColumns,
  requireCoreVersion,
  runMigration,
  setCoreVersion,
} from "./shared.js";

export interface SQLiteCoreV2ToV3MigrationOptions {
  readonly filename: string;
}

const CORE_TABLES = [
  "collaboration_units",
  "collaboration_snapshots",
  "collaboration_changesets",
  "collaboration_sheet_blocks",
] as const;
// V2 created these itself; v3 serves the same queries through primary keys.
const V2_INDEXES = new Set(["collaboration_snapshots_nearest_revision", "collaboration_changesets_revision_range"]);
// V2 stored binary fields inside JSON text under this tag.
const BINARY_TAG = "__univerCollaborationBinary";

/**
 * Explicit, atomic migration from core schema v2 to v3. V3 stores protocol objects as MessagePack
 * blobs and keeps hard-deleted Units as marker rows in `collaboration_units` instead of a tombstone
 * table. Stop writers before calling.
 */
export async function migrateSQLiteCoreV2ToV3(options: SQLiteCoreV2ToV3MigrationOptions): Promise<void> {
  await runMigration(options.filename, (database) => {
    requireCoreVersion(database, 2, "migrateSQLiteCoreV2ToV3");
    requireColumns(database, "collaboration_units", ["unit_id", "type", "head_revision", "creator_id", "created_at_ms", "soft_deleted_at_ms"]);
    requireColumns(database, "collaboration_unit_tombstones", ["unit_id", "purged_at"]);
    requireColumns(database, "collaboration_snapshots", ["unit_id", "revision", "payload_json"]);
    requireColumns(database, "collaboration_changesets", ["unit_id", "revision", "base_revision", "sid", "req_id", "created_at_ms", "payload_json"]);
    requireColumns(database, "collaboration_sheet_blocks", ["unit_id", "block_id", "payload_json"]);
    const dependents = readDependents(database, CORE_TABLES, V2_INDEXES);

    // Move the v2 tables aside and create the v3 tables under their final names.
    for (const table of CORE_TABLES) {
      database.exec(`ALTER TABLE ${table} RENAME TO ${table}_v2;`);
    }
    database.exec(CORE_SCHEMA_V3_SQL);

    database.exec(`
      INSERT INTO collaboration_units
        (unit_id, type, head_revision, creator_id, created_at_ms, deleted_at_ms, deleted_status)
      SELECT unit_id, type, head_revision, creator_id, created_at_ms, soft_deleted_at_ms,
        CASE WHEN soft_deleted_at_ms IS NULL THEN NULL ELSE 'soft' END
      FROM collaboration_units_v2;
    `);
    // A v2 tombstone carries only the ID and purge time. The marker row keeps the ID reserved and is
    // never returned by reads, so its remaining columns hold fixed placeholder values.
    database.exec(`
      INSERT INTO collaboration_units
        (unit_id, type, head_revision, creator_id, created_at_ms, deleted_at_ms, deleted_status)
      SELECT unit_id, ${UniverType.UNIVER_SHEET}, 1, 'anonymous', purged_at, purged_at, 'hard'
      FROM collaboration_unit_tombstones;
    `);

    const encoder = new Encoder({ ignoreUndefined: true });
    const reencode = (json: unknown): Buffer => {
      const bytes = encoder.encode(decodeV2Payload(json as string));
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    copyPayloadRows(database, "collaboration_snapshots", ["unit_id", "revision"], reencode);
    copyPayloadRows(database, "collaboration_changesets", ["unit_id", "revision", "base_revision", "sid", "req_id", "created_at_ms"], reencode);
    copyPayloadRows(database, "collaboration_sheet_blocks", ["unit_id", "block_id"], reencode);

    for (const table of CORE_TABLES) {
      database.exec(`DROP TABLE ${table}_v2;`);
    }
    database.exec("DROP TABLE collaboration_unit_tombstones;");
    for (const dependent of dependents) database.exec(dependent.sql);

    setCoreVersion(database, 3);
  });
}

// Copies the scalar columns as they are and replaces `payload_json` with the re-encoded `payload`.
function copyPayloadRows(
  database: Database.Database,
  table: string,
  columns: readonly string[],
  reencode: (json: unknown) => Buffer,
): void {
  const insert = database.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}, payload) VALUES (${columns.map(() => "?").join(", ")}, ?)`,
  );
  for (const row of readMigrationRows(database, `${table}_v2`, columns.slice(0, 2))) {
    insert.run(...columns.map((column) => row[column]), reencode(row.payload_json));
  }
}

function decodeV2Payload(json: string): unknown {
  return JSON.parse(json, (_key, value: unknown) => {
    if (
      typeof value === "object" &&
      value !== null &&
      Object.keys(value).length === 1 &&
      typeof (value as Record<string, unknown>)[BINARY_TAG] === "string"
    ) {
      return Uint8Array.from(Buffer.from((value as Record<string, string>)[BINARY_TAG]!, "base64"));
    }
    return value;
  });
}
