import { CollabError } from "@univerjs-pro/collaboration-service";
import type { PostgresDatabaseAdapterOptions } from "../postgres-database-adapter.js";
import { SCHEMA_VERSION } from "../schema.js";
import { withCoreVersion } from "./shared.js";
import { upgradeV1ToV2 } from "./v1-to-v2.js";

/** Core schema versions before and after migration. @public */
export interface PostgresCoreMigrationResult {
  readonly from: number;
  readonly to: number;
}

/**
 * Upgrades an existing PostgreSQL core schema to the version this package writes.
 * Stop writers and arrange a database backup first. A current schema is left unchanged.
 * @public
 */
export function migratePostgresCore(options: PostgresDatabaseAdapterOptions): Promise<PostgresCoreMigrationResult> {
  return withCoreVersion(options, async (client, from) => {
    if (from === SCHEMA_VERSION) return { from, to: from };
    if (from > SCHEMA_VERSION) {
      throw new CollabError("INVALID_REQUEST", `Core schema version ${from} is newer than this package supports (${SCHEMA_VERSION})`);
    }
    await upgradeV1ToV2(client, from);
    return { from, to: 2 };
  });
}
