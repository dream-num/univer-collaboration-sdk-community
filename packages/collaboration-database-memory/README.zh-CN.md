# @univerjs-pro/collaboration-database-memory

[English](./README.md) | [简体中文](./README.zh-CN.md)

进程内 `IDatabaseAdapter`，适合测试、本地开发和临时协同服务。

它也是 `IDatabaseAdapter` 契约最短的完整实现，可作为编写自有存储适配器的参考。

## 创建 Adapter

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

将 Adapter 作为 `dbAdapter` 传给 `UniverCollabService`。

它与 SQLite、PostgreSQL Adapter 遵守相同的协同持久化契约，包括 revision CAS、revisioned
snapshot、Sheet blocks 和原子 Unit 生命周期批次。提交幂等由 Service 从连续
changeset history 中判断，不由 Adapter 维护 submission 索引。

## 限制

- 进程退出后全部数据丢失。
- 多个 Node.js 进程之间不共享状态。
- 只适合测试和临时环境，不适合持久化生产数据。
