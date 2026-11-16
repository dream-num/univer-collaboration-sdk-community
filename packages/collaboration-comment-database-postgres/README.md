# @univerjs-pro/collaboration-comment-database-postgres

English | [简体中文](./README.zh-CN.md)

PostgreSQL persistence for the Univer Comment Service.

```sh
pnpm add @univerjs-pro/collaboration-comment-database-postgres @univerjs-pro/collaboration-comment-service pg
```

```ts
import pg from 'pg';
import { PostgresCommentDatabaseAdapter } from '@univerjs-pro/collaboration-comment-database-postgres';
import { UniverCommentService } from '@univerjs-pro/collaboration-comment-service';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const database = await PostgresCommentDatabaseAdapter.create({ pool });
const service = new UniverCommentService({ database });

// During application shutdown
await service.dispose();
await database.dispose();
await pool.end();
```

The application owns the pool. The first call to `create()` needs permission to create the schema and tables. Subsequent calls check the component version and reject unsupported versions.
