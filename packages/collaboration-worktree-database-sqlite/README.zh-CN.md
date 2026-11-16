# @univerjs-pro/collaboration-worktree-database-sqlite

[English](./README.md) | [简体中文](./README.zh-CN.md)

面向 `@univerjs-pro/collaboration-worktree-service` 的持久化 SQLite
`IWorktreeDatabaseAdapter`。它使用稳定的 `libsql` 同步接口，支持 Node.js 22 及以上。

## 安装与使用

```bash
pnpm add \
  @univerjs-pro/collaboration-worktree-service \
  @univerjs-pro/collaboration-worktree-database-sqlite
```

```ts
const worktreeDatabase = new SQLiteWorktreeDatabaseAdapter({
  filename: './data/collaboration.sqlite',
  busyTimeoutMs: 5_000,
});
const worktreeService = new UniverCollabWorktreeService({
  trunk: {
    service: collabService,
    dbAdapter: trunkDatabase,
  },
  dbAdapter: worktreeDatabase,
});

await worktreeService.dispose();
await worktreeDatabase.dispose();
```

调用方必须预先创建数据库父目录，并在 Worktree Service 停止后释放 Adapter。

## 存储契约

- 表使用 `collaboration_worktree_*` 前缀。
- schema 版本 `('worktree', 4)` 记录在共享的
  `collaboration_schema_versions`，不占用 `PRAGMA user_version`。
- draft changeset 标量列和 submission unique constraint 提供数据库级完整性；提交只做
  revision CAS，不按 submission key 点查。
- 可以与 trunk、Comment 和 History SQLite Adapter 共用一个数据库文件。
- 状态转换、draft CAS 和 merge result 使用 SQLite transaction 保证原子契约。
- 空 Worktree schema 自动初始化；不完整或不支持的 schema 会被拒绝。

Draft Unit 记录包含应用 `metadata`；draft `ChangesetRecord` 包含独立的 metadata。
`commitDraftChangeset` 要求 Service 提供完整的 `unitMetadata` 和 `changeset.metadata`
对象，并将两者与 draft head 原子保存。

Worktree Adapter 不拥有 trunk 协同数据，也不替应用管理 Worktree 名称、列表发现、ACL 或
产品资源关系。

## 显式迁移

停写后，在构造 Adapter 前调用 `migrateSQLiteWorktree`。同一文件中还有 History v1 时，
先迁移 Worktree，再迁移 History，以便读取原有创建信息。

```ts
import { migrateSQLiteWorktree } from '@univerjs-pro/collaboration-worktree-database-sqlite';

const result = await migrateSQLiteWorktree({ filename: './data/collaboration.sqlite' });
// { from: 1, to: 4, backupFilename: './data/collaboration.sqlite.worktree-v1.backup' }
```

函数先将整个数据库备份到 `<filename>.worktree-v<from>.backup`，可用 `backupFilename`
指定其他路径。目标文件必须尚未存在。每一步独立提交，失败后可在修复原因后从最后一个完整版本继续。
重试时若目标备份已存在，可另选备份路径。已是当前版本时返回 `{ from: 4, to: 4 }`，跳过备份。

v4 为 Unit 和 changeset 增加 metadata，已有记录初始化为 `{}`。

### v3 的创建信息

v3 为 `collaboration_worktree_units` 新增必填的 `creator_id`（创建者）和
`created_at_ms`（创建时间，Unix 毫秒），为 `collaboration_worktree_changesets` 新增必填的
`created_at_ms`（提交时间，Unix 毫秒）。

从 trunk 加入的 Unit 默认使用同一数据库中 History revision 1 的创建信息。
Draft changeset 时间使用其 payload 的 `createTime`（秒）。信息缺失或非法时使用
`anonymous` 和本次迁移开始时间；trunk History 不能用于识别 draft revision。

可选异步回调 `resolveUnitCreation(worktreeID, unitID)` 和
`resolveChangesetCreatedAt(worktreeID, unitID, revision)` 可覆盖默认策略，
分别返回 `{ creatorID, createdAt }` 和时间值，时间均为 Unix 毫秒。
回调也包含 removed Unit，不得写入同一数据库；返回非法值或抛出异常会使 v2 → v3 这一步回滚。
