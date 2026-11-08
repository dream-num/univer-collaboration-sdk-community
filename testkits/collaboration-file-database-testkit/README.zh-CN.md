# @univerjs-pro/collaboration-file-database-testkit

[English](./README.md) | [简体中文](./README.zh-CN.md)

Univer Collaboration SDK `IFileDatabaseAdapter` 实现的契约测试。
[univer-collaboration-sdk-community](https://github.com/dream-num/univer-collaboration-sdk-community)
中的每个适配器都通过这套测试，面向你自己存储的适配器也应当通过。

testkit 不发布到 npm，它是本仓库里的 private workspace 包：在这个 workspace 的包里用 `workspace:*` 依赖它，
或者把它的 `src/` 目录拷进你的项目。它基于 Vitest 运行。

```ts
import { fileDatabaseAdapterContract } from '@univerjs-pro/collaboration-file-database-testkit';
import { MyFileDatabaseAdapter } from './my-file-database-adapter.js';

fileDatabaseAdapterContract('MyDatabase', async () => {
  const adapter = await MyFileDatabaseAdapter.create(/* ... */);
  return { adapter, dispose: () => adapter.dispose() };
});
```

工厂在每个测试前运行一次，返回一个全新的空适配器。

## 契约要点

`@univerjs-pro/collaboration-file-service` 的接口文档就是契约。以下是实现最常出错的地方：

- `create` 原样保存 `FileRecord` 的每个字段，包括未知的 `source` 值；重复的 `fileID` 以
  `FileError("INVALID_REQUEST")` 失败并保留第一条记录。
- `get` 与 `delete` 对不存在的记录返回 `null`。`delete` 返回被移除的记录和它释放的 `blobKey`；
  一对一的适配器总是释放记录自己的 key。
- `list` 按 `source`、可选的 `assign` 和不含边界的 `createdBefore` 过滤，按 `(createdAt, fileID)` 升序
  排列，并用由本页最后一条记录编码的不透明游标分页。更早的记录被删除后游标仍然有效，无法解码的游标
  以 `FileError("INVALID_REQUEST")` 失败，最后一页的 `nextCursor` 为 `null`。
