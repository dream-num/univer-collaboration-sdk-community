# @univerjs-pro/collaboration-history-database-sqlite

English | [简体中文](./README.zh-CN.md)

A persistent SQLite `IHistoryDatabaseAdapter` using the stable synchronous `libsql` API. Requires Node.js 22 or later.

## Create the Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-history-service \
  @univerjs-pro/collaboration-history-database-sqlite
```

The caller must create the database parent directory first:

```ts
import { mkdir } from 'node:fs/promises';
import { SQLiteHistoryDatabaseAdapter } from '@univerjs-pro/collaboration-history-database-sqlite';
import { UniverHistoryService } from '@univerjs-pro/collaboration-history-service';

await mkdir('./data', { recursive: true });

const database = new SQLiteHistoryDatabaseAdapter({
  filename: './data/collaboration.sqlite',
  busyTimeoutMs: 5_000,
});
const historyService = new UniverHistoryService({ collabService, dbAdapter: database });

await historyService.dispose();
await database.dispose();
```

Pass the Adapter to `UniverHistoryService` as `dbAdapter`. The same file can hold the core, Comment and Worktree SQLite adapters.

## SQLite behavior

- It does not change `journal_mode`; configure WAL, checkpointing, or backup policy before opening the Adapter when needed.
- Segment boundaries are stored in `collaboration_history_records`; History reads the changesets themselves from the core adapter.
- Schema version `('history', 2)` is stored in `collaboration_schema_versions`, which other Univer collaboration components share; `PRAGMA user_version` is not used.
- An empty database is initialized automatically. A history schema version other than 2 is rejected; see Migrations.

History rows are independent of core data. A core hard delete does not remove them; the application removes them when required.

## Migrations

Each release writes one history schema version and opens only that version. Opening an older
database fails with an error that points here; migrations never run when the adapter opens a database.

| History schema | Written by |
| --- | --- |
| v1 | 1.0.0-rc |
| v2 | 1.0.0 and later |

Stop writers, migrate the core schema of a shared file first with `migrateSQLiteCore` from
`@univerjs-pro/collaboration-database-sqlite`, then let `migrateSQLiteHistory` back up the file and
apply every missing step:

```ts
import { migrateSQLiteHistory } from '@univerjs-pro/collaboration-history-database-sqlite';

const result = await migrateSQLiteHistory({ filename: './data/collaboration.sqlite' });
// { from: 1, to: 2, backupFilename: './data/collaboration.sqlite.history-v1.backup' }
```

The backup is a consistent copy written next to the database before anything changes; pass
`backupFilename` to choose its path. An existing backup file is never overwritten. A database that
already has the current version is left alone and gets no backup.

Each step runs in one transaction. If a step fails, the file stays at the last complete version and
the backup stays in place; calling `migrateSQLiteHistory` again continues from there.

### Data changed in v2

V1 stored every revision; v2 keeps only the boundary of each segment with its author, start time,
origin and additional fields. The migration requires that every segment starts at a stored revision
with valid facts, and that the core and Worktree schemas of the same file are already migrated,
because their migrations read creation facts from the v1 history rows.
