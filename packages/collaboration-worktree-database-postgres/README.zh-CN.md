# @univerjs-pro/collaboration-worktree-database-postgres

[English](./README.md) | 简体中文

为 Univer Worktree Service 提供 PostgreSQL 持久化。

```sh
pnpm add @univerjs-pro/collaboration-worktree-database-postgres @univerjs-pro/collaboration-worktree-service pg
```

示例中的 `collabService` 和 `trunkDatabase` 分别为已有的 trunk 协同 Service 及其数据库适配器。

```ts
import pg from 'pg';
import { PostgresWorktreeDatabaseAdapter } from '@univerjs-pro/collaboration-worktree-database-postgres';
import { UniverCollabWorktreeService } from '@univerjs-pro/collaboration-worktree-service';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const database = await PostgresWorktreeDatabaseAdapter.create({ pool });
const service = new UniverCollabWorktreeService({
  trunk: { service: collabService, dbAdapter: trunkDatabase },
  dbAdapter: database,
});

// During application shutdown
await service.dispose();
await database.dispose();
await pool.end();
```

应用负责关闭连接池。首次调用 `create()` 会初始化数据库结构，需要建表权限。后续调用会检查组件版本，遇到不支持的版本将报错。
