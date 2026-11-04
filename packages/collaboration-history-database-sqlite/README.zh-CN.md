# @univerjs-pro/collaboration-history-database-sqlite

[English](./README.md) | [简体中文](./README.zh-CN.md)

持久化 SQLite `IHistoryDatabaseAdapter`，使用稳定的 `libsql` 同步接口，支持 Node.js 22 及以上版本。

## 创建 Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-history-service \
  @univerjs-pro/collaboration-history-database-sqlite
```

调用方需要先创建数据库父目录：

```ts
import { mkdir } from 'node:fs/promises';
import { SQLiteHistoryDatabaseAdapter } from '@univerjs-pro/collaboration-history-database-sqlite';
import { UniverHistoryService } from '@univerjs-pro/collaboration-history-service';

await mkdir('./data', { recursive: true });

const database = new SQLiteHistoryDatabaseAdapter({
  filename: './data/collaboration.sqlite',
  busyTimeoutMs: 5_000,
});
const historyService = new UniverHistoryService({ collabService, dbAdapter: database });

await historyService.dispose();
await database.dispose();
```

将 Adapter 作为 `dbAdapter` 传给 `UniverHistoryService`。同一个文件可以同时承载核心、Comment 和
Worktree 的 SQLite 适配器。

## SQLite 行为

- 不主动修改 `journal_mode`；需要 WAL、checkpoint 或备份策略时由应用在打开前配置。
- 分段起点保存在 `collaboration_history_records` 表；changeset 本身由 History 从核心适配器读取。
- schema 版本以 `('history', 2)` 写入 `collaboration_schema_versions`，该表与其他 Univer 协同组件共用，
  不占用 `PRAGMA user_version`。
- 空库会自动初始化；版本不为 2 的 history schema 会被拒绝，见下文的迁移一节。

History 行独立于核心数据。核心的 hard delete 不会删除它们，需要时由应用自行清理。

## 迁移

每个版本只写入并打开一个 history schema 版本。打开旧库会报错并指向这里；打开数据库时从不自动迁移。

| History schema | 写入版本 |
| --- | --- |
| v1 | 1.0.0-rc |
| v2 | 1.0.0 及以后 |

先停止写入，共用文件时先用 `@univerjs-pro/collaboration-database-sqlite` 的 `migrateSQLiteCore`
迁移核心 schema，然后由 `migrateSQLiteHistory` 备份文件并补齐所有缺少的步骤：

```ts
import { migrateSQLiteHistory } from '@univerjs-pro/collaboration-history-database-sqlite';

const result = await migrateSQLiteHistory({ filename: './data/collaboration.sqlite' });
// { from: 1, to: 2, backupFilename: './data/collaboration.sqlite.history-v1.backup' }
```

备份是在任何改动之前写到数据库旁边的一致副本，可用 `backupFilename` 指定路径；已有的备份文件永远不会被
覆盖。已经是当前版本的数据库原样保留，也不会生成备份。

每一步在一个事务内完成。某一步失败时，文件停在上一个完整版本，备份仍然保留；再次调用
`migrateSQLiteHistory` 会从那里继续。

### v2 改变的数据

v1 保存每一个 revision，v2 只保留每个分段的起点及其作者、起始时间、origin 和附加字段。迁移要求
每个分段的起点都是一条有效记录，并且同文件的核心和 Worktree schema 已经迁移完成，因为它们的迁移
会从 v1 的 history 行读取创建信息。
