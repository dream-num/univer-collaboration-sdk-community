import type { PoolClient } from "pg";
import { CollabError } from "@univerjs-pro/collaboration-service";
import type { PostgresDatabaseAdapterOptions } from "../postgres-database-adapter.js";
import { withCoreVersion } from "./shared.js";

/**
 * Upgrades PostgreSQL core v1 to v2, adding empty metadata to existing Units and changesets.
 * Requires core v1. Stop writers and back up the database before calling.
 * @public
 */
export function migratePostgresCoreV1ToV2(options: PostgresDatabaseAdapterOptions): Promise<void> {
  return withCoreVersion(options, upgradeV1ToV2);
}

export async function upgradeV1ToV2(client: PoolClient, version: number): Promise<void> {
  if (version !== 1) {
    throw new CollabError("INVALID_REQUEST", "PostgreSQL core v1-to-v2 migration requires schema version 1");
  }
  await client.query(`
    ALTER TABLE collaboration.units ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE collaboration.changesets ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
  const update = await client.query("UPDATE collaboration.schema_versions SET version = 2 WHERE component = 'core' AND version = 1");
  if (update.rowCount !== 1) {
    throw new CollabError("INVALID_REQUEST", "Failed to publish PostgreSQL core schema version 2");
  }
}
