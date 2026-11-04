# @univerjs-pro/collaboration-comment-database-memory

English | [简体中文](./README.zh-CN.md)

An in-process `ICommentDatabaseAdapter` for tests, local development, and temporary Thread Comment
services.

## Create the Adapter

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

Pass the Adapter to `UniverCommentService` as `database`.

## Limitations

- All comments are lost when the process exits.
- State is not shared between Node.js processes.
- It is intended only for tests and temporary environments, not persistent production data.
