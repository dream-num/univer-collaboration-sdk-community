# @univerjs-pro/collaboration-database-testkit

[English](./README.md) | [简体中文](./README.zh-CN.md)

Univer Collaboration SDK `IDatabaseAdapter` 实现的契约测试与夹具。
[univer-collaboration-sdk-community](https://github.com/dream-num/univer-collaboration-sdk-community)
中的每个适配器都通过这套测试，面向你自己存储的适配器也应当通过。

testkit 不发布到 npm，它是本仓库里的 private workspace 包：在这个 workspace 的包里用 `workspace:*` 依赖它，
或者把它的 `src/` 目录拷进你的项目。它基于 Vitest 运行。

```ts
import { databaseAdapterContract } from '@univerjs-pro/collaboration-database-testkit';
import { MyDatabaseAdapter } from './my-database-adapter.js';

databaseAdapterContract('MyDatabase', async () => {
  const adapter = await MyDatabaseAdapter.create(/* ... */);
  return { adapter, dispose: () => adapter.dispose() };
});
```

工厂在每个测试前运行一次，返回一个全新的空适配器。`createUnitRecord`、`createSnapshot`、
`createChangeset`、`createSheetBlock` 和 `createDatabaseContext` 为你自己的测试构造合法的协议对象。

## 契约要点

`@univerjs-pro/collaboration-service` 的接口文档就是契约。以下是实现最常出错的地方：

- `createUnit` 原样保存 `record.creatorID` 与 `record.createdAt` 并校验它们：非空字符串和非负的安全整数。
  非法值以 `INVALID_REQUEST` 失败，数据库保持不变。
- `commitChangeset` 在同一个原子边界内检查 head、写入 changeset 并更新 head。适配器把 `createTime`
  赋为持久化时刻的 Unix 秒，不修改输入对象，并返回它实际存储的 changeset。
- `deleteUnits` 与 `recoverUnits` 收到的 `unitIDs` 由 Service 保证非空、不含空字符串、不含重复。
  一个批次整体成功或整体失败。
- `getChangesets` 把 `to: 0` 视为显式上界并返回 `[]`，只有省略 `to` 才是无上界。不可见的 Unit 返回
  `null`，空区间返回 `[]`。
- 硬删除之后 Unit ID 作为永久标记保留：`createUnit` 与 `recoverUnits` 以 `INVALID_REQUEST` 失败，
  重复硬删除返回 `already-hard-deleted`。
