# @univerjs-pro/collaboration-worktree-database-postgres

English | [简体中文](./README.zh-CN.md)

PostgreSQL persistence for the Univer Worktree Service.

```sh
pnpm add @univerjs-pro/collaboration-worktree-database-postgres @univerjs-pro/collaboration-worktree-service pg
```

Use your existing trunk collaboration service and its database adapter as `collabService` and `trunkDatabase`.

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

The application owns the pool. The first call to `create()` needs permission to create the schema and tables. Subsequent calls check the component version and reject unsupported versions.
