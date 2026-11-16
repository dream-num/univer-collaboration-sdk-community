# @univerjs-pro/collaboration-history-database-postgres

English | [简体中文](./README.zh-CN.md)

PostgreSQL persistence for the Univer History Service.

```sh
pnpm add @univerjs-pro/collaboration-history-database-postgres @univerjs-pro/collaboration-history-service pg
```

```ts
import pg from 'pg';
import { PostgresHistoryDatabaseAdapter } from '@univerjs-pro/collaboration-history-database-postgres';
import { UniverHistoryService } from '@univerjs-pro/collaboration-history-service';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const database = await PostgresHistoryDatabaseAdapter.create({ pool });
const service = new UniverHistoryService({ collabService, dbAdapter: database });

// During application shutdown
await service.dispose();
await database.dispose();
await pool.end();
```

The application owns the pool. The first call to `create()` needs permission to create the schema and tables. Subsequent calls check the component version and reject unsupported versions.
