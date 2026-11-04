# @univerjs-pro/collaboration-database-postgres

[English](./README.md) | [简体中文](./README.zh-CN.md)

基于 [node-postgres](https://node-postgres.com/) 的 PostgreSQL `IDatabaseAdapter`。所有写入判定都由
PostgreSQL 完成，因此多个服务节点可以共用一个数据库。支持 Node.js 22 及以上、PostgreSQL 13 及以上版本。


## 创建 Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-service \
  @univerjs-pro/collaboration-database-postgres \
  pg
```

连接池由应用持有。`create` 首次使用时初始化 schema，之后每次校验：

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

将 Adapter 作为 `dbAdapter` 传给 `UniverCollabService`。关闭连接池由应用负责。

## PostgreSQL 行为

- 表位于 `collaboration` schema 中：`units`、`snapshots`、`changesets`、`sheet_blocks` 和
  `schema_versions`；协议对象以 MessagePack `BYTEA` 保存。
- schema 版本以 `('core', 1)` 写入 `schema_versions`；核心版本不同的 schema 会被拒绝，迁移始终显式执行。
- Adapter 不创建数据库、角色或扩展。
