# @univerjs-pro/collaboration-history-database-postgres

[English](./README.md) | 简体中文

为 Univer History Service 提供 PostgreSQL 持久化。

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

应用负责关闭连接池。首次调用 `create()` 会初始化数据库结构，需要建表权限。后续调用会检查组件版本，遇到不支持的版本将报错。
