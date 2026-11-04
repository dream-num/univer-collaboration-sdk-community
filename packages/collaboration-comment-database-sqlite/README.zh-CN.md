# @univerjs-pro/collaboration-comment-database-sqlite

[English](./README.md) | [简体中文](./README.zh-CN.md)

持久化 SQLite `ICommentDatabaseAdapter`，使用稳定的 `libsql` 同步接口，支持 Node.js 22 及以上版本。

## 创建 Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-comment-service \
  @univerjs-pro/collaboration-comment-database-sqlite
```

调用方需要先创建数据库父目录：

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

将 Adapter 作为 `database` 传给 `UniverCommentService`。同一个文件可以同时承载核心、History 和
Worktree 的 SQLite 适配器。

## SQLite 行为

- 不主动修改 `journal_mode`；需要 WAL、checkpoint 或备份策略时由应用在打开前配置。
- 评论保存在 `collaboration_comments` 表。
- schema 版本以 `('comment', 1)` 写入 `collaboration_schema_versions`，该表与其他 Univer 协同组件共用，
  不占用 `PRAGMA user_version`。
- 空库会自动初始化；版本不为 1 的 comment schema 会被拒绝。

评论行独立于核心的 snapshot 和 changeset。核心的 hard delete 不会删除评论，需要时由应用自行清理。
