# @univerjs-pro/collaboration-comment-database-memory

[English](./README.md) | [简体中文](./README.zh-CN.md)

进程内 `ICommentDatabaseAdapter`，适合测试、本地开发和临时的 Thread Comment 服务。

## 创建 Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-comment-service \
  @univerjs-pro/collaboration-comment-database-memory
```

```ts
import { MemoryCommentDatabaseAdapter } from '@univerjs-pro/collaboration-comment-database-memory';
import { UniverCommentService } from '@univerjs-pro/collaboration-comment-service';

const database = new MemoryCommentDatabaseAdapter();
const commentService = new UniverCommentService({ database });

await commentService.dispose();
await database.dispose();
```

将 Adapter 作为 `database` 传给 `UniverCommentService`。

## 限制

- 进程退出后全部评论丢失。
- 多个 Node.js 进程之间不共享状态。
- 只适合测试和临时环境，不适合持久化生产数据。
