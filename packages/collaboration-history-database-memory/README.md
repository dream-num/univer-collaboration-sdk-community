# @univerjs-pro/collaboration-history-database-memory

English | [简体中文](./README.zh-CN.md)

An in-process `IHistoryDatabaseAdapter` for tests, local development, and temporary History
services.

## Create the Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-history-service \
  @univerjs-pro/collaboration-history-database-memory
```

```ts
import { MemoryHistoryDatabaseAdapter } from '@univerjs-pro/collaboration-history-database-memory';
import { UniverHistoryService } from '@univerjs-pro/collaboration-history-service';

const database = new MemoryHistoryDatabaseAdapter();
const historyService = new UniverHistoryService({ collabService, dbAdapter: database });

await historyService.dispose();
await database.dispose();
```

Pass the Adapter to `UniverHistoryService` as `dbAdapter`.

## Limitations

- All segment boundaries are lost when the process exits.
- State is not shared between Node.js processes.
- It is intended only for tests and temporary environments, not persistent production data.
