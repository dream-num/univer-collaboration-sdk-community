# @univerjs-pro/collaboration-file-database-sqlite

English | [简体中文](./README.zh-CN.md)

A persistent SQLite `IFileDatabaseAdapter` for `@univerjs-pro/collaboration-file-service`, for single-node deployments. It uses the synchronous `libsql` API, supports Node.js 22 and later, and can share a database file with the core, History, Comment and Worktree SQLite Adapters.

## Installation and usage

```bash
pnpm add \
  @univerjs-pro/collaboration-file-service \
  @univerjs-pro/collaboration-file-database-sqlite
```

```ts
const database = new SQLiteFileDatabaseAdapter({
  filename: './data/collaboration.sqlite',
  busyTimeoutMs: 5_000,
});
const fileService = new UniverFileService({ database, blobStore });

await fileService.dispose();
await database.dispose();
```

The caller must create the database parent directory in advance and dispose the Adapter after stopping the Service. `busyTimeoutMs` defaults to 5000.

## Storage contract

- File metadata is stored in `collaboration_files`, one row per `fileID`; deleting a row always releases its `blobKey`.
- Schema version `('file', 1)` is stored in shared `collaboration_schema_versions`; `PRAGMA user_version` is not used.
- An empty database is initialized automatically. A file schema version other than 1 is rejected.
- `list` uses keyset pagination on `(created_at, file_id)`; cursors stay valid when earlier rows are deleted.
