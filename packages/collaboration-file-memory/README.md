# @univerjs-pro/collaboration-file-memory

English | [简体中文](./README.zh-CN.md)

In-memory `IFileDatabaseAdapter` and `IFileBlobStore` for `@univerjs-pro/collaboration-file-service`, for tests and demos. Data is lost when the process exits.

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

- `MemoryFileDatabaseAdapter` keeps one record per `fileID`; deleting a record always releases its content.
- `MemoryFileBlobStore` uses the `fileID` as the `blobKey` and reads the whole upload before storing it, so a failed upload stores nothing.
- `MemoryFileBlobStore` does not sign direct links; downloads go through the File Endpoint proxy route.
- `dispose()` clears the stored data.

Both classes are short reference implementations of the two contracts.
