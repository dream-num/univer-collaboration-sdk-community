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

## 导入与导出的核心

一次导入是一次转换加一次协同 Service 调用，导出也是。以 XLSX 文件和 Sheet 为例：

```ts
const unitID = randomUUID();
const imported = await importBufferToSnapshot(bytes, {
  type: UniverInstanceType.UNIVER_SHEET,
  format: ExchangeFormat.XLSX,
  fileName,
  unitId: unitID,
  formulaCalculation: FormulaCalculationMode.FORCED,
  files: { store: storeEmbeddedFile },
});

await collabService.createUnitFromSnapshot(
  {
    snapshot: { ...imported.snapshot, unitID, type: UniverType.UNIVER_SHEET, rev: 1 },
    sheetBlocks: imported.sheetBlocks,
  },
  context
);
```

```ts
const data = await collabService.getUnitLoadDataWithBlocks(
  { unitID, type: UniverType.UNIVER_SHEET, revision: 0 },
  context
);

// `materializer` 是一个 `UnitSnapshotMaterializer` 实例，创建一次后复用。
const head =
  data.changesets.length === 0
    ? { snapshot: data.snapshot, sheetBlocks: [...data.sheetBlocks] }
    : await materializer.materializeSnapshot(data);

const xlsx = await exportSnapshotToBuffer(head, {
  type: UniverInstanceType.UNIVER_SHEET,
  format: ExchangeFormat.XLSX,
  // 快照已经算过：导入时、协同 Service 保存快照时，或 `materializeSnapshot` 中。这里不需要再计算。
  formulaCalculation: FormulaCalculationMode.NO,
  files: { load: loadEmbeddedFile },
});
```

示例中的 `files.store` 和 `files.load` 可以用 SDK 的 [File Service](../collaboration-file-service/README.zh-CN.md) 存取图片和附件，也可以对接应用自己的文件存储。

本 Service 的其余部分处理这两段调用周边的事情：

| 方面 | 本 Service 做的事 |
| --- | --- |
| 任务 | 在后台执行转换，任务只有创建者可以读取。 |
| 请求 | 校验输入，按类型确定格式并转换前端选项。 |
| 文件 | 检查源文件属于调用方，把导入的图片和附件存为新 Unit 的文件，导出时再读回，并删除临时文件。 |
| 权限 | 执行协同 Service 的 middleware 和自己的 `import`、`export` middleware。 |
| 快照 JSON | 导入为 JSON 文件而不是 Unit（`outputType: 2`），以及导出客户端快照（`jsonID`）。 |
| OLE 附件 | 把已存储的附件转成在线 Unit，以及在导出中嵌入在线 Unit。 |

## 支持的转换

| 类型 | 导入 | 导出 |
| --- | --- | --- |
| Sheet | xls、xlsx、csv、tsv | xlsx、csv、tsv |
| Doc | doc、docx | docx |
| Slide | ppt、pptx | pptx |
| Base | xls、xlsx、csv、tsv | xlsx、csv |
| PDF | pdf | pdf |

导入格式由上传文件的文件名决定。Board 会被拒绝。

Sheet 的公式在导入时计算，导出时不计算。XLSX 导入重算全部公式；XLS、CSV、TSV 导入暂不重算。导出按快照中已有的结果写出，没有结果的公式导出后没有值。

按 `unitID` 导出时，最近一次快照之后没有 changeset 就直接使用该快照，否则回放这些 changeset 并重新计算。

### 启用 PDF Unit（可选）

导入和导出任务的 `type` 均使用 `UniverType.UNIVER_PDF`。导入将 PDF 文件转换为 PDF Unit 或其快照，导出则将 PDF Unit 或其快照写回 PDF 文件。

要启用这项转换，先安装 PDF binding。

```bash
pnpm add @univerjs-pro/exchange-pdf-node-binding
```

在导入导出进程的入口注册 PDF 支持。省略这行时，PDF 任务会以 `UNSUPPORTED_FORMAT` 失败。

```ts
import '@univerjs-pro/exchange-node/pdf';
```

## 许可证与额度

在导入导出进程中，将环境变量 `UNIVER_LICENSE` 和 `UNIVER_LICENSE_KEY` 分别设为许可证和密钥文件的完整内容，`exchange-node` 会自动读取。也可以在启动时通过代码配置。

```ts
import { configureExchange, getExportQuota } from '@univerjs-pro/exchange-node';

await configureExchange({ license, licenseKey });
const quota = await getExportQuota(); // 按需查询剩余导出额度。
```

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
