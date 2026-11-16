# @univerjs-pro/collaboration-database-postgres-s3

English | [简体中文](./README.zh-CN.md)

A PostgreSQL `IDatabaseAdapter` that stores Sheet blocks in an S3-compatible bucket. Units, changesets and snapshots stay in PostgreSQL; block contents are objects. Built on [node-postgres](https://node-postgres.com/) and the AWS SDK for JavaScript v3. Requires Node.js 22 or later and PostgreSQL 13 or later.

This is the recommended Adapter for PostgreSQL deployments. [`@univerjs-pro/collaboration-database-postgres`](../collaboration-database-postgres/README.md) keeps blocks in PostgreSQL as well and suits deployments without object storage.

## Sheet blocks

A Sheet snapshot has two parts:

- **The snapshot record** holds the workbook's structure: its sheets, metadata and resources.
- **Sheet blocks** hold the cell data. The cells of each sheet are split into blocks, and every block is saved and read on its own by ID.

Blocks are nearly all of a large workbook's bytes. The Service saves a snapshot every 50 revisions by default and reads blocks by ID.

## Why blocks belong in S3

Blocks are large, written once and read by key. That is what object storage is built for, while PostgreSQL pays for every byte of them in its write-ahead log, replicas and backups.

| | PostgreSQL | PostgreSQL + S3 |
| --- | --- | --- |
| Block contents | `BYTEA` rows | Objects |
| Database size | Includes all cell data | Excludes cell data |
| WAL, replication and backups | Carry every block | Carry block IDs |
| Infrastructure | PostgreSQL | PostgreSQL and a bucket |

- **A small database.** Units, changesets and snapshot records are what remain, so backups, restores and replicas stay fast as workbooks grow.
- **Large writes stay off the database.** Saving a large snapshot uploads objects; the write-ahead log and the replication stream carry only the IDs.
- **Storage that scales on its own.** Block capacity and cost follow the bucket, not the database disk.
- **The same contract.** The Adapter passes the same `IDatabaseAdapter` contract suite as the PostgreSQL Adapter.

## Create the Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-service \
  @univerjs-pro/collaboration-database-postgres-s3 \
  @aws-sdk/client-s3 \
  pg
```

The application owns the connection pool and the S3 client. `create` initializes the schema in an empty database and verifies an existing one:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { PostgresS3DatabaseAdapter } from '@univerjs-pro/collaboration-database-postgres-s3';
import { UniverCollabService } from '@univerjs-pro/collaboration-service';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = new S3Client({ region: process.env.S3_REGION });
const database = await PostgresS3DatabaseAdapter.create({
  pool,
  s3: { client, bucket: process.env.S3_BUCKET!, prefix: 'collaboration/blocks' },
});
const service = new UniverCollabService({ dbAdapter: database });

await service.dispose();
await pool.end();
client.destroy();
```

Pass the Adapter to `UniverCollabService` as `dbAdapter`. Dispose the Service first, then end the pool and destroy the client.

### `s3` options

| Option | Default | Description |
| --- | --- | --- |
| `client` | Required | `S3Client` used for every object request. |
| `bucket` | Required | Bucket that holds the blocks. |
| `prefix` | None | Key prefix, without a leading or trailing slash. |
| `concurrency` | `8` | Maximum object requests one Adapter call runs at a time, from 1 to 64. |

The credentials need `PutObject`, `GetObject`, `DeleteObject` and `ListBucket` on the bucket.

## Storage behavior

- Blocks are stored at `{prefix}/{unitID}/{blockID}`, with the Unit and block IDs percent-encoded, as MessagePack objects.
- Tables live in the `collaboration` schema: `units`, `snapshots`, `changesets`, `sheet_blocks` and `schema_versions`. `sheet_blocks` is a ledger with one row per block object a Unit has in the bucket, not the contents; `snapshots.block_ids` lists the blocks each snapshot references.
- `schema_versions` records `('core-s3', 1)`. `create` opens a schema of this version and rejects a database created by `@univerjs-pro/collaboration-database-postgres`.
- A block the Unit already stores is not uploaded again, so a snapshot uploads only the blocks that changed.
- Reading a block checks the ledger, then fetches the object.
- A block becomes readable only after its object is written and its snapshot is saved. A save that fails in between can leave objects nothing references; the next save of the same block overwrites them.
- Hard-deleting a Unit removes every object under its prefix after the database change commits. If that removal fails, the deletion still succeeds, the Unit's `sheet_blocks` rows stay as a record of the unfinished removal, and hard-deleting the Unit again retries it.
- Keep bucket versioning off, or add a lifecycle rule that expires noncurrent versions.

## Application metadata

`UnitRecord.metadata` and `ChangesetRecord.metadata` use `Record<string, unknown>` and must contain
JSON values. Creation stores `record.metadata`; `getUnit()` and `getChangesets()` return the saved values.
`commitChangeset()` requires complete `unitMetadata` and `changeset.metadata` and saves both atomically
with the new head. The Service prepares the metadata defaults and drafts before each commit.
Snapshot saves leave metadata unchanged.

## S3-compatible services

Configure the client for the service: its endpoint, region and addressing style. Some services reject the request checksums newer SDK versions add by default; set `requestChecksumCalculation` and `responseChecksumValidation` to `'WHEN_REQUIRED'` on the client for them.
