# @univerjs-pro/collaboration-worktree-database-sqlite

English | [简体中文](./README.zh-CN.md)

A persistent SQLite `IWorktreeDatabaseAdapter` for `@univerjs-pro/collaboration-worktree-service`. It uses the stable synchronous `libsql` API and supports Node.js 22 and later.

## Installation and usage

```bash
pnpm add \
  @univerjs-pro/collaboration-worktree-service \
  @univerjs-pro/collaboration-worktree-database-sqlite
```

```ts
const worktreeDatabase = new SQLiteWorktreeDatabaseAdapter({
  filename: './data/collaboration.sqlite',
  busyTimeoutMs: 5_000,
});
const worktreeService = new UniverCollabWorktreeService({
  trunk: {
    service: collabService,
    dbAdapter: trunkDatabase,
  },
  dbAdapter: worktreeDatabase,
});

await worktreeService.dispose();
await worktreeDatabase.dispose();
```

The caller must create the database parent directory in advance and dispose the Adapter after stopping Worktree Service.

## Storage contract

- Tables use the `collaboration_worktree_*` prefix.
- Schema version `('worktree', 4)` is stored in shared `collaboration_schema_versions`; `PRAGMA user_version` is not used.
- Draft-changeset scalar columns and the submission unique constraint provide database-level integrity, while commits use revision CAS and do not query the submission key.
- It can share a database file with trunk, Comment, and History SQLite Adapters.
- State transitions, draft CAS, and merge results use SQLite transactions for atomicity.
- An empty Worktree schema is initialized automatically. Incomplete or unsupported schemas are rejected.

Draft Unit records contain application `metadata`; draft `ChangesetRecord` values include their own
metadata. `commitDraftChangeset` requires complete `unitMetadata` and `changeset.metadata` objects
from the Service and saves both with the draft head atomically.

Worktree Adapter does not own trunk collaboration data and does not manage Worktree names, list discovery, ACLs, or product-resource relationships for the application.

## Explicit migrations

Stop writers, then call `migrateSQLiteWorktree` before constructing the Adapter. If the file also
contains History v1, upgrade Worktree before History so the migration can read the original creation facts.

```ts
import { migrateSQLiteWorktree } from '@univerjs-pro/collaboration-worktree-database-sqlite';

const result = await migrateSQLiteWorktree({ filename: './data/collaboration.sqlite' });
// { from: 1, to: 4, backupFilename: './data/collaboration.sqlite.worktree-v1.backup' }
```

The function backs up the whole database to `<filename>.worktree-v<from>.backup` before the first
step. Use `backupFilename` to choose another path. The destination must be a new file.
Each successful step commits independently. After a failure, fix the cause and rerun from the last
committed version, choosing a new backup path if the previous backup already occupies the destination.
A current database returns `{ from: 4, to: 4 }` without creating a backup.

V4 adds metadata to Units and changesets, initializing existing records to `{}`.

### Creation facts in v3

V3 adds required `creator_id` (creator) and `created_at_ms` (creation time, Unix milliseconds)
to `collaboration_worktree_units`, and required `created_at_ms` (commit time, Unix milliseconds)
to `collaboration_worktree_changesets`.

For trunk-sourced Units, creation facts default to revision 1 in History in the same database.
Draft changeset times use their payload `createTime` (seconds). Missing or invalid information
falls back to `anonymous` and the migration start time. Trunk History cannot identify draft revisions.

Optional async `resolveUnitCreation(worktreeID, unitID)` and
`resolveChangesetCreatedAt(worktreeID, unitID, revision)` callbacks replace these defaults,
returning `{ creatorID, createdAt }` and a timestamp, respectively, using Unix milliseconds.
Callbacks cover removed Units too and must not write to the same database.
Invalid callback results or exceptions roll back the v2 to v3 step.
