# @univerjs-pro/collaboration-worktree-database-memory

[English](./README.md) | [简体中文](./README.zh-CN.md)

进程内 `IWorktreeDatabaseAdapter`，适合测试、本地开发和临时 Worktree 数据。

## 安装与使用

```bash
pnpm add \
  @univerjs-pro/collaboration-worktree-service \
  @univerjs-pro/collaboration-worktree-database-memory
```

```ts
const worktreeDatabase = new MemoryWorktreeDatabaseAdapter();
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

## 存储契约

它实现 Worktree 状态转换、draft revision CAS 和逐 Unit merge result 契约。draft 提交
幂等由 Worktree Service 从连续 history 中判断。

`setUnitRemoved` 原子更新可恢复的 draft 移除标记。已移除 Unit 拒绝 draft 提交；
移除操作合入 trunk 后不能再恢复。

Draft Unit 记录包含应用 `metadata`；已确认的 draft changeset 使用带独立 `metadata` 的
`ChangesetRecord`。`commitDraftChangeset` 要求 Service 提供完整的 `unitMetadata` 和
`changeset.metadata` 对象，并将两者与 draft head 原子保存。

## 限制

进程退出后所有 Worktree 数据丢失，多个 Node.js 进程之间也不共享状态。持久化生产数据
应使用 SQLite 或其他持久化 Adapter。
