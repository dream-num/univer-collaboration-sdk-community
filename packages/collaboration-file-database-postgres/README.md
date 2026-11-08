# @univerjs-pro/collaboration-file-database-postgres

English | [简体中文](./README.zh-CN.md)

A Postgres `IFileDatabaseAdapter` for `@univerjs-pro/collaboration-file-service`. It works for single-node and multi-node deployments and uses a `pg.Pool` that the application owns.

## Installation and usage

```bash
pnpm add \
  @univerjs-pro/collaboration-file-service \
  @univerjs-pro/collaboration-file-database-postgres \
  pg
```

```ts
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const database = await PostgresFileDatabaseAdapter.create({ pool });
const fileService = new UniverFileService({ database, blobStore });

await fileService.dispose();
await database.dispose();
await pool.end();
```

`pg` is a peer dependency. `create()` validates or creates the schema before returning the Adapter. Ending the pool is the application's job.

## Storage contract

- File metadata is stored in `collaboration.files`, one row per `fileID`; deleting a row always releases its `blobKey`. The `collaboration` schema is shared with the other collaboration adapters, so the pool's `search_path` does not matter and the role only needs `CREATE` on the database.
- Schema version `('file', 1)` is stored in the shared `collaboration.schema_versions`. Nodes and components that start together initialize the schema once: creation runs in a transaction behind an advisory lock.
- An empty schema is initialized automatically. A file schema version other than 1 is rejected.
- `file_id` uses the `"C"` collation, so `list` keyset pagination on `(created_at, file_id)` does not depend on the database locale.
