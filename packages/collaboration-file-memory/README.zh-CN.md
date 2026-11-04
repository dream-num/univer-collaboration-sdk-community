# @univerjs-pro/collaboration-file-memory

[English](./README.md) | [简体中文](./README.zh-CN.md)

面向 `@univerjs-pro/collaboration-file-service` 的内存 `IFileDatabaseAdapter` 与 `IFileBlobStore`，
用于测试和演示。进程退出后数据丢失。

```bash
pnpm add \
  @univerjs-pro/collaboration-file-service \
  @univerjs-pro/collaboration-file-memory
```

```ts
const fileService = new UniverFileService({
  database: new MemoryFileDatabaseAdapter(),
  blobStore: new MemoryFileBlobStore(),
});
```

- `MemoryFileDatabaseAdapter` 每个 `fileID` 保存一条记录，删除记录时总会释放它的内容。
- `MemoryFileBlobStore` 用 `fileID` 作为 `blobKey`，读完整个上传内容后才保存，上传失败时不会留下数据。
- `MemoryFileBlobStore` 不签发直链，下载走 File Endpoint 的代理路由。
- `dispose()` 清空已保存的数据。

两个类都是对应契约的简短参考实现。
