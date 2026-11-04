# @univerjs-pro/collaboration-history-database-memory

[English](./README.md) | [简体中文](./README.zh-CN.md)

进程内 `IHistoryDatabaseAdapter`，适合测试、本地开发和临时的 History 服务。

## 创建 Adapter

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

将 Adapter 作为 `dbAdapter` 传给 `UniverHistoryService`。

## 限制

- 进程退出后全部分段记录丢失。
- 多个 Node.js 进程之间不共享状态。
- 只适合测试和临时环境，不适合持久化生产数据。
