import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import pg from "pg";

/** Connection string for the test server; CI and local runs set it explicitly. */
export const POSTGRES_URL = process.env.UNIVER_COLLAB_POSTGRES_URL;

// The adapter always uses the fixed `collaboration` schema, so these tests run in a database of their
// own: the other PostgreSQL adapters' tests use the configured database at the same time.
export interface TestDatabase {
  readonly pool: pg.Pool;
  dispose(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const database = `collaboration_s3_test_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Pool({ connectionString: POSTGRES_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${database}`);
  const connection = new URL(POSTGRES_URL!);
  connection.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: connection.toString(), max: 4 });
  return {
    pool,
    async dispose() {
      await pool.end();
      await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    },
  };
}

/** Removes the `collaboration` schema so every test starts from an empty database. */
export async function dropSchema(pool: pg.Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS collaboration CASCADE");
}

/**
 * In-memory stand-in for the four object requests the adapter sends, so the contract runs wherever
 * PostgreSQL is available. `requests` records them in order.
 */
export class MemoryObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly requests: { readonly name: "put" | "get" | "delete" | "list"; readonly key: string }[] = [];
  /** Makes every delete request fail. */
  failDeletes = false;

  get client(): S3Client {
    return this as unknown as S3Client;
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key!;
      this.requests.push({ name: "put", key });
      this.objects.set(key, Uint8Array.from(command.input.Body as Uint8Array));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key!;
      this.requests.push({ name: "get", key });
      const bytes = this.objects.get(key);
      if (!bytes) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
      return { Body: { transformToByteArray: async () => Uint8Array.from(bytes) } };
    }
    if (command instanceof DeleteObjectCommand) {
      const key = command.input.Key!;
      this.requests.push({ name: "delete", key });
      if (this.failDeletes) throw new Error("delete failed");
      this.objects.delete(key);
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      this.requests.push({ name: "list", key: prefix });
      return { Contents: this.keys().filter((key) => key.startsWith(prefix)).map((Key) => ({ Key })) };
    }
    throw new Error("Unexpected object request");
  }
}

// A real S3-compatible service such as MinIO is used when UNIVER_COLLAB_S3_ENDPOINT, UNIVER_COLLAB_S3_BUCKET,
// UNIVER_COLLAB_S3_ACCESS_KEY and UNIVER_COLLAB_S3_SECRET_KEY are set; UNIVER_COLLAB_S3_REGION defaults to
// us-east-1 and UNIVER_COLLAB_S3_PATH_STYLE=0 selects virtual-hosted addressing.
export const S3_ENDPOINT = process.env.UNIVER_COLLAB_S3_ENDPOINT;
export const S3_BUCKET = process.env.UNIVER_COLLAB_S3_BUCKET;

export function createS3Client(): S3Client {
  return new S3Client({
    endpoint: S3_ENDPOINT,
    region: process.env.UNIVER_COLLAB_S3_REGION ?? "us-east-1",
    forcePathStyle: process.env.UNIVER_COLLAB_S3_PATH_STYLE !== "0",
    // Checksums only where the API requires them: some compatible stores reject the newer defaults.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: process.env.UNIVER_COLLAB_S3_ACCESS_KEY ?? "",
      secretAccessKey: process.env.UNIVER_COLLAB_S3_SECRET_KEY ?? "",
    },
  });
}

export async function listKeys(client: S3Client, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: `${prefix}/`, ContinuationToken: token }),
    );
    for (const item of page.Contents ?? []) keys.push(item.Key!);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export async function removePrefix(client: S3Client, prefix: string): Promise<void> {
  for (const Key of await listKeys(client, prefix)) {
    await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key }));
  }
}
