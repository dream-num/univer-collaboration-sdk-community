# @univerjs-pro/collaboration-database-sqlite

English | [简体中文](./README.zh-CN.md)

A persistent SQLite `IDatabaseAdapter` using the stable synchronous `libsql` API. Requires Node.js 22 or later.


## Create the Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-service \
  @univerjs-pro/collaboration-database-sqlite
```

The caller must create the database parent directory first:

```ts
import { mkdir } from 'node:fs/promises';
import { SQLiteDatabaseAdapter } from '@univerjs-pro/collaboration-database-sqlite';
import { UniverCollabService } from '@univerjs-pro/collaboration-service';

await mkdir('./data', { recursive: true });

const database = new SQLiteDatabaseAdapter({
  filename: './data/collaboration.sqlite',
  busyTimeoutMs: 5_000,
});
const service = new UniverCollabService({ dbAdapter: database });

await service.dispose();
await database.dispose();
```

Pass the Adapter to `UniverCollabService` as `dbAdapter`.

## SQLite behavior

- It does not change `journal_mode`; configure WAL, checkpointing, or backup policy before opening the Adapter when needed.
- Core tables use the `collaboration_` prefix. Protocol objects are stored as MessagePack `BLOB` payloads.
- Schema version `('core', 3)` is stored in `collaboration_schema_versions`, which other Univer collaboration components share; `PRAGMA user_version` is not used.
- Changeset scalar columns and the submission unique constraint provide database-level integrity, while commits use revision CAS and do not query the submission key.
- An empty database is initialized automatically. A core schema version other than 3 is rejected; see Migrations.

This implementation suits local applications and small-to-medium single-Node deployments.

## Migrations

Each release writes one core schema version and opens only that version. Opening an older database
fails with an error that points here; migrations never run when the adapter opens a database.

| Core schema | Written by |
| --- | --- |
| v1 | 1.0.0-rc |
| v2 | 1.0.0 to 1.3.x |
| v3 | this release |

Stop writers, then let `migrateSQLiteCore` back up the file and apply every missing step:

```ts
import { migrateSQLiteCore } from '@univerjs-pro/collaboration-database-sqlite';

const result = await migrateSQLiteCore({ filename: './data/collaboration.sqlite' });
// { from: 2, to: 3, backupFilename: './data/collaboration.sqlite.v2.backup' }
```

The backup is a consistent copy written next to the database before anything changes; pass
`backupFilename` to choose its path. An existing backup file is never overwritten. A database that
already has the current version is left alone and gets no backup.

Each step runs in one transaction. If a step fails, the file stays at the last complete version and
the backup stays in place; calling `migrateSQLiteCore` again continues from there. Tables of other
Univer components and application objects that reference the core tables are kept.

### Data added in v2

V2 added the creator and creation time of every Unit and the commit time of every changeset. A v1
database fills them using these rules:

- Unit creator and creation time: revision 1's `user_id` and `committed_at` in
  `collaboration_history_revisions` in the same database.
- Changeset time: payload `createTime` (seconds), then the matching History revision's `committed_at`
  (milliseconds).
- Otherwise `anonymous` for the creator and the migration start time for timestamps. These fallback
  values do not represent historical facts.

Optional `resolveUnitCreation(unitID)` and `resolveChangesetCreatedAt(unitID, revision)` options
replace the defaults. They may be async and return `{ creatorID, createdAt }` and a timestamp in Unix
milliseconds. They cover soft-deleted Units too and must not write to the same database. Invalid
results or exceptions roll back the step.

### Data changed in v3

V3 stores protocol objects as MessagePack `BLOB` payloads instead of JSON text, records deletion in
`collaboration_units` as `deleted_status` and `deleted_at_ms`, and drops the tombstone table and the
explicit indexes. Each v2 tombstone becomes a hard-delete marker row that keeps its Unit ID reserved;
the marker carries placeholder values (Sheet type, revision 1, creator `anonymous`, purge time as
creation time) and is never returned by reads.
