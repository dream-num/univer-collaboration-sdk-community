# @univerjs-pro/collaboration-file-blob-local

[English](./README.md) | [简体中文](./README.zh-CN.md)

面向 `@univerjs-pro/collaboration-file-service` 的本地目录 `IFileBlobStore`，用于单节点部署。支持 Node.js 22 及以上。

```bash
pnpm add \
  @univerjs-pro/collaboration-file-service \
  @univerjs-pro/collaboration-file-blob-local
```

```ts
const blobStore = new LocalFileBlobStore({ directory: './data/files' });
const fileService = new UniverFileService({ database, blobStore });
```

- 目录不存在时会自动创建。每个文件保存为 `<directory>/<fileID>`，`blobKey` 就是 `fileID`。
- 上传先写入同目录下的临时文件，再改名到位，上传失败时不会留下对象。
- 不是普通文件名的键在写入时被拒绝，读取时视为不存在。
- 不签发直链，下载走 File Endpoint 的代理路由。
- 只适合由单个进程提供全部文件的部署；多节点请使用对象存储，例如 `@univerjs-pro/collaboration-file-blob-s3`。
