# @univerjs-pro/collaboration-file-endpoint

English | [简体中文](./README.zh-CN.md)

`UniverFileEndpoint` serves the HTTP routes the Univer frontend calls for image and attachment uploads and for Office import and export. It maps each request to `@univerjs-pro/collaboration-file-service` and runs on `@univerjs-pro/collaboration-transport-node`.

```text
HTTP request
→ Transport authentication middleware (sets ctx.userID)
→ UniverFileEndpoint (multipart, inflate, limits, response headers)
→ UniverFileService (ownership rules, middleware)
→ metadata adapter and blob store
```

## Installation and registration

```bash
pnpm add \
  @univerjs-pro/collaboration-file-service \
  @univerjs-pro/collaboration-file-endpoint \
  @univerjs-pro/collaboration-transport-node
```

```ts
const fileEndpoint = new UniverFileEndpoint(fileService, {
  maxUploadBytes: 100 * 1024 * 1024,
});

transport.use(authenticationMiddleware);
transport.register(fileEndpoint);
```

Register the File Endpoint before Endpoints that build on the File Service, so that Transport disposes them first. The Endpoint does not dispose the File Service.

| Option | Default |
| --- | --- |
| `routePrefix` | `/universer-api`; absolute, without a trailing slash |
| `maxUploadBytes` | unlimited; counts bytes actually read, after inflate |
| `uploadTimeoutMs` | 600000 (10 minutes) from the start of the request |
| `downloadCacheMaxAgeSeconds` | 3600; `max-age` of proxy downloads, `0` makes browsers revalidate every time |

## Routes

| Method | Path | Response |
| --- | --- | --- |
| `POST` | `{prefix}/stream/file/upload?size=&source=&assign=&flate=` | `{ error, FileId }` |
| `GET` | `{prefix}/file/{fileID}/sign-url` | `{ error, url }` |
| `GET` | `{prefix}/file/{fileID}/download` | file content |

With the default prefix these are the URLs that `exchange-client` and `collaboration-client` use by default, so the clients only need `downloadEndpointUrl` when the API is not served from the page origin.

**Upload.** The body is `multipart/form-data`; the part named `file` is streamed to the blob store without buffering, so Transport `maxRequestBodyBytes` does not apply. `flate=true` means the part is raw DEFLATE and is inflated while reading. `size` is only a hint; the stored size is what was actually written, and empty files are accepted. `source` that is missing or not an integer is stored as `0`. A request that is rejected, too large or timed out is answered and the connection is closed instead of reading the rest of the body.

**sign-url.** Returns an absolute direct link when the blob store signs one, otherwise the relative path of the download route. Clients resolve relative paths against `downloadEndpointUrl`.

**Download.** Responses carry `Content-Type` from the record, `Content-Length`, `Content-Disposition: attachment` with the file name, `X-Content-Type-Options: nosniff`, an `ETag` and `Cache-Control: private, max-age=<downloadCacheMaxAgeSeconds>, immutable`. Every file is served as an attachment; `<img>` embedding is not affected.

## Authentication

The Endpoint uses the `userID` that Transport middleware sets for the request and answers `401` when it is missing.

Images are loaded by the browser itself: the request carries cookies only when the file routes share the page's origin, and never carries the `Authorization` header the application adds to its own requests.

- **Cookie authentication, same origin:** proxy downloads work without extra configuration.
- **Cookie authentication, file routes on another origin** (a different subdomain counts): serve the file routes under the page's origin through a reverse proxy, or configure a blob store that signs direct links.
- **Bearer tokens only:** configure a blob store that signs direct links.

A direct link is authorized when it is issued through `sign-url` and needs no credentials when loaded.

## Errors

JSON routes always return a protocol `error` object; `error.code` is `OK` on success. Proxy download failures return a status code with a plain-text message.

| `FileError` code | HTTP | protocol `ErrorCode` |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | `INVALID_ARGUMENT` |
| `UNAUTHENTICATED` | 401 | `UNAUTHENTICATED` |
| `PERMISSION_DENIED` | 403 | `PERMISSION_DENIED` |
| `FILE_NOT_FOUND` | 404 | `NOT_FOUND` |
| `UPLOAD_TIMEOUT` | 408 | `INTERNAL_ERROR` |
| `PAYLOAD_TOO_LARGE` | 413 | `INVALID_ARGUMENT` |
| `STORAGE_FAILURE`, `SERVICE_DISPOSED` | 503 | `INTERNAL_ERROR` |
