import type Database from "libsql";
import { CollabError, type UnitRecord } from "@univerjs-pro/collaboration-service";
import {
  isTimestamp,
  readDependents,
  readMigrationRows,
  requireColumns,
  requireCoreVersion,
  runMigration,
  setCoreVersion,
} from "./shared.js";

export interface SQLiteCoreV1ToV2MigrationOptions {
  readonly filename: string;
  /** Override default History lookup and fallback for every Unit, including soft-deleted Units. */
  readonly resolveUnitCreation?: (
    unitID: string,
  ) => Pick<UnitRecord, "creatorID" | "createdAt"> | Promise<Pick<UnitRecord, "creatorID" | "createdAt">>;
  /** Override default changeset time resolution; return Unix milliseconds. */
  readonly resolveChangesetCreatedAt?: (unitID: string, revision: number) => number | Promise<number>;
}

/**
 * Explicit, atomic migration from core schema v1 to v2. V2 adds the creator and creation time of
 * every Unit and the commit time of every changeset. Stop writers before calling; the resolvers
 * must not write to this database.
 */
export async function migrateSQLiteCoreV1ToV2(options: SQLiteCoreV1ToV2MigrationOptions): Promise<void> {
  const fallbackCreatedAt = Date.now();
  await runMigration(options.filename, async (database) => {
    requireCoreVersion(database, 1, "migrateSQLiteCoreV1ToV2");
    requireColumns(database, "collaboration_units", ["unit_id", "type", "head_revision", "soft_deleted_at_ms"]);
    requireColumns(database, "collaboration_unit_tombstones", ["unit_id"]);
    requireColumns(database, "collaboration_snapshots", ["unit_id"]);
    requireColumns(database, "collaboration_changesets", ["unit_id", "revision", "payload_json"]);
    requireColumns(database, "collaboration_sheet_blocks", ["unit_id"]);
    const unitColumns = database.prepare("PRAGMA table_info(collaboration_units)").all() as { name: string }[];
    if (unitColumns.length !== 4) {
      throw new CollabError(
        "INVALID_REQUEST",
        "Core v1 Unit columns differ from the supported schema; refusing a potentially lossy migration",
      );
    }
    const readHistory = createHistoryReader(database);

    // Units: rebuild with the two new required columns.
    const unitDependents = readDependents(database, ["collaboration_units"]);
    database.exec(`CREATE TABLE collaboration_units_v2 (
      unit_id TEXT PRIMARY KEY,
      type INTEGER NOT NULL,
      head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
      creator_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      soft_deleted_at_ms INTEGER
    );`);
    const insertUnit = database.prepare("INSERT INTO collaboration_units_v2 VALUES (?, ?, ?, ?, ?, ?)");
    for (const row of readMigrationRows(database, "collaboration_units", ["unit_id"])) {
      const unitID = row.unit_id as string;
      const history = options.resolveUnitCreation ? undefined : readHistory(unitID, 1);
      const creation = options.resolveUnitCreation
        ? await options.resolveUnitCreation(unitID)
        : {
            creatorID: history?.user_id || "anonymous",
            createdAt: isTimestamp(history?.committed_at) ? history.committed_at : fallbackCreatedAt,
          };
      if (
        !creation ||
        typeof creation.creatorID !== "string" ||
        creation.creatorID.length === 0 ||
        !isTimestamp(creation.createdAt)
      ) {
        throw new CollabError("INVALID_REQUEST", `Missing or invalid creation facts for Unit ${unitID}`);
      }
      insertUnit.run(unitID, row.type, row.head_revision, creation.creatorID, creation.createdAt, row.soft_deleted_at_ms);
    }
    database.exec("DROP TABLE collaboration_units; ALTER TABLE collaboration_units_v2 RENAME TO collaboration_units;");
    for (const dependent of unitDependents) database.exec(dependent.sql);

    // Changesets: rebuild with the commit time column, keeping every existing column as it is.
    const changesetColumns = database.prepare("PRAGMA table_info(collaboration_changesets)").all() as { name: string }[];
    if (changesetColumns.some((column) => column.name === "created_at_ms")) {
      throw new CollabError("INVALID_REQUEST", "Unexpected changeset creation-time column in legacy schema");
    }
    const changesetSchema = database
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'collaboration_changesets'")
      .get() as { sql: string };
    const changesetDependents = readDependents(database, ["collaboration_changesets"]);
    database.exec(`CREATE TABLE collaboration_changesets_v2 (
      created_at_ms INTEGER NOT NULL,
      ${changesetSchema.sql.slice(changesetSchema.sql.indexOf("(") + 1)}`);
    const names = changesetColumns.map((column) => `"${column.name.replaceAll('"', '""')}"`).join(", ");
    const insertChangeset = database.prepare(
      `INSERT INTO collaboration_changesets_v2 (${names}, created_at_ms)
       VALUES (${changesetColumns.map(() => "?").join(", ")}, ?)`,
    );
    for (const row of readMigrationRows(database, "collaboration_changesets", ["unit_id", "revision"])) {
      const unitID = row.unit_id as string;
      const revision = row.revision as number;
      const payload = JSON.parse(row.payload_json as string);
      const payloadTime = typeof payload.createTime === "number" ? payload.createTime * 1000 : undefined;
      const historyTime =
        !options.resolveChangesetCreatedAt && !isTimestamp(payloadTime)
          ? readHistory(unitID, revision)?.committed_at
          : undefined;
      const createdAt = options.resolveChangesetCreatedAt
        ? await options.resolveChangesetCreatedAt(unitID, revision)
        : isTimestamp(payloadTime) ? payloadTime : isTimestamp(historyTime) ? historyTime : fallbackCreatedAt;
      if (!isTimestamp(createdAt)) {
        throw new CollabError(
          "INVALID_REQUEST",
          `Missing or invalid changeset time for Unit ${unitID} revision ${revision}`,
        );
      }
      payload.createTime = Math.floor(createdAt / 1000);
      insertChangeset.run(
        ...changesetColumns.map((column) => (column.name === "payload_json" ? JSON.stringify(payload) : row[column.name])),
        createdAt,
      );
    }
    database.exec("DROP TABLE collaboration_changesets; ALTER TABLE collaboration_changesets_v2 RENAME TO collaboration_changesets;");
    for (const dependent of changesetDependents) database.exec(dependent.sql);

    setCoreVersion(database, 2);
  });
}

// The History component of the same database is the default source of creators and times.
function createHistoryReader(database: Database.Database) {
  const hasHistory = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'collaboration_history_revisions'")
    .get();
  const query = hasHistory
    ? database.prepare("SELECT user_id, committed_at FROM collaboration_history_revisions WHERE unit_id = ? AND revision = ?")
    : undefined;
  return (unitID: string, revision: number) =>
    query?.get(unitID, revision) as { user_id: string; committed_at: number } | undefined;
}
