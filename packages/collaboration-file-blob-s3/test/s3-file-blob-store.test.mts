import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, ListMultipartUploadsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { fileBlobStoreContract } from "@univerjs-pro/collaboration-file-blob-testkit";
import { parse as parseContentDisposition } from "content-disposition";
import { describe, expect, it } from "vitest";
import { S3FileBlobStore } from "../src/index.js";

// Needs a real S3-compatible service such as MinIO: set UNIVER_COLLAB_S3_ENDPOINT, UNIVER_COLLAB_S3_BUCKET,
// UNIVER_COLLAB_S3_ACCESS_KEY and UNIVER_COLLAB_S3_SECRET_KEY; UNIVER_COLLAB_S3_REGION defaults to us-east-1.
// Every harness uses its own prefix and empties it afterwards.
const endpoint = process.env.UNIVER_COLLAB_S3_ENDPOINT;
const bucket = process.env.UNIVER_COLLAB_S3_BUCKET;

function client(): S3Client {
  return new S3Client({
    endpoint,
    region: process.env.UNIVER_COLLAB_S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.UNIVER_COLLAB_S3_ACCESS_KEY ?? "",
      secretAccessKey: process.env.UNIVER_COLLAB_S3_SECRET_KEY ?? "",
    },
  });
}

async function listKeys(s3: S3Client, prefix: string): Promise<string[]> {
  const result = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/` }));
  return (result.Contents ?? []).map((item) => item.Key!);
}

if (endpoint && bucket) {
  fileBlobStoreContract("S3", async () => {
    const s3 = client();
    const prefix = `contract-${randomUUID()}`;
    const store = new S3FileBlobStore({ client: s3, bucket, prefix, directUrl: { client: s3, expiresInSeconds: 60 } });
    return {
      store,
      countObjects: async () => (await listKeys(s3, prefix)).length,
      dispose: async () => {
        // Objects are deleted one by one: recent SDKs send DeleteObjects without Content-MD5, which some
        // S3-compatible services reject.
        for (const Key of await listKeys(s3, prefix)) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
        s3.destroy();
      },
    };
  });

  describe("S3FileBlobStore multipart uploads", () => {
    const context = { userID: "u", customData: {}, request: { fileID: "f" } };
    const MiB = 1024 * 1024;

    async function* stream(chunks: number, failAfter?: number) {
      for (let index = 0; index < chunks; index += 1) {
        if (failAfter !== undefined && index === failAfter) throw new Error("client went away");
        yield new Uint8Array(MiB).fill(index % 256);
      }
    }

    it("streams a body larger than one part and reports its size", async () => {
      const s3 = client();
      const prefix = `multipart-${randomUUID()}`;
      const store = new S3FileBlobStore({ client: s3, bucket, prefix });
      const put = await store.put({ fileID: "big", contentType: "application/octet-stream", content: stream(12) }, context);
      expect(put.size).toBe(12 * MiB);
      let read = 0;
      for await (const chunk of await store.open(put.blobKey, context)) read += chunk.byteLength;
      expect(read).toBe(12 * MiB);
      await store.delete(put.blobKey, context);
      s3.destroy();
    });

    it("aborts the multipart upload when the stream fails midway", async () => {
      const s3 = client();
      const prefix = `abort-${randomUUID()}`;
      const store = new S3FileBlobStore({ client: s3, bucket, prefix });
      await expect(
        store.put({ fileID: "broken", contentType: "application/octet-stream", content: stream(12, 6) }, context)
      ).rejects.toThrow();
      expect(await listKeys(s3, prefix)).toEqual([]);
      const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: `${prefix}/` }));
      expect(uploads.Uploads ?? []).toEqual([]);
      s3.destroy();
    });
  });

  describe("S3FileBlobStore direct URLs", () => {
    it("signs a GET that forces attachment with the stored name", async () => {
      const s3 = client();
      const prefix = `direct-${randomUUID()}`;
      const store = new S3FileBlobStore({ client: s3, bucket, prefix, directUrl: { client: s3 } });
      const context = { userID: "u", customData: {}, request: { fileID: "f" } };
      const put = await store.put(
        { fileID: "f", contentType: "text/csv", content: (async function* () { yield new TextEncoder().encode("a,b"); })() },
        context
      );
      const direct = await store.signUrl(
        { blobKey: put.blobKey, record: { fileID: "f", name: "报表.csv", size: 3, contentType: "text/csv", source: 2, assign: "u", blobKey: put.blobKey, createdAt: 1 } },
        context
      );
      const response = await fetch(direct!.url);
      expect(await response.text()).toBe("a,b");
      expect(response.headers.get("content-type")).toBe("text/csv");
      expect(parseContentDisposition(response.headers.get("content-disposition")!).parameters.filename).toBe("报表.csv");
      await store.delete(put.blobKey, context);
      s3.destroy();
    });
  });
} else {
  describe.skip("S3FileBlobStore (set UNIVER_COLLAB_S3_ENDPOINT and UNIVER_COLLAB_S3_BUCKET to run)", () => {
    it("runs the contract against an S3-compatible service", () => undefined);
  });
}

describe("S3FileBlobStore options", () => {
  it("validates configuration and returns no direct URL without a signer", async () => {
    const s3 = new S3Client({ region: "us-east-1" });
    expect(() => new S3FileBlobStore({ client: s3, bucket: "" })).toThrow(TypeError);
    expect(() => new S3FileBlobStore({ client: s3, bucket: "b", prefix: "/files" })).toThrow(TypeError);
    expect(() => new S3FileBlobStore({ client: s3, bucket: "b", directUrl: { client: s3, expiresInSeconds: 0 } })).toThrow(TypeError);
    const store = new S3FileBlobStore({ client: s3, bucket: "b" });
    const record = { fileID: "f", name: "n", size: 0, contentType: "x/y", source: 3, assign: "u", blobKey: "f", createdAt: 1 };
    expect(await store.signUrl({ blobKey: "f", record }, { userID: "u", customData: {}, request: { fileID: "f" } })).toBeNull();
    s3.destroy();
  });

  it("signs locally without network access", async () => {
    const s3 = new S3Client({
      region: "us-east-1",
      endpoint: "https://files.example.com",
      forcePathStyle: true,
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    });
    const store = new S3FileBlobStore({ client: s3, bucket: "bucket", prefix: "files", directUrl: { client: s3, expiresInSeconds: 120 } });
    const record = { fileID: "f", name: "报表 (1).png", size: 0, contentType: "image/png", source: 3, assign: "u", blobKey: "files/f", createdAt: 1 };
    const direct = await store.signUrl({ blobKey: "files/f", record }, { userID: "u", customData: {}, request: { fileID: "f" } });
    const url = new URL(direct!.url);
    expect(url.origin + url.pathname).toBe("https://files.example.com/bucket/files/f");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(parseContentDisposition(url.searchParams.get("response-content-disposition")!).parameters.filename).toBe("报表 (1).png");
    expect(url.searchParams.get("response-content-type")).toBe("image/png");
    expect(direct!.expiresAt).toBeGreaterThan(Date.now() + 100_000);
    s3.destroy();
  });
});
