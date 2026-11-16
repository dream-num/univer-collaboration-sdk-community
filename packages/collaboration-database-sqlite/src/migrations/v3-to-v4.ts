import { requireColumns, requireCoreVersion, runMigration, setCoreVersion } from "./shared.js";

/**
 * Atomically upgrades core schema v3 to v4, adding empty Unit and changeset metadata.
 * Requires schema v3. Stop writers and back up the database before calling; this step does not create a backup.
 * @public
 */
export async function migrateSQLiteCoreV3ToV4(options: { readonly filename: string }): Promise<void> {
  await runMigration(options.filename, (database) => {
    requireCoreVersion(database, 3, "Metadata migration");
    requireColumns(database, "collaboration_units", ["unit_id", "head_revision", "deleted_status"]);
    requireColumns(database, "collaboration_changesets", ["unit_id", "revision", "payload"]);
    database.exec(`
      ALTER TABLE collaboration_units ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(metadata));
      ALTER TABLE collaboration_changesets ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(metadata));
    `);
    setCoreVersion(database, 4);
  });
}
