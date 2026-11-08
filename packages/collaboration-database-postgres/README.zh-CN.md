# @univerjs-pro/collaboration-database-postgres

[English](./README.md) | [简体中文](./README.zh-CN.md)

基于 [node-postgres](https://node-postgres.com/) 的 PostgreSQL `IDatabaseAdapter`，单节点部署和多个协同节点共用一个数据库都适用。要求 Node.js 22 及以上、PostgreSQL 13 及以上。

## 创建 Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-service \
  @univerjs-pro/collaboration-database-postgres \
  pg
```

连接池由应用持有。`create` 为空数据库初始化 schema，已有 schema 时只做校验：

```ts
import { PostgresDatabaseAdapter } from '@univerjs-pro/collaboration-database-postgres';
import { UniverCollabService } from '@univerjs-pro/collaboration-service';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const database = await PostgresDatabaseAdapter.create({ pool });
const service = new UniverCollabService({ dbAdapter: database });

await service.dispose();
await pool.end();
```

将 Adapter 作为 `dbAdapter` 传给 `UniverCollabService`。先释放 Service，再关闭连接池。

## PostgreSQL 行为

- 表位于 `collaboration` schema 中：`units`、`snapshots`、`changesets`、`sheet_blocks` 和
  `schema_versions`；协议对象以 MessagePack `BYTEA` 保存。
- `schema_versions` 记录 `('core', 1)`，按组件与其他协同 Adapter 共用。`create` 打开这个核心版本的 schema，迁移作为独立步骤显式执行。
