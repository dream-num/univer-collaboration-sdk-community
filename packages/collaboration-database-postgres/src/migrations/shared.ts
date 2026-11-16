import type { PoolClient } from "pg";
import { CollabError } from "@univerjs-pro/collaboration-service";
import type { PostgresDatabaseAdapterOptions } from "../postgres-database-adapter.js";
import { readCoreVersion, SCHEMA_LOCK_KEY } from "../schema.js";
import { transaction } from "../transaction.js";

export function withCoreVersion<T>(
  options: PostgresDatabaseAdapterOptions,
  work: (client: PoolClient, version: number) => Promise<T>,
): Promise<T> {
  return transaction(options.pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_KEY]);
    const version = await readCoreVersion(client);
    if (version === undefined) {
      throw new CollabError("INVALID_REQUEST", "The database has no PostgreSQL core schema version to migrate from");
    }
    return work(client, version);
  });
}
