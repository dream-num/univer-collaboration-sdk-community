# @univerjs-pro/collaboration-worktree-database-testkit

[English](./README.md) | 简体中文

这套 Vitest 契约测试用于验证 `IWorktreeDatabaseAdapter` 的实现，Worktree 的 Memory、SQLite 和 PostgreSQL
适配器都运行这套测试。在此 workspace 中测试自定义适配器时，将 testkit 加为 `workspace:*`
开发依赖即可。testkit 以 private workspace 包随社区仓库分发源码。

为每个测试提供一个返回全新空适配器的工厂。测试结束后，测试套件会等待可选的 `dispose` 完成。

```ts
import { worktreeDatabaseAdapterContract } from '@univerjs-pro/collaboration-worktree-database-testkit';
import { MyWorktreeDatabaseAdapter } from './my-worktree-database-adapter.js';

worktreeDatabaseAdapterContract('MyWorktreeDatabaseAdapter', () => {
  const adapter = new MyWorktreeDatabaseAdapter();
  return { adapter, dispose: () => adapter.dispose() };
});
```
