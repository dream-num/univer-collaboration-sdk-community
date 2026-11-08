import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateRawSync } from "node:zlib";
import { MemoryFileBlobStore, MemoryFileDatabaseAdapter } from "@univerjs-pro/collaboration-file-memory";
import { FileError, UniverFileService } from "@univerjs-pro/collaboration-file-service";
import { createNodeTransport } from "@univerjs-pro/collaboration-transport-node";
import { ErrorCode } from "@univerjs/protocol";
import { parse as parseContentDisposition } from "content-disposition";
import { afterEach, describe, expect, it } from "vitest";
import { UniverFileEndpoint, type UniverFileEndpointOptions } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createHost(options: UniverFileEndpointOptions = {}) {
  const database = new MemoryFileDatabaseAdapter();
  const blobStore = new MemoryFileBlobStore();
  const service = new UniverFileService({ database, blobStore, cleanup: false });
  const endpoint = new UniverFileEndpoint(service, options);
  const transport = createNodeTransport();
  transport.use(async (ctx, next) => {
    const userID = ctx.incomingMessage.headers["x-user-id"];
    if (typeof userID === "string") ctx.userID = userID;
    await next();
  });
  transport.register(endpoint);
  const server = createServer((request, response) => transport.handleRequest(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(async () => {
    await transport.dispose();
    await service.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${port}`, port, service, database, blobStore };
}

function form(content: BlobPart, fileName = "image.png", type = "image/png", field = "file"): FormData {
  const body = new FormData();
  body.append("note", "ignored");
  body.append(field, new Blob([content], { type }), fileName);
  return body;
}

async function upload(base: string, query: string, body: FormData | string, user: string | null = "alice", headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/universer-api/stream/file/upload?${query}`, {
    method: "POST",
    body,
    headers: { ...(user ? { "x-user-id": user } : {}), ...headers },
  });
  return { response, json: (await response.json()) as { error: { code: number; message: string }; FileId: string } };
}

async function download(base: string, fileID: string, user = "alice") {
  return fetch(`${base}/universer-api/file/${fileID}/download`, { headers: { "x-user-id": user } });
}

describe("UniverFileEndpoint", () => {
  it("uploads, signs a proxy URL and downloads with the documented headers", async () => {
    const { base } = await createHost();
    const { response, json } = await upload(base, "size=5&source=3&assign=unit-1", form("hello", "报表 2026.png"));
    expect(response.status).toBe(200);
    expect(json.error.code).toBe(ErrorCode.OK);
    expect(json.FileId).toMatch(/^[0-9a-f-]{36}$/);

    const signed = await fetch(`${base}/universer-api/file/${json.FileId}/sign-url`, { headers: { "x-user-id": "bob" } });
    expect(await signed.json()).toEqual({
      error: { code: ErrorCode.OK, message: "" },
      url: `/universer-api/file/${json.FileId}/download`,
    });

    const file = await download(base, json.FileId, "bob");
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("hello");
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("content-length")).toBe("5");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("cache-control")).toBe("private, max-age=3600, immutable");
    expect(file.headers.get("etag")).toBe(`"${json.FileId}"`);
    // RFC 6266: an ASCII fallback in `filename` and the full name in `filename*`.
    const disposition = parseContentDisposition(file.headers.get("content-disposition")!);
    expect(disposition.type).toBe("attachment");
    expect(disposition.parameters.filename).toBe("报表 2026.png");
  });

  it("uses the configured cache max-age", async () => {
    const { base } = await createHost({ downloadCacheMaxAgeSeconds: 0 });
    const { json } = await upload(base, "source=3&assign=unit-1", form("x"));
    expect((await download(base, json.FileId)).headers.get("cache-control")).toBe("private, max-age=0, immutable");
  });

  it("validates endpoint options", () => {
    const service = new UniverFileService({ database: new MemoryFileDatabaseAdapter(), blobStore: new MemoryFileBlobStore() });
    expect(() => new UniverFileEndpoint(service, { downloadCacheMaxAgeSeconds: -1 })).toThrow(TypeError);
    expect(() => new UniverFileEndpoint(service, { downloadCacheMaxAgeSeconds: 1.5 })).toThrow(TypeError);
    expect(() => new UniverFileEndpoint(service, { routePrefix: "/api/" })).toThrow(TypeError);
  });

  it("inflates flate uploads and records the decompressed size", async () => {
    const { base, database } = await createHost();
    const raw = "a".repeat(1000);
    const { json } = await upload(base, `size=${raw.length}&source=1&flate=true`, form(deflateRawSync(raw), "file.json", "application/json"));
    expect(json.error.code).toBe(ErrorCode.OK);
    const record = await database.get(json.FileId, { userID: "t", customData: {}, request: { fileID: json.FileId } });
    expect(record).toMatchObject({ size: 1000, source: 1, assign: "alice", contentType: "application/json" });
    expect(await (await download(base, json.FileId)).text()).toBe(raw);
  });

  it("rejects data that is not raw DEFLATE when flate is set", async () => {
    const { base, blobStore } = await createHost();
    const { response, json } = await upload(base, "source=1&flate=true", form("plain text"));
    expect(response.status).toBe(400);
    expect(json.error.code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(await blobStore.open("x", {} as never).catch((error: FileError) => error.code)).toBe("FILE_NOT_FOUND");
  });

  it("returns 401 without an ingress identity", async () => {
    const { base } = await createHost();
    const { response, json } = await upload(base, "source=3&assign=unit-1", form("x"), null);
    expect(response.status).toBe(401);
    expect(json).toEqual({ error: { code: ErrorCode.UNAUTHENTICATED, message: expect.any(String) }, FileId: "" });
    expect((await fetch(`${base}/universer-api/file/abc/download`)).status).toBe(401);
  });

  it("keeps HttpImport and HttpExport files private to their owner", async () => {
    const { base } = await createHost();
    const { json } = await upload(base, "source=2&assign=bob", form("secret"));
    expect((await download(base, json.FileId, "alice")).status).toBe(200);
    const denied = await download(base, json.FileId, "bob");
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain("text/plain");
    const sign = await fetch(`${base}/universer-api/file/${json.FileId}/sign-url`, { headers: { "x-user-id": "bob" } });
    expect(sign.status).toBe(403);
    expect(await sign.json()).toEqual({ error: { code: ErrorCode.PERMISSION_DENIED, message: expect.any(String) }, url: "" });
  });

  it("returns 404 for an unknown file", async () => {
    const { base } = await createHost();
    expect((await download(base, "missing")).status).toBe(404);
  });

  it("stores a malformed source as 0 and rejects UnitEmbedded without assign", async () => {
    const { base, database } = await createHost();
    const { json } = await upload(base, "source=abc", form("x"));
    const record = await database.get(json.FileId, { userID: "t", customData: {}, request: { fileID: json.FileId } });
    expect(record?.source).toBe(0);
    const missingAssign = await upload(base, "source=3", form("x"));
    expect(missingAssign.response.status).toBe(400);
  });

  it("accepts an empty file", async () => {
    const { base } = await createHost();
    const { json } = await upload(base, "size=0&source=3&assign=unit-1", form(""));
    expect(json.error.code).toBe(ErrorCode.OK);
    const file = await download(base, json.FileId);
    expect(await file.text()).toBe("");
    expect(file.headers.get("content-length")).toBe("0");
  });

  it("rejects non-multipart requests and multipart without a file part", async () => {
    const { base } = await createHost();
    expect((await upload(base, "source=3&assign=u", "plain", "alice", { "content-type": "text/plain" })).response.status).toBe(400);
    const noFile = new FormData();
    noFile.append("note", "only a field");
    expect((await upload(base, "source=3&assign=u", noFile)).response.status).toBe(400);
  });

  it("enforces maxUploadBytes on the bytes actually read", async () => {
    const { base, blobStore } = await createHost({ maxUploadBytes: 4 });
    const { response, json } = await upload(base, "size=1&source=3&assign=unit-1", form("12345"));
    expect(response.status).toBe(413);
    expect(json.error.code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(await blobStore.open("x", {} as never).catch((error: FileError) => error.code)).toBe("FILE_NOT_FOUND");
    expect((await upload(base, "source=3&assign=unit-1", form("1234"))).response.status).toBe(200);
  });

  it("lets upload middleware deny before any content is stored", async () => {
    const { base, service, database } = await createHost();
    service.use("upload", async (ctx, next) => {
      if (ctx.request.assign === "locked-unit") throw new FileError("PERMISSION_DENIED", "no edit right");
      await next();
    });
    const { response } = await upload(base, "source=3&assign=locked-unit", form("x"));
    expect(response.status).toBe(403);
    const listed = await database.list({ source: 3, limit: 10 }, { userID: "t", customData: {}, request: { fileID: "t" } });
    expect(listed.records).toEqual([]);
  });

  it("times out a slow upload with 408", async () => {
    const { port } = await createHost({ uploadTimeoutMs: 100 });
    const boundary = "----univer-test";
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/universer-api/stream/file/upload?source=3&assign=unit-1",
          headers: { "x-user-id": "alice", "content-type": `multipart/form-data; boundary=${boundary}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      // Only the part headers and a short piece of content are written; nothing follows until the server times out.
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.bin"\r\n\r\npartial`);
    });
    expect(status).toBe(408);
  });
});
