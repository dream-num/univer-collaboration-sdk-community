# @univerjs-pro/collaboration-database-postgres

English | [简体中文](./README.zh-CN.md)

A PostgreSQL `IDatabaseAdapter` built on [node-postgres](https://node-postgres.com/). It serves a single node and several collaboration nodes sharing one database alike. Requires Node.js 22 or later and PostgreSQL 13 or later.

## Create the Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-service \
  @univerjs-pro/collaboration-database-postgres \
  pg
```

The application owns the connection pool. `create` initializes the schema in an empty database and verifies an existing one:

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

Pass the Adapter to `UniverCollabService` as `dbAdapter`. Dispose the Service first, then end the pool.

## PostgreSQL behavior

- Tables live in the `collaboration` schema: `units`, `snapshots`, `changesets`, `sheet_blocks` and `schema_versions`. Protocol objects are stored as MessagePack `BYTEA` payloads.
- `schema_versions` records `('core', 1)` and is shared by component with the other collaboration adapters. `create` opens a schema of this core version and leaves migration to an explicit step.
