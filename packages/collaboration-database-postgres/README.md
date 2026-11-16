# @univerjs-pro/collaboration-database-postgres

English | [简体中文](./README.zh-CN.md)

A PostgreSQL `IDatabaseAdapter` built on [node-postgres](https://node-postgres.com/). It serves a single node and several collaboration nodes sharing one database alike. Requires Node.js 22 or later and PostgreSQL 13 or later.

This Adapter keeps everything in PostgreSQL, including Sheet blocks, the cell data that makes up nearly all of a large workbook. [`@univerjs-pro/collaboration-database-postgres-s3`](../collaboration-database-postgres-s3/README.md) stores the blocks in an S3-compatible bucket and is the recommended Adapter where object storage is available; its README explains what blocks are and what moving them changes.

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
- `schema_versions` records `('core', 2)` and is shared by component with the other collaboration adapters. `create` opens a schema of this core version and leaves migration to an explicit step.

## Application metadata

`UnitRecord.metadata` and `ChangesetRecord.metadata` use `Record<string, unknown>` and must contain
JSON values. Creation stores `record.metadata`; `getUnit()` and `getChangesets()` return the saved values.
`commitChangeset()` requires complete `unitMetadata` and `changeset.metadata` and saves both atomically
with the new head. The Service prepares the metadata defaults and drafts before each commit.
Snapshot saves leave metadata unchanged.

## Migrations

Stop writers and back up the database using your PostgreSQL backup procedure. Before creating the
Adapter, pass the application-owned pool to `migratePostgresCore`:

```ts
import { migratePostgresCore } from '@univerjs-pro/collaboration-database-postgres';

const result = await migratePostgresCore({ pool });
// { from: 1, to: 2 }
```

The v1 to v2 upgrade initializes existing Unit and changeset metadata to `{}`. If the upgrade fails,
the transaction rolls back and you can retry. A current database returns `{ from: 2, to: 2 }`.
