# @univerjs-pro/collaboration-database-postgres

English | [简体中文](./README.zh-CN.md)

A PostgreSQL `IDatabaseAdapter` built on [node-postgres](https://node-postgres.com/). Every write decision is made by PostgreSQL, so several service nodes can share one database. Requires Node.js 22 or later and PostgreSQL 13 or later.


## Create the Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-service \
  @univerjs-pro/collaboration-database-postgres \
  pg
```

The application owns the connection pool. `create` initializes the schema on first use and verifies it afterwards:

```ts
import { PostgresDatabaseAdapter } from '@univerjs-pro/collaboration-database-postgres';
import { UniverCollabService } from '@univerjs-pro/collaboration-service';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const database = await PostgresDatabaseAdapter.create({ pool });
const service = new UniverCollabService({ dbAdapter: database });

await service.dispose();
await pool.end();
```

Pass the Adapter to `UniverCollabService` as `dbAdapter`. Ending the pool is the application's job.

## PostgreSQL behavior

- Tables live in the `collaboration` schema: `units`, `snapshots`, `changesets`, `sheet_blocks` and `schema_versions`. Protocol objects are stored as MessagePack `BYTEA` payloads.
- Schema version `('core', 1)` is stored in `schema_versions`. A schema with a different core version is rejected; migration is always explicit.
- The adapter does not create the database, roles or extensions.
