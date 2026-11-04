# @univerjs-pro/collaboration-database-sqlite

[English](./README.md) | [简体中文](./README.zh-CN.md)

持久化 SQLite `IDatabaseAdapter`，使用稳定的 `libsql` 同步接口，支持 Node.js 22
及以上版本。


## 创建 Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-service \
  @univerjs-pro/collaboration-database-sqlite
```

调用方需要先创建数据库父目录：

```ts
import { mkdir } from 'node:fs/promises';
import { SQLiteDatabaseAdapter } from '@univerjs-pro/collaboration-database-sqlite';
import { UniverCollabService } from '@univerjs-pro/collaboration-service';

await mkdir('./data', { recursive: true });

const database = new SQLiteDatabaseAdapter({
  filename: './data/collaboration.sqlite',
  busyTimeoutMs: 5_000,
});
const service = new UniverCollabService({ dbAdapter: database });

await service.dispose();
await database.dispose();
```

将 Adapter 作为 `dbAdapter` 传给 `UniverCollabService`。

## SQLite 行为

- 不主动修改 `journal_mode`；需要 WAL、checkpoint 或备份策略时由应用在打开前配置。
- 核心表使用 `collaboration_` 前缀；协议对象以 MessagePack `BLOB` 保存。
- schema 版本以 `('core', 3)` 写入 `collaboration_schema_versions`，该表与其他 Univer 协同
  组件共用，不占用 `PRAGMA user_version`。
- changeset 标量列和 submission unique constraint 提供数据库级完整性；提交只做 revision
  CAS，不按 submission key 点查。
- 空库会自动初始化；版本不为 3 的核心 schema 会被拒绝，见下文的迁移一节。

本实现适合本地应用和中小规模单 Node 部署。

## 迁移

每个版本只写入并打开一个核心 schema 版本。打开旧库会报错并指向这里；打开数据库时从不自动迁移。

| 核心 schema | 写入版本 |
| --- | --- |
| v1 | 1.0.0-rc |
| v2 | 1.0.0 至 1.3.x |
| v3 | 本版本 |

先停止写入，然后由 `migrateSQLiteCore` 备份文件并补齐所有缺少的步骤：

```ts
import { migrateSQLiteCore } from '@univerjs-pro/collaboration-database-sqlite';

const result = await migrateSQLiteCore({ filename: './data/collaboration.sqlite' });
// { from: 2, to: 3, backupFilename: './data/collaboration.sqlite.v2.backup' }
```

备份是在任何改动之前写到数据库旁边的一致副本，可用 `backupFilename` 指定路径；已有的备份文件永远不会被
覆盖。已经是当前版本的数据库原样保留，也不会生成备份。

每一步在一个事务内完成。某一步失败时，文件停在上一个完整版本，备份仍然保留；再次调用
`migrateSQLiteCore` 会从那里继续。其他 Univer 组件的表以及引用核心表的应用对象都会保留。

### v2 新增的数据

v2 增加了每个 Unit 的创建者和创建时间，以及每个 changeset 的提交时间。v1 数据库按以下规则补全：

- Unit 创建者和创建时间：同一数据库 `collaboration_history_revisions` 中 revision 1 的 `user_id`
  和 `committed_at`。
- changeset 时间：payload 的 `createTime`（秒），其次是对应 History revision 的 `committed_at`（毫秒）。
- 其余情况创建者为 `anonymous`，时间为迁移开始时刻。这些兜底值不代表历史事实。

可选项 `resolveUnitCreation(unitID)` 和 `resolveChangesetCreatedAt(unitID, revision)` 替代默认规则。
它们可以是异步的，分别返回 `{ creatorID, createdAt }` 和 Unix 毫秒时间戳；软删除的 Unit 同样会调用，
并且不能写同一数据库。结果无效或抛错会回滚这一步。

### v3 改变的数据

v3 以 MessagePack `BLOB` 保存协议对象而不再是 JSON 文本，删除状态记录在 `collaboration_units` 的
`deleted_status` 与 `deleted_at_ms` 中，并移除 tombstone 表和显式索引。每条 v2 tombstone 变成一行
hard delete 标记，继续占住该 Unit ID；标记行使用占位值（Sheet 类型、revision 1、创建者 `anonymous`、
清除时间作为创建时间），读取接口永远不会返回它。
