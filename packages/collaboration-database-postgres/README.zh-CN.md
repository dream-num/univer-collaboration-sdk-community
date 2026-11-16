# @univerjs-pro/collaboration-database-postgres

[English](./README.md) | [简体中文](./README.zh-CN.md)

基于 [node-postgres](https://node-postgres.com/) 的 PostgreSQL `IDatabaseAdapter`，单节点部署和多个协同节点共用一个数据库都适用。要求 Node.js 22 及以上、PostgreSQL 13 及以上。

这个 Adapter 把全部数据放在 PostgreSQL 中，包括 Sheet block，也就是占大型工作簿绝大部分体积的单元格数据。[`@univerjs-pro/collaboration-database-postgres-s3`](../collaboration-database-postgres-s3/README.zh-CN.md) 把 block 存放在 S3 兼容存储桶中，有对象存储时推荐使用；它的 README 说明了 block 是什么，以及外置之后的变化。

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
- `schema_versions` 记录 `('core', 2)`，按组件与其他协同 Adapter 共用。`create` 打开这个核心版本的 schema，迁移作为独立步骤显式执行。

## 应用元数据

`UnitRecord.metadata` 和 `ChangesetRecord.metadata` 使用 `Record<string, unknown>`，只接受 JSON 值。
创建时保存 `record.metadata`，通过 `getUnit()` 和 `getChangesets()` 读取已保存的值。
`commitChangeset()` 必须接收完整的 `unitMetadata` 和 `changeset.metadata`，并与新 head
原子保存。metadata 的默认值和草稿由 Service 在每次提交前统一准备。保存 snapshot 不修改 metadata。

## 迁移

停止写入，按部署环境的 PostgreSQL 备份流程备份数据库。在创建 Adapter 前，将应用的连接池传给
`migratePostgresCore`：

```ts
import { migratePostgresCore } from '@univerjs-pro/collaboration-database-postgres';

const result = await migratePostgresCore({ pool });
// { from: 1, to: 2 }
```

v1 升至 v2 时，已有 Unit 和 changeset 的 metadata 初始化为 `{}`。升级失败时事务回滚，修复原因后
可重试。已是当前版本时返回 `{ from: 2, to: 2 }`。
