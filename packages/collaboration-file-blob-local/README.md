# @univerjs-pro/collaboration-file-blob-local

English | [简体中文](./README.zh-CN.md)

A local-directory `IFileBlobStore` for `@univerjs-pro/collaboration-file-service`, for single-node deployments. Supports Node.js 22 and later.

```bash
pnpm add \
  @univerjs-pro/collaboration-file-service \
  @univerjs-pro/collaboration-file-blob-local
```

```ts
const blobStore = new LocalFileBlobStore({ directory: './data/files' });
const fileService = new UniverFileService({ database, blobStore });
```

- The directory is created if it does not exist. Each file is stored as `<directory>/<fileID>`, and the `blobKey` is the `fileID`.
- Uploads are written to a temporary file in the same directory and renamed into place, so a failed upload leaves no object.
- Keys that are not plain file names are rejected on write and treated as missing on read.
- The store does not sign direct links; downloads go through the File Endpoint proxy route.
- Use it only when a single process serves all files; for several nodes use an object store such as `@univerjs-pro/collaboration-file-blob-s3`.
