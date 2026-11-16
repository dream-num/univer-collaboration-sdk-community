import Database from "libsql";
import { CollabError, type UnitRecord } from "@univerjs-pro/collaboration-service";

/** Options for upgrading creation facts in a Worktree v2 database. @public */
export interface SQLiteWorktreeV2ToV3MigrationOptions {
  readonly filename: string;
  /** Override default creation facts for each Worktree Unit. */
  readonly resolveUnitCreation?: (worktreeID: string, unitID: string) =>
    Pick<UnitRecord, "creatorID" | "createdAt"> | Promise<Pick<UnitRecord, "creatorID" | "createdAt">>;
  /** Override default changeset time resolution; return Unix milliseconds. */
  readonly resolveChangesetCreatedAt?: (worktreeID: string, unitID: string, revision: number) => number | Promise<number>;
}

/**
 * Upgrades Worktree v2 to v3. Stop writers and back up the file first.
 * All rows and the version change commit atomically.
 * @public
 */
export async function migrateSQLiteWorktreeV2ToV3(options: SQLiteWorktreeV2ToV3MigrationOptions): Promise<void> {
  const fallbackCreatedAt = Date.now();
  const database = new Database(options.filename, { fileMustExist: true });
  let transaction = false;
  try {
    database.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN IMMEDIATE;");
    transaction = true;
    const version = database.prepare("SELECT version FROM collaboration_schema_versions WHERE component = 'worktree'").get() as { version: number } | undefined;
    if (version?.version !== 2) throw new CollabError("INVALID_REQUEST", "Worktree v2-to-v3 migration requires schema version 2");
    for (const table of ["collaboration_worktrees", "collaboration_worktree_changesets", "collaboration_worktree_unit_seeds", "collaboration_worktree_unit_merge_artifacts"]) {
      database.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all();
    }
    const hasHistory = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'collaboration_history_revisions'").get();
    const historyQuery = hasHistory ? database.prepare(
      "SELECT user_id, committed_at FROM collaboration_history_revisions WHERE unit_id = ? AND revision = ?"
    ) : undefined;
    const readHistory = (unitID: string, revision: number) =>
      historyQuery?.get(unitID, revision) as { user_id: string; committed_at: number } | undefined;
    const columns = database.prepare("PRAGMA table_info(collaboration_worktree_units)").all() as { name: string }[];
    if (!columns.some(column => column.name === "removed") || columns.some(column => ["creator_id", "created_at_ms"].includes(column.name))) {
      throw new CollabError("INVALID_REQUEST", "Unexpected Worktree v2 Unit schema");
    }
    const schema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'collaboration_worktree_units'").get() as { sql: string };
    const dependents = database.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name = 'collaboration_worktree_units' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all() as { sql: string }[];
    database.exec(`CREATE TABLE collaboration_worktree_units_v3 (
      creator_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      ${schema.sql.slice(schema.sql.indexOf("(") + 1)}`);
    const rows = readMigrationRows(database, "collaboration_worktree_units", ["worktree_id", "unit_id"]) as Iterable<Record<string, string | number | null> & { worktree_id: string; unit_id: string }>;
    const names = columns.map(column => `"${column.name.replaceAll('"', '""')}"`).join(", ");
    const insert = database.prepare(`INSERT INTO collaboration_worktree_units_v3 (${names}, creator_id, created_at_ms) VALUES (${columns.map(() => "?").join(", ")}, ?, ?)`);
    for (const row of rows) {
      const history = !options.resolveUnitCreation && row.source === "trunk" ? readHistory(row.unit_id, 1) : undefined;
      const creation = options.resolveUnitCreation
        ? await options.resolveUnitCreation(row.worktree_id, row.unit_id)
        : {
            creatorID: history?.user_id || "anonymous",
            createdAt: isTimestamp(history?.committed_at) ? history.committed_at : fallbackCreatedAt,
          };
      if (!creation || typeof creation.creatorID !== "string" || creation.creatorID.length === 0 || !Number.isSafeInteger(creation.createdAt) || creation.createdAt < 0) {
        throw new CollabError("INVALID_REQUEST", `Missing or invalid creation facts for Worktree ${row.worktree_id} Unit ${row.unit_id}`);
      }
      insert.run(...columns.map(column => row[column.name]), creation.creatorID, creation.createdAt);
    }
    database.exec("DROP TABLE collaboration_worktree_units; ALTER TABLE collaboration_worktree_units_v3 RENAME TO collaboration_worktree_units;");
    for (const dependent of dependents) database.exec(dependent.sql);
    const changesetSchema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'collaboration_worktree_changesets'").get() as { sql: string };
    const changesetColumns = database.prepare("PRAGMA table_info(collaboration_worktree_changesets)").all() as { name: string }[];
    if (changesetColumns.some(column => column.name === "created_at_ms")) {
      throw new CollabError("INVALID_REQUEST", "Unexpected changeset creation-time column in legacy schema");
    }
    const changesetDependents = database.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name = 'collaboration_worktree_changesets' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all() as { sql: string }[];
    database.exec(`CREATE TABLE collaboration_worktree_changesets_new (
      created_at_ms INTEGER NOT NULL,
      ${changesetSchema.sql.slice(changesetSchema.sql.indexOf("(") + 1)}`);
    const changesetRows = readMigrationRows(database, "collaboration_worktree_changesets", ["worktree_id", "unit_id", "revision"]) as Iterable<Record<string, string | number | null> & { worktree_id: string; unit_id: string; revision: number }>;
    const changesetNames = changesetColumns.map(column => `"${column.name.replaceAll('"', '""')}"`).join(", ");
    const insertChangeset = database.prepare(`INSERT INTO collaboration_worktree_changesets_new (${changesetNames}, created_at_ms) VALUES (${changesetColumns.map(() => "?").join(", ")}, ?)`);
    for (const row of changesetRows) {
      const payload = JSON.parse(row.payload_json as string);
      const payloadTime = typeof payload.createTime === "number" ? payload.createTime * 1000 : undefined;
      const createdAt = options.resolveChangesetCreatedAt
        ? await options.resolveChangesetCreatedAt(row.worktree_id, row.unit_id, row.revision)
        : isTimestamp(payloadTime) ? payloadTime : fallbackCreatedAt;
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new CollabError("INVALID_REQUEST", `Missing or invalid changeset time for Unit ${row.unit_id} revision ${row.revision}`);
      }
      payload.createTime = Math.floor(createdAt / 1000);
      insertChangeset.run(...changesetColumns.map(column => column.name === "payload_json" ? JSON.stringify(payload) : row[column.name]), createdAt);
    }
    database.exec("DROP TABLE collaboration_worktree_changesets; ALTER TABLE collaboration_worktree_changesets_new RENAME TO collaboration_worktree_changesets;");
    for (const dependent of changesetDependents) database.exec(dependent.sql);
    if (database.prepare("PRAGMA foreign_key_check").all().length) throw new CollabError("INVALID_REQUEST", "Foreign key validation failed during Worktree migration");
    database.exec("UPDATE collaboration_schema_versions SET version = 3 WHERE component = 'worktree'; COMMIT;");
    transaction = false;
  } finally {
    try { if (transaction) database.exec("ROLLBACK;"); }
    finally { database.close(); }
  }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Callers supply fixed table and key names. The source table stays unchanged throughout the transaction.
// Close each page's cursor before awaiting a resolver or writing to the destination table.
function* readMigrationRows(
  database: Database.Database,
  table: string,
  keys: readonly string[],
): Generator<Record<string, string | number | null>> {
  const order = keys.join(", ");
  const first = database.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 100`);
  const after = database.prepare(
    `SELECT * FROM ${table} WHERE (${order}) > (${keys.map(() => "?").join(", ")}) ORDER BY ${order} LIMIT 100`,
  );
  type Row = Record<string, string | number | null>;
  let rows = first.all() as Row[];
  while (rows.length > 0) {
    yield* rows;
    const cursor = keys.map(key => rows[rows.length - 1]![key]);
    // Release this page's payloads before loading the next. Only the scalar keys are needed to resume.
    rows = [];
    rows = after.all(...cursor) as Row[];
  }
}
