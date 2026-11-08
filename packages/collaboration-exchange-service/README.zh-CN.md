# @univerjs-pro/collaboration-exchange-service

[English](./README.md) | 简体中文

`UniverExchangeService` 把 Office 和 PDF 文件导入 Univer，并把 Univer 数据导出为文件。它在进程内用 `@univerjs-pro/exchange-node` 转换，通过协同 Service 创建和读取 Unit，把源文件和结果存入 File Service。

Service 不依赖网络。`@univerjs-pro/collaboration-exchange-endpoint` 在它之上处理 Univer 前端的导入导出请求。

## 安装与使用

```bash
pnpm add \
  @univerjs-pro/collaboration-exchange-service \
  @univerjs-pro/exchange-node
```

`@univerjs-pro/exchange-node` 是 peer dependency，安装本包声明的版本。

```ts
const exchangeService = new UniverExchangeService({ collabService, fileService });

exchangeService.use('export', async (ctx, next) => {
  if (ctx.snapshot) await requireUnitViewIfExists(ctx.userID, ctx.snapshot.snapshot.unitID);
  await next();
});

await exchangeService.dispose();
await fileService.dispose();
```

| 选项 | 说明 |
| --- | --- |
| `collabService` | 必填。`UniverCollabService`，或带 `createUnitFromSnapshot`、`getUnitLoadDataWithBlocks` 且原样传递 context 的包装层。它的 `createUnit`、`readUnitData` middleware 对每次导入导出生效。 |
| `fileService` | 必填。接收客户端上传的 `UniverFileService`。 |
| `logger` | 接收 Service 自行处理的失败，例如提前删除文件失败。未传时 `warn`、`error` 写 console。 |
| `runtime` | 可选。`{ execution }`，取值与 `UniverCollabService` 的 `runtime.execution` 相同，用于按 `unitID` 导出时生成快照的 Runtime。默认用 Worker 执行，Worker 在构造 Service 时启动。`in-process` 不启动 Worker，但生成快照在主线程运行，大 Unit 会阻塞事件循环。 |

缺少必填选项时构造函数抛 `TypeError`。释放时先释放 Exchange，再释放 File Service 和协同 Service。

## 支持的转换

| 类型 | 导入 | 导出 |
| --- | --- | --- |
| Sheet | xls、xlsx、csv、tsv | xlsx、csv、tsv |
| Doc | doc、docx | docx |
| Slide | ppt、pptx | pptx |
| Base | xls、xlsx、csv、tsv | xlsx、csv |
| PDF | pdf | pdf |

导入格式由上传文件的文件名决定。Board 会被拒绝。使用 PDF 时安装 `@univerjs-pro/exchange-pdf-node-binding`，并在启动时执行 `import '@univerjs-pro/exchange-node/pdf'`；否则 PDF 任务以 `UNSUPPORTED_FORMAT` 失败。

## 许可证与额度

通过 `exchange-node` 配置许可证：设置 `UNIVER_LICENSE` 和 `UNIVER_LICENSE_KEY`，或调用 `configureExchange()`。只传给 `UniverCollabService` 构造参数的许可证不会到达 `exchange-node`。用 `exchange-node` 的 `getExportQuota()` 查询剩余额度。

## 方法

每个方法都接收调用方 context `{ userID, customData? }`，失败时返回 rejected Promise。

| 方法 | 结果 |
| --- | --- |
| `createImportTask(input, ctx)` | `taskID` |
| `createExportTask(input, ctx)` | `taskID` |
| `getTask(taskID, ctx)` | 任务；只有发起人能读取 |

创建调用在 resolve 前完成请求校验、归属检查和 middleware。被拒绝的调用不创建任务。之后转换在后台执行。

| `ImportInput` 字段 | 说明 |
| --- | --- |
| `type` | `UniverType` |
| `outputType` | `1` 创建协同 Unit，`2` 把快照 JSON 写入文件 |
| `fileID` | 调用方上传的 `HttpImport` 文件；带 `sourceUnitID` 时为该 Unit 的 `UnitEmbedded` 附件 |
| `sourceUnitID` | 可选。把该 Unit 已存储的附件 `fileID` 转成在线 Unit；要求 `outputType: 1` |
| `options` | 前端导入选项 |

| `ExportInput` 字段 | 说明 |
| --- | --- |
| `type` | `UniverType` |
| `unitID` 或 `jsonID` | 二选一：已存储的 Unit，或内容为 `{ snapshot, sheetBlocks }` JSON 的 `HttpImport` 文件 |
| `format` | 目标格式 |
| `options` | 前端导出选项；Sheet CSV/TSV 需要 `sheet.csv.sheetId`，Base CSV 需要 `base.csv.tableId`；`oleAttachmentSource` 选择附件版本 |

任务状态为 `pending`、带 `result` 的 `done`，或带原始 `error` 的 `failed`。结果是 `{ outputType: 1, unitID }`、`{ outputType: 2, jsonID }` 或 `{ fileID }`；`jsonID` 和 `fileID` 是属于调用方的 `HttpExport` 文件。

结束的任务保留 1 小时可读。任务保存在这个 Service 实例中，因此只部署一个导入导出节点，并把 Endpoint 的三条路由都发到这个节点。节点重启后，`getTask` 报告任务不存在。

## 文件

导入成 Unit 时，Sheet、Doc、Slide 的图片和附件存为新 Unit 的 `UnitEmbedded` 文件；导入失败时这些文件被删除。Base、PDF 和 `outputType: 2` 把它们内联在快照中。

源文件和 `jsonID` 导出的快照 JSON 在任务结束时删除。结果文件保留到 File 清理。

导出时读取被导出 Unit 的 `UnitEmbedded` 文件。URL 图片导出为透明占位图，`options.sheet.useImageUrl` 不生效。

导入导出节点与协同节点分开部署时，两边的 `UniverFileService` 使用同一份存储（`@univerjs-pro/collaboration-file-database-postgres` 与 `@univerjs-pro/collaboration-file-blob-s3`），两边的 `UniverCollabService` 安装相同的权限 middleware。SQLite 和本地目录 adapter 用于单机部署。

## OLE 附件

导出时把嵌入的附件写回原始文件。

导入时传 `sourceUnitID`（`importAttachmentToUnitId`）把已存储的附件转成在线 Unit：此时 `fileID` 是该 Unit 的 `UnitEmbedded` 文件而不是上传文件，`outputType` 必须为 `1`。Service 校验文件属于 `sourceUnitID`；发起人对该 Unit 的访问权限在 `import` middleware 中检查，那里 `request.sourceUnitID` 有值。新 Unit 与普通导入一样创建，附件仍属于宿主 Unit。在 `UniverDrawingPlugin` 配置 `ole.getLink`，附件工具栏才会出现“转为在线”。

导出默认嵌入原始附件；`options.oleAttachmentSource` 为 `'online'` 时，已转成在线 Unit 的附件改为按该 Unit 的当前内容导出：Service 用调用方 context 读取每个子 Unit，`readUnitData` middleware 对其生效，子 Unit 的 `UnitEmbedded` 文件与宿主的一样读取。`exchange-node` 自行遍历嵌套附件，限制为 8 层、64 个 Unit、50 MiB 嵌入输出，任一子 Unit 读不到则任务失败，不回退到原始附件。整个任务计一次导出额度。只有接受文件的导出接受 `'online'`（Sheet XLSX、Doc、Slide、PDF）；CSV、TSV 与 Base 导出返回 `INVALID_REQUEST`。

## Middleware

`use(action, middleware)` 返回 `Disposable`。Middleware 调用 `next()` 继续，抛错则拒绝；调用随之以该错误 reject，不创建任务。`ctx.request` 只读。每个 action 每次请求执行一次，不重试。

| Action | 触发时机 | 可见字段 | 典型用途 |
| --- | --- | --- | --- |
| `import` | 校验与源文件归属检查之后、创建任务前 | `userID`、`customData`、`request`（`type`、`outputType`、`fileID`、`sourceUnitID`、`options`） | 限流、配额、限制文档类型、审计、`sourceUnitID` 的访问权限 |
| `export` | 校验之后、创建任务前；`unitID` 导出在读取 Unit 之后，`jsonID` 导出在解码快照之后 | `userID`、`customData`、`request`（`type`、`unitID` 或 `jsonID`、`format`、`options`）；`jsonID` 导出另有 `snapshot` | 按用户限制导出、审计；在线导出的子 Unit 在之后读取，走 `readUnitData` |

`jsonID` 的快照来自客户端，`snapshot.unitID` 未经验证，也可能指向不存在的 Unit。同时开放 `jsonID` 导出和协同图片的应用，在 `export` middleware 中检查：该 Unit 存在时调用方对 `snapshot.unitID` 有查看权限，做法见上面的示例。`ctx.snapshot` 按引用共享，约定只读。

## 错误

Service 抛出带 `code` 的 `ExchangeServiceError`。来自 File Service、协同 Service 和 `exchange-node` 的失败保留各自的错误类型。

| `code` | 含义 |
| --- | --- |
| `INVALID_REQUEST` | 输入无效或不支持 |
| `FILE_NOT_FOUND` | 文件不存在或不属于调用方 |
| `TASK_NOT_FOUND` | 任务不存在或不属于调用方 |
| `UNAUTHENTICATED` | Endpoint 对没有用户的请求抛出 |
| `SERVICE_DISPOSED` | Service 已释放 |

`dispose()` 丢弃所有任务。仍在运行的转换结束时不创建 Unit，也不写结果文件。
