# @univerjs-pro/collaboration-file-service

English | [简体中文](./README.zh-CN.md)

`UniverFileService` stores the binary files that Univer clients upload: images and attachments inserted into Units, and the source files and results of Office import and export. It writes file metadata through an `IFileDatabaseAdapter` and file content through an `IFileBlobStore`, enforces the built-in ownership rules, runs middleware, and removes expired temporary files.

The Service has no network dependency and does not depend on `@univerjs-pro/collaboration-service`. `@univerjs-pro/collaboration-file-endpoint` serves the HTTP requests of the Univer frontend on top of it: image and attachment uploads, downloads and import/export file transfers.

## Installation and usage

```bash
pnpm add \
  @univerjs-pro/collaboration-file-service \
  @univerjs-pro/collaboration-file-database-sqlite \
  @univerjs-pro/collaboration-file-blob-local
```

```ts
const database = new SQLiteFileDatabaseAdapter({ filename: './data/collaboration.sqlite' });
const blobStore = new LocalFileBlobStore({ directory: './data/files' });
const fileService = new UniverFileService({ database, blobStore });

fileService.use('upload', async (ctx, next) => {
  if (ctx.request.source === FileSource.UnitEmbedded) {
    await requireUnitEdit(ctx.userID, ctx.request.assign);
  }
  await next();
});

await fileService.dispose();
await database.dispose();
await blobStore.dispose();
```

`database` and `blobStore` are required; the constructor throws a `TypeError` without them. The Service never disposes adapters passed to it.

Available implementations:

| Package | Contract | Deployment |
| --- | --- | --- |
| `@univerjs-pro/collaboration-file-memory` | both | tests and demos |
| `@univerjs-pro/collaboration-file-database-sqlite` | `IFileDatabaseAdapter` | single node |
| `@univerjs-pro/collaboration-file-database-postgres` | `IFileDatabaseAdapter` | single or multiple nodes |
| `@univerjs-pro/collaboration-file-blob-local` | `IFileBlobStore` | single node |
| `@univerjs-pro/collaboration-file-blob-s3` | `IFileBlobStore` | S3-compatible object storage, direct links |

Metadata and content are separate contracts, so each can follow the storage the application already runs, for example Postgres metadata with S3 content.

## Methods

Every method takes a caller context `{ userID, customData? }`. `userID` is required. `customData` is shared by every middleware and adapter call of one Service call; the Service creates an empty object when it is omitted.

**Checked operations.** `@univerjs-pro/collaboration-file-endpoint` calls these on behalf of end users. They apply the built-in ownership rules and run middleware.

| Method | Result |
| --- | --- |
| `upload(input, ctx)` | the stored `FileRecord` |
| `signUrl({ fileID }, ctx)` | `{ record, direct? }`; `direct` is present when the blob store signed a direct link |
| `openDownload({ fileID }, ctx)` | `{ record, content }` |

**Direct operations.** These read and write files directly, for server code such as an import/export service or the application itself. They skip the ownership rules and middleware; `source` and `assign` are the caller's responsibility. Never expose them to HTTP clients.

| Method | Result |
| --- | --- |
| `createFile(input, ctx)` | the stored `FileRecord` |
| `getFile(fileID, ctx)` | `FileRecord`, or `null` when it does not exist |
| `openFile(fileID, ctx)` | `{ record, content }` |
| `deleteFile(fileID, ctx)` | `true` when a record was deleted |
| `listFiles({ source, assign?, createdBefore?, limit, cursor? }, ctx)` | `{ records, nextCursor }`, ordered by `(createdAt, fileID)`; `nextCursor` is `null` on the last page |
| `cleanupExpiredFiles(options, ctx)` | `{ scanned, deleted, failed }` |

Content is an `AsyncIterable<Uint8Array>` in both directions. Each upload gets a new `fileID` (`randomUUID()`); content is never overwritten. `FileRecord.size` is the number of bytes actually written.

## Ownership rules

| `source` | `assign` | Access |
| --- | --- | --- |
| `HttpImport` (1), `HttpExport` (2) | forced to the uploader on HTTP upload | only `assign === userID`; temporary |
| `UnitEmbedded` (3) | the Unit ID; required on upload | decided by middleware; permanent |
| any other value | stored as sent | decided by middleware; permanent |

The built-in check runs before middleware, so middleware can only narrow access. The Service does not know the application's Unit permissions: install them as middleware. `UnitEmbedded` files are not removed when their Unit is deleted; use `listFiles` with the Unit ID as `assign` if the application wants to clean them up.

## Middleware

`use(action, middleware)` returns a `Disposable`. Middleware calls `next()` to continue or throws `FileError('PERMISSION_DENIED')` to reject. `ctx.request` and `ctx.record` are read-only. Direct operations never run middleware.

| Action | Runs | Visible fields | Typical use |
| --- | --- | --- | --- |
| `upload` | before any content is read | `userID`, `customData`, `request` (`name`, `contentType`, declared `size`, `source`, `assign`, `flate`) | Unit edit permission, quota, rate limits |
| `signUrl` | after the record is loaded and the built-in check passes | `userID`, `customData`, `request.fileID`, `record` | Unit view permission, audit |
| `download` | proxy downloads only, before content opens | `userID`, `customData`, `request.fileID`, `record` | the same access control as `signUrl` |

Each action runs once per call and is never retried. Proxy download URLs are not signed, so install the same access control on both `signUrl` and `download`: the first covers direct-link deployments, the second covers proxy downloads.

## Expired file cleanup

`cleanupExpiredFiles` deletes `HttpImport` and `HttpExport` files older than the retention period, page by page. The Service runs it on a built-in timer by default; pass `cleanup` options to tune the timer, or `cleanup: false` to call the method from your own scheduler, for example once per tenant.

| Option | Default |
| --- | --- |
| `context` | `{ userID: FILE_CLEANUP_USER_ID }`, the identity adapters see for cleanup calls |
| `intervalMs` | 60 minutes; the first run starts after a random delay in `[intervalMs, 2 × intervalMs)` |
| `retentionMs` | 2 hours |
| `batchSize` | 100 |
| `maxPerRun` | 500 |
| `batchGapMs` | 1 second |

Cleanup is idempotent, so running it on several nodes at once is safe. A run that is still in progress in the same process makes the next one return immediately.

## Errors

All failures are `FileError` with a `code`; a wrapped adapter error is kept in `cause`. Every method reports failures as a rejected Promise.

| `code` | Meaning |
| --- | --- |
| `INVALID_REQUEST` | invalid input, missing `assign` for `UnitEmbedded`, duplicate `fileID` |
| `FILE_NOT_FOUND` | metadata or content does not exist |
| `UNAUTHENTICATED` | no authenticated user (raised by the Endpoint) |
| `PERMISSION_DENIED` | built-in check or middleware rejected the call |
| `PAYLOAD_TOO_LARGE`, `UPLOAD_TIMEOUT` | upload limits (raised by the Endpoint) |
| `STORAGE_FAILURE` | an adapter threw something other than `FileError`; the original error is in `cause` |
| `SERVICE_DISPOSED` | the Service is disposed |

## Lifecycle and orphan objects

`dispose()` stops the cleanup timer and waits for calls in progress. Calls made afterwards fail with `SERVICE_DISPOSED`.

Writes store content before metadata and delete metadata before content. If the second step fails, content may be left without a record. The Service logs a warning with `fileID` and `blobKey` through the `logger` option (default `console`); it does not reclaim these objects.

## Implementing an adapter

`IFileDatabaseAdapter` stores `FileRecord`s: `create` (duplicate `fileID` throws `FileError('INVALID_REQUEST')`), `get`, `delete` (returns `{ record, releasedBlobKey }`), `list` (ordered by `(createdAt, fileID)` with an opaque cursor) and `dispose`. `IFileBlobStore` maps an opaque `blobKey` to bytes: `put` (returns `{ blobKey, size }` and leaves nothing behind on failure), `open` (missing key throws `FileError('FILE_NOT_FOUND')`), `delete` (missing key succeeds), optional `signUrl` and `dispose`. Adapters receive `{ userID, customData, request }` and do not authorize, interpret `source` or apply cleanup policy. The built-in implementations are reference implementations of both contracts.
