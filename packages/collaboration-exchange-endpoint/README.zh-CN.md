# @univerjs-pro/collaboration-exchange-endpoint

[English](./README.md) | 简体中文

`UniverExchangeEndpoint` 提供 Univer 前端进行 Office 和 PDF 导入导出时调用的 HTTP 路由。它把请求映射到 `@univerjs-pro/collaboration-exchange-service`，运行在 `@univerjs-pro/collaboration-transport-node` 上。

```text
HTTP 请求
→ Transport 认证 middleware（设置 ctx.userID）
→ UniverExchangeEndpoint（路由 type、JSON 字段、错误码）
→ UniverExchangeService（校验、归属、middleware、任务）
```

## 安装与注册

```bash
pnpm add \
  @univerjs-pro/collaboration-exchange-service \
  @univerjs-pro/collaboration-exchange-endpoint \
  @univerjs-pro/collaboration-transport-node
```

```ts
transport.use(authenticationMiddleware);
transport.register(fileEndpoint);
transport.register(new UniverExchangeEndpoint(exchangeService));
```

在 File Endpoint 之后注册，Transport 会先释放它。Endpoint 不释放 Exchange Service。

| 选项 | 默认值 |
| --- | --- |
| `routePrefix` | `/universer-api`；绝对路径，无结尾斜杠 |

## 路由

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| `POST` | `{prefix}/exchange/{type}/import` | `{ fileID, outputType, options? }` | `{ error, taskID }` |
| `POST` | `{prefix}/exchange/{type}/export` | `{ unitID 或 jsonID, format, options? }` | `{ error, taskID }` |
| `GET` | `{prefix}/exchange/task/{taskID}` | | `{ error, taskID, status, import?, export? }` |

`{type}` 是 `UniverType` 的数值。使用默认前缀时，这些就是 `exchange-client` 的默认地址。

三条路由都返回 HTTP 200，结果放在 `error.code`。任务响应为 `status: "pending"` 或 `"done"` 时 `error.code = OK`，为 `status: "failed"` 时带失败错误码。`export.fileUrl` 始终为空；客户端通过 File 的 sign-url 路由获取下载地址。

## 错误码

| 来源 | `error.code` |
| --- | --- |
| 请求无效，类型、格式或选项不支持，文件或快照无效 | `INVALID_ARGUMENT` |
| 缺少用户 | `UNAUTHENTICATED` |
| 文件、Unit 或任务不存在 | `NOT_FOUND` |
| 协同 Service 或 File Service 拒绝权限 | `PERMISSION_DENIED` |
| `exchange-node` 许可证错误 | 同名的 `LICENSE_*` 错误码 |
| 其他情况，包括 Exchange middleware 抛出的错误 | `INTERNAL_ERROR` |

`error.message` 保留原始信息。
