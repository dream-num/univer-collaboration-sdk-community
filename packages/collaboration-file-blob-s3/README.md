# @univerjs-pro/collaboration-file-blob-s3

English | [简体中文](./README.zh-CN.md)

An S3-compatible `IFileBlobStore` for `@univerjs-pro/collaboration-file-service`, with optional presigned direct links. It uses an `S3Client` that the application owns. Supports Node.js 22 and later.

## Installation and usage

```bash
pnpm add \
  @univerjs-pro/collaboration-file-service \
  @univerjs-pro/collaboration-file-blob-s3 \
  @aws-sdk/client-s3
```

```ts
// Reads and writes objects from the server, through an address the server can reach.
const client = new S3Client({ region: 'us-east-1', endpoint: 'http://minio:9000', forcePathStyle: true });
// Only signs direct links; it sends no requests. The signed URL uses this endpoint, so it must be an
// address browsers can reach. It must point to the same storage and bucket as `client`, with the same
// region and addressing style, and credentials allowed to read the objects (read-only is enough).
// When servers and browsers reach the storage at the same address, pass `client` here instead.
const signer = new S3Client({ region: 'us-east-1', endpoint: 'https://files.example.com', forcePathStyle: true });

const blobStore = new S3FileBlobStore({
  client,
  bucket: 'univer-files',
  prefix: 'files',
  directUrl: { client: signer, expiresInSeconds: 3600 },
});
const fileService = new UniverFileService({ database, blobStore });
```

`@aws-sdk/client-s3` is a peer dependency. The store never destroys the clients passed to it.

| Option | Meaning |
| --- | --- |
| `client` | reads and writes objects |
| `bucket` | target bucket |
| `prefix` | objects are stored at `{prefix}/{fileID}`, or `{fileID}` without a prefix; no leading or trailing slash |
| `directUrl.client` | signing-only client configured with the endpoint browsers can reach; omit `directUrl` to serve every download through the File Endpoint proxy route |
| `directUrl.expiresInSeconds` | lifetime of a signed URL, 1 to 604800; default 3600 |

## Behavior

- Uploads stream through `@aws-sdk/lib-storage` multipart uploads, so the content length does not need to be known. A failed upload is aborted and leaves no object.
- Direct links are presigned `GET` URLs that set `Content-Type` and `Content-Disposition: attachment` like the proxy route.
- Deleting a missing key succeeds.

## Bucket configuration

- **Lifecycle:** add an `AbortIncompleteMultipartUpload` rule so that uploads interrupted by a process crash are removed.
- **CORS:** with direct links, browsers load objects from the bucket origin. Allow `GET` from the application origin and expose `Content-Disposition` (`ExposeHeaders`) so clients can read the file name.
- **S3-compatible services:** recent AWS SDK versions send CRC checksum headers by default, which some S3-compatible services do not accept. If requests fail with checksum or `Content-MD5` errors, create the clients with `requestChecksumCalculation: 'WHEN_REQUIRED'`.
