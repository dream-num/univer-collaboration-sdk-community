import { randomUUID } from "node:crypto";
import { databaseAdapterContract } from "@univerjs-pro/collaboration-database-testkit";
import { afterAll, describe, it } from "vitest";
import { PostgresS3DatabaseAdapter } from "../src/index.js";
import {
  createS3Client,
  createTestDatabase,
  dropSchema,
  MemoryObjectStore,
  POSTGRES_URL,
  removePrefix,
  S3_BUCKET,
  S3_ENDPOINT,
  type TestDatabase,
} from "./helpers.mjs";

if (POSTGRES_URL === undefined) {
  describe("PostgreSQL + S3 IDatabaseAdapter contract", () => {
    it.skip("requires UNIVER_COLLAB_POSTGRES_URL to point at a PostgreSQL server", () => {});
  });
} else {
  // One database serves the whole file; every harness starts from an empty schema.
  let database: TestDatabase | undefined;
  const emptyPool = async () => {
    database ??= await createTestDatabase();
    await dropSchema(database.pool);
    return database.pool;
  };
  afterAll(async () => {
    await database?.dispose();
  });

  databaseAdapterContract("PostgreSQL + in-memory objects", async () => {
    const adapter = await PostgresS3DatabaseAdapter.create({
      pool: await emptyPool(),
      s3: { client: new MemoryObjectStore().client, bucket: "blocks" },
    });
    return { adapter, async dispose() {} };
  });

  if (S3_ENDPOINT === undefined || S3_BUCKET === undefined) {
    describe("PostgreSQL + S3 IDatabaseAdapter contract against an S3 service", () => {
      it.skip("set UNIVER_COLLAB_S3_ENDPOINT and UNIVER_COLLAB_S3_BUCKET to run", () => {});
    });
  } else {
    databaseAdapterContract("PostgreSQL + S3", async () => {
      const client = createS3Client();
      // Every harness writes under its own prefix and empties it afterwards.
      const prefix = `database-postgres-s3-test/${randomUUID()}`;
      const adapter = await PostgresS3DatabaseAdapter.create({
        pool: await emptyPool(),
        s3: { client, bucket: S3_BUCKET, prefix },
      });
      return {
        adapter,
        async dispose() {
          await removePrefix(client, prefix);
          client.destroy();
        },
      };
    });
  }
}
