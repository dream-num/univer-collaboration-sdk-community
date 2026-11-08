# @univerjs-pro/collaboration-file-database-postgres

[English](./README.md) | [简体中文](./README.zh-CN.md)

面向 `@univerjs-pro/collaboration-file-service` 的 Postgres `IFileDatabaseAdapter`，适用于单节点和多节点部署，
使用应用持有的 `pg.Pool`。

## 安装与使用

```bash
pnpm add \
  @univerjs-pro/collaboration-file-service \
  @univerjs-pro/collaboration-file-database-postgres \
  pg
```

```ts
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const database = await PostgresFileDatabaseAdapter.create({ pool });
const fileService = new UniverFileService({ database, blobStore });

await fileService.dispose();
await database.dispose();
await pool.end();
```

`pg` 是 peer dependency。`create()` 在返回 Adapter 之前校验或创建 schema。关闭 pool 由应用负责。

## 存储契约

- 文件元数据保存在 `collaboration.files`，每个 `fileID` 一行；删除一行时总会释放它的 `blobKey`。`collaboration` schema
  与其他协同适配器共用，不依赖 pool 的 `search_path`，角色只需要 database 上的 `CREATE` 权限。
- schema 版本 `('file', 1)` 记录在共享的 `collaboration.schema_versions`。多个节点或组件同时启动时只初始化一次：
  建表在事务中、持有 advisory lock 时执行。
- 空 schema 会自动初始化；版本不为 1 的 file schema 会被拒绝。
- `file_id` 使用 `"C"` collation，因此按 `(created_at, file_id)` 的 keyset 分页不受数据库 locale 影响。
