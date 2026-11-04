# @univerjs-pro/collaboration-exchange-service

English | [简体中文](./README.zh-CN.md)

`UniverExchangeService` imports Office and PDF files into Univer and exports Univer data back to files. It converts with `@univerjs-pro/exchange-node` inside the process, creates and reads Units through the collaboration Service, and stores source files and results in the File Service.

The Service has no network dependency. `@univerjs-pro/collaboration-exchange-endpoint` serves the import and export requests of the Univer frontend on top of it.

## Installation and usage

```bash
pnpm add \
  @univerjs-pro/collaboration-exchange-service \
  @univerjs-pro/exchange-node
```

`@univerjs-pro/exchange-node` is a peer dependency: install the version this package declares.

```ts
const exchangeService = new UniverExchangeService({ collabService, fileService });

exchangeService.use('export', async (ctx, next) => {
  if (ctx.snapshot) await requireUnitViewIfExists(ctx.userID, ctx.snapshot.snapshot.unitID);
  await next();
});

await exchangeService.dispose();
await fileService.dispose();
```

| Option | Description |
| --- | --- |
| `collabService` | Required. A `UniverCollabService`, or a wrapper with `createUnitFromSnapshot` and `getUnitLoadDataWithBlocks` that passes the context through unchanged. Its `createUnit` and `readUnitData` middleware apply to every import and export. |
| `fileService` | Required. The `UniverFileService` that receives client uploads. |
| `logger` | Receives failures the Service handles itself, such as a failed early file delete. Without it, `warn` and `error` go to the console. |

The constructor throws a `TypeError` when a required option is missing. Dispose Exchange before the File Service and the collaboration Service.

## Supported conversions

| Type | Import | Export |
| --- | --- | --- |
| Sheet | xls, xlsx, csv, tsv | xlsx, csv, tsv |
| Doc | doc, docx | docx |
| Slide | ppt, pptx | pptx |
| Base | xls, xlsx, csv, tsv | xlsx, csv |
| PDF | pdf | pdf |

The name of the uploaded file decides the import format. Board is rejected. For PDF, install `@univerjs-pro/exchange-pdf-node-binding` and run `import '@univerjs-pro/exchange-node/pdf'` at startup; without them a PDF task fails with `UNSUPPORTED_FORMAT`.

## License and quota

Configure the License through `exchange-node`: set `UNIVER_LICENSE` and `UNIVER_LICENSE_KEY`, or call `configureExchange()`. A License passed only to the `UniverCollabService` constructor does not reach `exchange-node`. Query the remaining quota with `getExportQuota()` from `exchange-node`.

## Methods

Every method takes a caller context `{ userID, customData? }` and reports failures as a rejected Promise.

| Method | Result |
| --- | --- |
| `createImportTask(input, ctx)` | the `taskID` |
| `createExportTask(input, ctx)` | the `taskID` |
| `getTask(taskID, ctx)` | the task; only its creator can read it |

A create call validates the request, checks ownership and runs middleware before it resolves. A rejected call creates no task. Conversion then runs in the background.

| `ImportInput` field | Description |
| --- | --- |
| `type` | `UniverType` |
| `outputType` | `1` creates a collaborative Unit, `2` writes snapshot JSON to a file |
| `fileID` | an `HttpImport` file uploaded by the caller |
| `options` | front-end import options |

| `ExportInput` field | Description |
| --- | --- |
| `type` | `UniverType` |
| `unitID` or `jsonID` | exactly one: a stored Unit, or an `HttpImport` file holding `{ snapshot, sheetBlocks }` JSON |
| `format` | the target format |
| `options` | front-end export options; Sheet CSV/TSV needs `sheet.csv.sheetId` and Base CSV needs `base.csv.tableId` |

Tasks are `pending`, `done` with `result`, or `failed` with the original `error`. Results are `{ outputType: 1, unitID }`, `{ outputType: 2, jsonID }` or `{ fileID }`; `jsonID` and `fileID` are `HttpExport` files owned by the caller.

Finished tasks stay readable for one hour. Tasks live in this Service instance, so run one import and export node and route all three Endpoint routes to it. After a restart, `getTask` reports the task as missing.

## Files

Importing to a Unit stores images and attachments of Sheet, Doc and Slide as `UnitEmbedded` files of the new Unit. If the import fails, those files are deleted. Base, PDF and `outputType: 2` keep them inline in the snapshot.

The source upload and the snapshot JSON of a `jsonID` export are deleted when their task ends. Results stay until File cleanup removes them.

Exporting reads `UnitEmbedded` files of the exported Unit. URL images export as a transparent placeholder, and `options.sheet.useImageUrl` has no effect.

When the import and export node is separate from the collaboration node, give both `UniverFileService` instances the same storage (`@univerjs-pro/collaboration-file-database-postgres` with `@univerjs-pro/collaboration-file-blob-s3`), and install the same permission middleware on both `UniverCollabService` instances. The SQLite and local directory adapters are for single-node deployments.

## OLE attachments

Exports write embedded attachments back as their original files. Two front-end OLE features are not available and return `INVALID_REQUEST`:

- exporting with `options.oleAttachmentSource: 'online'`;
- importing with `sourceUnitID` (`importAttachmentToUnitId`), which converts a stored attachment to an online Unit.

Leave `ole.getLink` unset in `exchange-client` so that the attachment toolbar does not offer "convert to online". Attachment preview and download keep working.

## Middleware

`use(action, middleware)` returns a `Disposable`. Middleware calls `next()` to continue or throws to reject; the call then rejects with that error and creates no task. `ctx.request` is read-only. Each action runs once per request and is never retried.

| Action | Runs | Visible fields | Typical use |
| --- | --- | --- | --- |
| `import` | after validation and the source ownership check, before the task is created | `userID`, `customData`, `request` (`type`, `outputType`, `fileID`, `options`) | rate limits, quota, restricting document types, audit |
| `export` | after validation, before the task is created; after the Unit is read for `unitID`, after the snapshot is decoded for `jsonID` | `userID`, `customData`, `request` (`type`, `unitID` or `jsonID`, `format`, `options`); `snapshot` for `jsonID` | restricting exports per user, audit |

A `jsonID` snapshot comes from the client, so `snapshot.unitID` is unverified and may name a Unit that does not exist. Applications that serve both `jsonID` export and collaborative images check in `export` middleware that the caller can view `snapshot.unitID` when that Unit exists, as the example above does. `ctx.snapshot` is shared by reference and is read-only by contract.

## Errors

The Service raises `ExchangeServiceError` with a `code`. Failures from the File Service, the collaboration Service and `exchange-node` keep their own error types.

| `code` | Meaning |
| --- | --- |
| `INVALID_REQUEST` | invalid or unsupported input |
| `FILE_NOT_FOUND` | the file does not exist or does not belong to the caller |
| `TASK_NOT_FOUND` | the task does not exist or does not belong to the caller |
| `UNAUTHENTICATED` | raised by the Endpoint for a request without a user |
| `SERVICE_DISPOSED` | the Service is disposed |

`dispose()` drops all tasks. Conversions still running end without creating a Unit or a result file.
