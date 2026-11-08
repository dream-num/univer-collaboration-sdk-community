# @univerjs-pro/collaboration-file-blob-testkit

[English](./README.md) | [简体中文](./README.zh-CN.md)

Univer Collaboration SDK `IFileBlobStore` 实现的契约测试。
[univer-collaboration-sdk-community](https://github.com/dream-num/univer-collaboration-sdk-community)
中的每个存储都通过这套测试，面向你自己对象存储的实现也应当通过。

testkit 不发布到 npm，它是本仓库里的 private workspace 包：在这个 workspace 的包里用 `workspace:*` 依赖它，
或者把它的 `src/` 目录拷进你的项目。它基于 Vitest 运行。

```ts
import { fileBlobStoreContract } from '@univerjs-pro/collaboration-file-blob-testkit';
import { MyFileBlobStore } from './my-file-blob-store.js';

fileBlobStoreContract('MyStore', async () => {
  const store = new MyFileBlobStore(/* ... */);
  return {
    store,
    countObjects: () => store.countForTests(),
    dispose: () => store.dispose(),
  };
});
```

工厂在每个测试前运行一次，返回一个全新的空存储。`countObjects` 可选；提供时，测试还会检查失败的
`put` 不会留下残缺对象。

## 契约要点

`@univerjs-pro/collaboration-file-service` 的接口文档就是契约。以下是实现最常出错的地方：

- `put` 消费多块的 `AsyncIterable<Uint8Array>`，接受空内容，报告实际写入的字节数，并为不同文件给出
  不同的 `blobKey`。流失败时 `put` 拒绝并且不留下残缺对象。
- `open` 对不存在的 key 以 `FileError("FILE_NOT_FOUND")` 失败。
- `delete` 把不存在的 key 视为成功。
- `signUrl` 可选。返回链接时，URL 可解析且 `expiresAt` 在未来。
