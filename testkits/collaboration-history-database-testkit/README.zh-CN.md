# @univerjs-pro/collaboration-history-database-testkit

[English](./README.md) | [简体中文](./README.zh-CN.md)

Univer Collaboration SDK `IHistoryDatabaseAdapter` 实现的契约测试与夹具。
[univer-collaboration-sdk-community](https://github.com/dream-num/univer-collaboration-sdk-community)
中的每个适配器都通过这套测试，面向你自己存储的适配器也应当通过。

testkit 不发布到 npm，它是本仓库里的 private workspace 包：在这个 workspace 的包里用 `workspace:*` 依赖它，
或者把它的 `src/` 目录拷进你的项目。它基于 Vitest 运行。

```ts
import { historyDatabaseAdapterContract } from '@univerjs-pro/collaboration-history-database-testkit';
import { MyHistoryDatabaseAdapter } from './my-history-database-adapter.js';

historyDatabaseAdapterContract('MyDatabase', async () => {
  const adapter = new MyHistoryDatabaseAdapter(/* ... */);
  return { adapter, dispose: () => adapter.dispose() };
});
```

工厂在每个测试前运行一次，返回一个全新的空适配器。`createHistoryRecord` 与
`createHistoryDatabaseContext` 为你自己的测试构造合法的输入。

## 契约要点

`@univerjs-pro/collaboration-history-service` 的接口文档就是契约。以下是实现最常出错的地方：

- 一条记录是分段边界，不是 changeset 的副本。`appendRecord` 把 Unit 最新的起始 revision 与
  `expectedLatestStartRevision` 比较，只在二者相等且新的起始 revision 更大时追加。在已存在的起始
  revision 上追加完全相同的记录返回 `already-exists`，其他记录返回 `conflict`。
- `unitID` 或 `userID` 为空、起始 revision 小于 1、或者值不是整数或为负的记录以 `TypeError` 失败，
  数据库保持不变。
- `listRecords` 按最新优先返回不超过 `min(throughRevision, beforeRevision - 1)` 的边界。`origin`
  （不为 0 时）和 `userIDs` 过滤本页，而每条记录的 `endRevision` 来自 Unit 的下一个边界，与过滤无关，
  并以 `throughRevision` 为上限。`hasMore` 报告是否还有下一页。
- `origin` 作为不透明整数存储和比较；0 或省略表示不过滤。
- `listCreators` 返回不超过 `throughRevision` 的边界的作者，按用户 ID 排序，每个作者带有它用过的
  origin 的有序集合。
- 返回的记录是副本：修改它们不会改变存储的数据。
