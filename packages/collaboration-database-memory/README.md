# @univerjs-pro/collaboration-database-memory

English | [简体中文](./README.zh-CN.md)

An in-process `IDatabaseAdapter` for tests, local development, and temporary collaboration services.

It is also the shortest complete implementation of the `IDatabaseAdapter` contract, so it doubles
as a reference when you write an adapter for your own storage.

## Create the Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-service \
  @univerjs-pro/collaboration-database-memory
```

```ts
import { MemoryDatabaseAdapter } from '@univerjs-pro/collaboration-database-memory';
import { UniverCollabService } from '@univerjs-pro/collaboration-service';

const database = new MemoryDatabaseAdapter();
const service = new UniverCollabService({ dbAdapter: database });

await service.dispose();
await database.dispose();
```

Pass the Adapter to `UniverCollabService` as `dbAdapter`.

It follows the same collaboration persistence contract as the SQLite and PostgreSQL Adapters, including revision CAS, revisioned snapshots, Sheet blocks, and atomic Unit lifecycle batches. Submission idempotency is resolved by the Service from continuous changeset history, not by the Adapter.

## Limitations

- All data is lost when the process exits.
- State is not shared between Node.js processes.
- It is intended only for tests and temporary environments, not persistent production data.
