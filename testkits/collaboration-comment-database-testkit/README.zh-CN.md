# @univerjs-pro/collaboration-comment-database-testkit

[English](./README.md) | [简体中文](./README.zh-CN.md)

Univer Collaboration SDK `ICommentDatabaseAdapter` 实现的契约测试。
[univer-collaboration-sdk-community](https://github.com/dream-num/univer-collaboration-sdk-community)
中的每个适配器都通过这套测试，面向你自己存储的适配器也应当通过。

testkit 不发布到 npm，它是本仓库里的 private workspace 包：在这个 workspace 的包里用 `workspace:*` 依赖它，
或者把它的 `src/` 目录拷进你的项目。它基于 Vitest 运行。

```ts
import { commentDatabaseAdapterContract } from '@univerjs-pro/collaboration-comment-database-testkit';
import { MyCommentDatabaseAdapter } from './my-comment-database-adapter.js';

commentDatabaseAdapterContract('MyDatabase', async () => {
  const adapter = new MyCommentDatabaseAdapter(/* ... */);
  return { adapter, dispose: () => adapter.dispose() };
});
```

工厂在每个测试前运行一次，返回一个全新的空适配器。

## 契约要点

`@univerjs-pro/collaboration-comment-service` 的接口文档就是契约。以下是实现最常出错的地方：

- 根评论的 `replyID` 等于它的 `threadID`。`listThreads` 先返回根评论，再按创建顺序返回它们的回复；
  `threadIDs` 为空时列出整个 Unit，未知的 ID 被忽略。
- 只有线程处于打开状态时才接受回复和编辑，编辑必须来自作者本人。检查与写入在同一个原子边界内完成，
  因此并发的解决或删除不会放过过期的写入。
- 每条记录带有 `generation`，每次创建都是新值。`deleteComment` 只在传入当前 generation 时成功，
  删除根评论会移除整个线程。
- 返回的记录是副本：修改它们不会改变存储的数据。
