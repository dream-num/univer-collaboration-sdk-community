# @univerjs-pro/collaboration-file-service

[English](./README.md) | [简体中文](./README.zh-CN.md)

`UniverFileService` 保存 Univer 客户端上传的二进制文件：插入 Unit 的图片和附件，以及 Office
导入导出的源文件和结果文件。它通过 `IFileDatabaseAdapter` 写文件元数据，通过 `IFileBlobStore`
写文件内容，执行内置归属规则和 middleware，并清理过期的临时文件。

Service 不依赖网络，也不依赖 `@univerjs-pro/collaboration-service`。`@univerjs-pro/collaboration-file-endpoint`
在它之上处理 Univer 前端的 HTTP 请求：图片和附件的上传下载，以及导入导出的文件传输。

## 安装与使用

```bash
pnpm add \
  @univerjs-pro/collaboration-file-service \
  @univerjs-pro/collaboration-file-database-sqlite \
  @univerjs-pro/collaboration-file-blob-local
```

```ts
const database = new SQLiteFileDatabaseAdapter({ filename: './data/collaboration.sqlite' });
const blobStore = new LocalFileBlobStore({ directory: './data/files' });
const fileService = new UniverFileService({
  database,
  blobStore,
  cleanup: { context: { userID: 'system:file-cleanup' } },
});

fileService.use('upload', async (ctx, next) => {
  if (ctx.request.source === FileSource.UnitEmbedded) {
    await requireUnitEdit(ctx.userID, ctx.request.assign);
  }
  await next();
});

await fileService.dispose();
await database.dispose();
await blobStore.dispose();
```

`database` 与 `blobStore` 必填，缺少时构造函数抛出 `TypeError`。Service 不会 dispose 传入的 adapter。

可用实现：

| Package | 契约 | 部署 |
| --- | --- | --- |
| `@univerjs-pro/collaboration-file-memory` | 两者 | 测试与演示 |
| `@univerjs-pro/collaboration-file-database-sqlite` | `IFileDatabaseAdapter` | 单节点 |
| `@univerjs-pro/collaboration-file-database-postgres` | `IFileDatabaseAdapter` | 单节点或多节点 |
| `@univerjs-pro/collaboration-file-blob-local` | `IFileBlobStore` | 单节点 |
| `@univerjs-pro/collaboration-file-blob-s3` | `IFileBlobStore` | S3 兼容对象存储，支持直链 |

元数据和内容是两个独立契约，可以各自跟随应用已有的存储，例如元数据放 Postgres、内容放 S3。

## 方法

每个方法都接收调用方上下文 `{ userID, customData? }`。`userID` 必填。同一次 Service 调用中的所有
middleware 和 adapter 调用共享同一个 `customData`；省略时 Service 创建一个空对象。

**HTTP 层**：由 `@univerjs-pro/collaboration-file-endpoint` 调用，执行内置归属规则和 middleware。

| 方法 | 返回 |
| --- | --- |
| `upload(input, ctx)` | 写入后的 `FileRecord` |
| `signUrl({ fileID }, ctx)` | `{ record, direct? }`；blob store 签发了直链时带 `direct` |
| `openDownload({ fileID }, ctx)` | `{ record, content }` |

**可信层**：供可信的服务端代码使用，例如导入导出服务或应用自身。不执行归属规则和 middleware，
`source` 与 `assign` 由调用方负责。不得直接暴露给 HTTP 客户端。

| 方法 | 返回 |
| --- | --- |
| `createFile(input, ctx)` | 写入后的 `FileRecord` |
| `getFile(fileID, ctx)` | `FileRecord`，不存在时为 `null` |
| `openFile(fileID, ctx)` | `{ record, content }` |
| `deleteFile(fileID, ctx)` | 删除了记录时为 `true` |
| `listFiles({ source, assign?, createdBefore?, limit, cursor? }, ctx)` | `{ records, nextCursor }`，按 `(createdAt, fileID)` 升序；最后一页的 `nextCursor` 为 `null` |
| `cleanupExpiredFiles(ctx, options?)` | `{ scanned, deleted, failed }` |

内容在读写两个方向都是 `AsyncIterable<Uint8Array>`。每次上传生成新的 `fileID`（`randomUUID()`），
内容不会被覆盖。`FileRecord.size` 是实际写入的字节数。

## 归属规则

| `source` | `assign` | 访问 |
| --- | --- | --- |
| `HttpImport`（1）、`HttpExport`（2） | HTTP 上传时强制为上传者 | 只有 `assign === userID` 可访问；临时文件 |
| `UnitEmbedded`（3） | Unit ID，上传时必填 | 由 middleware 决定；永久文件 |
| 其他值 | 按请求原样保存 | 由 middleware 决定；永久文件 |

内置校验先于 middleware 执行，因此 middleware 只能收紧访问。Service 不了解应用的 Unit 权限，
需要以 middleware 接入。删除 Unit 时不会删除它的 `UnitEmbedded` 文件；应用需要清理时，可以用
Unit ID 作为 `assign` 调用 `listFiles`。

## Middleware

`use(action, middleware)` 返回 `Disposable`。middleware 调用 `next()` 继续，或抛出
`FileError('PERMISSION_DENIED')` 拒绝。`ctx.request` 与 `ctx.record` 只读。可信层方法不会执行 middleware。

| Action | 执行时机 | 可见字段 | 典型用途 |
| --- | --- | --- | --- |
| `upload` | 读取任何内容之前 | `userID`、`customData`、`request`（`name`、`contentType`、声明的 `size`、`source`、`assign`、`flate`） | Unit 编辑权限、配额、限流 |
| `signUrl` | 读出记录并通过内置校验之后 | `userID`、`customData`、`request.fileID`、`record` | Unit 查看权限、审计 |
| `download` | 仅代理下载，打开内容之前 | `userID`、`customData`、`request.fileID`、`record` | 与 `signUrl` 相同的访问控制 |

每个 action 每次调用执行一次，不会重试。代理下载的 URL 不带签名，所以要把同一套访问控制同时注册到
`signUrl` 和 `download`：前者覆盖直链部署，后者覆盖代理下载。

## 过期文件清理

`cleanupExpiredFiles` 分页删除超过保留时长的 `HttpImport` 与 `HttpExport` 文件。构造时传入
`cleanup` 会启动内置定时器；不传时由应用自己的调度器调用该方法。

| 选项 | 默认值 |
| --- | --- |
| `context` | 传 `cleanup` 时必填，是 adapter 调用使用的身份 |
| `intervalMs` | 60 分钟；首轮在 `[intervalMs, 2 × intervalMs)` 内随机延迟后执行 |
| `retentionMs` | 2 小时 |
| `batchSize` | 100 |
| `maxPerRun` | 500 |
| `batchGapMs` | 1 秒 |

清理是幂等的，多个节点同时执行是安全的。同一进程内上一轮尚未结束时，新的一轮会立即返回。

## 错误

所有失败都是 `FileError`，带 `code`；包装 adapter 错误时原始错误保留在 `cause`。每个方法都以 rejected Promise 报告失败。

| `code` | 含义 |
| --- | --- |
| `INVALID_REQUEST` | 输入无效、`UnitEmbedded` 缺少 `assign`、`fileID` 重复 |
| `FILE_NOT_FOUND` | 元数据或内容不存在 |
| `UNAUTHENTICATED` | 没有已认证用户（由 Endpoint 抛出） |
| `PERMISSION_DENIED` | 内置校验或 middleware 拒绝 |
| `PAYLOAD_TOO_LARGE`、`UPLOAD_TIMEOUT` | 上传限制（由 Endpoint 抛出） |
| `STORAGE_FAILURE` | adapter 抛出了 `FileError` 以外的错误，原始错误在 `cause` |
| `SERVICE_DISPOSED` | Service 已 dispose |

## 生命周期与孤儿对象

`dispose()` 停止清理定时器并等待进行中的调用结束，之后的调用以 `SERVICE_DISPOSED` 失败。

写入时先写内容再写元数据，删除时先删元数据再删内容。第二步失败时，内容可能失去对应的记录。
Service 通过 `logger` 选项（默认 `console`）以 warn 级别记录 `fileID` 和 `blobKey`，不回收这些对象。

## 实现 adapter

`IFileDatabaseAdapter` 保存 `FileRecord`：`create`（`fileID` 重复时抛 `FileError('INVALID_REQUEST')`）、
`get`、`delete`（返回 `{ record, releasedBlobKey }`）、`list`（按 `(createdAt, fileID)` 排序，游标不透明）
与 `dispose`。`IFileBlobStore` 把不透明的 `blobKey` 映射到字节：`put`（返回 `{ blobKey, size }`，失败时
不留半成品）、`open`（键不存在时抛 `FileError('FILE_NOT_FOUND')`）、`delete`（键不存在视为成功）、可选的
`signUrl` 与 `dispose`。adapter 收到 `{ userID, customData, request }`，不鉴权、不解释 `source`，也不执行清理策略。
内置实现就是两个契约的参考实现。
