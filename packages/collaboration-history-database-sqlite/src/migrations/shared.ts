import Database from "libsql";

/**
 * Opens an existing database and runs `work` in one immediate transaction. Any failure rolls the
 * whole migration back, so a database is either fully migrated or untouched.
 */
export function runMigration(filename: string, work: (database: Database.Database) => void): void {
  const database = new Database(filename, { fileMustExist: true });
  let transaction = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transaction = true;
    work(database);
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

export function readComponentVersion(database: Database.Database, component: string): number | undefined {
  const row = database
    .prepare("SELECT version FROM collaboration_schema_versions WHERE component = ?")
    .get(component) as { version: number } | undefined;
  return row?.version;
}
