# @univerjs-pro/collaboration-worktree-database-testkit

English | [简体中文](./README.zh-CN.md)

Vitest contract tests for implementations of `IWorktreeDatabaseAdapter`. The Memory, SQLite and PostgreSQL
Worktree adapters run this suite. To test your own adapter in this workspace, add the testkit
as a `workspace:*` development dependency. Its source is distributed with the community
repository as a private workspace package.

Provide a factory that returns a fresh, empty adapter for each test. The suite awaits the
optional `dispose` hook after each test.

```ts
import { worktreeDatabaseAdapterContract } from '@univerjs-pro/collaboration-worktree-database-testkit';
import { MyWorktreeDatabaseAdapter } from './my-worktree-database-adapter.js';

worktreeDatabaseAdapterContract('MyWorktreeDatabaseAdapter', () => {
  const adapter = new MyWorktreeDatabaseAdapter();
  return { adapter, dispose: () => adapter.dispose() };
});
```
