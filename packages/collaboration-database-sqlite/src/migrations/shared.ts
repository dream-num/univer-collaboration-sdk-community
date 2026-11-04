import Database from "libsql";
import { CollabError } from "@univerjs-pro/collaboration-service";

/**
 * Opens an existing database and runs `work` in one immediate transaction. Any failure rolls the
 * whole migration back, so a database is either fully migrated or untouched.
 */
export async function runMigration(
  filename: string,
  work: (database: Database.Database) => Promise<void> | void,
): Promise<void> {
  const database = new Database(filename, { fileMustExist: true });
  let transaction = false;
  try {
    // Tables are rebuilt and renamed in place: foreign keys stay off while rows move, and legacy
    // renaming keeps application views and foreign keys pointing at the table names.
    database.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN IMMEDIATE;");
    transaction = true;
    await work(database);
    database.exec("COMMIT;");
    transaction = false;
  } finally {
    try {
      if (transaction) database.exec("ROLLBACK;");
    } finally {
      database.close();
    }
  }
}

export function requireCoreVersion(database: Database.Database, expected: number, migration: string): void {
  const row = database
    .prepare("SELECT version FROM collaboration_schema_versions WHERE component = 'core'")
    .get() as { version: number } | undefined;
  if (row?.version !== expected) {
    throw new CollabError("INVALID_REQUEST", `${migration} requires core schema version ${expected}`);
  }
}

/** Fails when a table is missing or lacks any of the listed columns, which would make the migration lossy. */
export function requireColumns(
  database: Database.Database,
  table: string,
  columns: readonly string[],
): void {
  const present = (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (column) => column.name,
  );
  if (present.length === 0 || columns.some((column) => !present.includes(column))) {
    throw new CollabError(
      "INVALID_REQUEST",
      `Table ${table} differs from the supported schema; refusing a potentially lossy migration`,
    );
  }
}

export function setCoreVersion(database: Database.Database, version: number): void {
  database.prepare("UPDATE collaboration_schema_versions SET version = ? WHERE component = 'core'").run(version);
  if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new CollabError("INVALID_REQUEST", "Foreign key validation failed during core migration");
  }
}

export interface SchemaObject {
  readonly name: string;
  readonly sql: string;
}

/** Indexes and triggers the application defined on the given tables; they are recreated after a rebuild. */
export function readDependents(
  database: Database.Database,
  tables: readonly string[],
  ownIndexes: ReadonlySet<string> = new Set(),
): SchemaObject[] {
  const placeholders = tables.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE tbl_name IN (${placeholders}) AND type IN ('index', 'trigger') AND sql IS NOT NULL`,
    )
    .all(...tables) as SchemaObject[];
  return rows.filter((row) => !ownIndexes.has(row.name));
}

export function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Table names and keys come from fixed call sites in the migrations. The source table does not
// change until copying ends, and every page runs in the same transaction. No SQLite cursor is held
// across an await, so resolver calls and target writes never interleave with an active statement.
export function* readMigrationRows(
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
    const cursor = keys.map((key) => rows[rows.length - 1]![key]);
    // The previous page is released before the next one is allocated; the cursor keeps only scalar keys.
    rows = [];
    rows = after.all(...cursor) as Row[];
  }
}
