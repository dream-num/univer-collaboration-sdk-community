import Database from "libsql";

/** The v1 schema stored every revision; the fixture rows describe two segments and a special one. */
export function createV1Database(filename: string): void {
  exec(filename, `
    PRAGMA user_version = 17;
    CREATE TABLE collaboration_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
    INSERT INTO collaboration_schema_versions VALUES ('history', 1), ('core', 3), ('application', 7);
    CREATE TABLE application_data (id TEXT PRIMARY KEY);
    INSERT INTO application_data VALUES ('keep');
    CREATE TABLE collaboration_history_revisions (
      unit_id TEXT NOT NULL, type INTEGER NOT NULL, revision INTEGER NOT NULL,
      user_id TEXT NOT NULL, commands_json TEXT NOT NULL, committed_at INTEGER NOT NULL,
      additional_fields TEXT, origin INTEGER NOT NULL, history_revision INTEGER NOT NULL,
      force_next_history INTEGER NOT NULL, restored_revision INTEGER,
      PRIMARY KEY (unit_id, revision)
    );
    CREATE INDEX collaboration_history_record_lookup ON collaboration_history_revisions(unit_id, history_revision DESC);
    CREATE INDEX collaboration_history_creator_lookup ON collaboration_history_revisions(unit_id, user_id);
    INSERT INTO collaboration_history_revisions VALUES
      ('u', 2, 1, 'creator', '["create"]', 1001, NULL, 1, 1, 0, NULL),
      ('u', 2, 2, 'a', '["edit"]', 2002, NULL, 1, 2, 0, NULL),
      ('u', 2, 3, 'b', '["edit"]', 3003, NULL, 1, 2, 0, NULL),
      ('u', 2, 4, 'bot', '["special"]', 4004, '{"origin":2}', 2, 4, 1, NULL);
  `);
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
