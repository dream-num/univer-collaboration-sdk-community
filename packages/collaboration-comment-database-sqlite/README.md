# @univerjs-pro/collaboration-comment-database-sqlite

English | [简体中文](./README.zh-CN.md)

A persistent SQLite `ICommentDatabaseAdapter` using the stable synchronous `libsql` API. Requires Node.js 22 or later.

## Create the Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-comment-service \
  @univerjs-pro/collaboration-comment-database-sqlite
```

The caller must create the database parent directory first:

```ts
import { mkdir } from 'node:fs/promises';
import { SQLiteCommentDatabaseAdapter } from '@univerjs-pro/collaboration-comment-database-sqlite';
import { UniverCommentService } from '@univerjs-pro/collaboration-comment-service';

await mkdir('./data', { recursive: true });

const database = new SQLiteCommentDatabaseAdapter({
  filename: './data/collaboration.sqlite',
  busyTimeoutMs: 5_000,
});
const commentService = new UniverCommentService({ database });

await commentService.dispose();
await database.dispose();
```

Pass the Adapter to `UniverCommentService` as `database`. The same file can hold the core, History and Worktree SQLite adapters.

## SQLite behavior

- It does not change `journal_mode`; configure WAL, checkpointing, or backup policy before opening the Adapter when needed.
- Comments are stored in `collaboration_comments`.
- Schema version `('comment', 1)` is stored in `collaboration_schema_versions`, which other Univer collaboration components share; `PRAGMA user_version` is not used.
- An empty database is initialized automatically. A comment schema version other than 1 is rejected.

Comment rows are independent of core snapshots and changesets. A core hard delete does not remove comments; the application removes them when required.
