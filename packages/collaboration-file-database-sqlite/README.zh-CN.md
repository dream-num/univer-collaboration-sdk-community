# @univerjs-pro/collaboration-file-database-sqlite

[English](./README.md) | [简体中文](./README.zh-CN.md)

面向 `@univerjs-pro/collaboration-file-service` 的持久化 SQLite `IFileDatabaseAdapter`，用于单节点部署。
它使用 `libsql` 同步接口，支持 Node.js 22 及以上，并可与 core、History、Comment 和 Worktree SQLite Adapter
共用数据库文件。

## 安装与使用

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

调用方必须预先创建数据库父目录，并在 Service 停止后释放 Adapter。`busyTimeoutMs` 默认 5000。

## 存储契约

- 文件元数据保存在 `collaboration_files`，每个 `fileID` 一行；删除一行时总会释放它的 `blobKey`。
- schema 版本 `('file', 1)` 记录在共享的 `collaboration_schema_versions`，不占用 `PRAGMA user_version`。
- 空库会自动初始化；版本不为 1 的 file schema 会被拒绝。
- `list` 按 `(created_at, file_id)` 做 keyset 分页，前面的行被删除后游标仍然有效。
