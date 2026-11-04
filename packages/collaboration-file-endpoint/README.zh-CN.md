# @univerjs-pro/collaboration-file-endpoint

[English](./README.md) | [简体中文](./README.zh-CN.md)

`UniverFileEndpoint` 提供 Univer 前端上传图片、附件以及 Office 导入导出时调用的 HTTP 路由。
它把每个请求映射到 `@univerjs-pro/collaboration-file-service`，运行在
`@univerjs-pro/collaboration-transport-node` 之上。

```text
HTTP 请求
→ Transport 认证 middleware（设置 ctx.userID）
→ UniverFileEndpoint（multipart、解压、限制、响应头）
→ UniverFileService（归属规则、middleware）
→ 元数据 adapter 与 blob store
```

## 安装与注册

```bash
pnpm add \
  @univerjs-pro/collaboration-file-service \
  @univerjs-pro/collaboration-file-endpoint \
  @univerjs-pro/collaboration-transport-node
```

```ts
const fileEndpoint = new UniverFileEndpoint(fileService, {
  maxUploadBytes: 100 * 1024 * 1024,
});

transport.use(authenticationMiddleware);
transport.register(fileEndpoint);
```

File Endpoint 要先于依赖 File Service 的其他 Endpoint 注册，这样 Transport 会先释放那些 Endpoint。
Endpoint 不会 dispose File Service。

| 选项 | 默认值 |
| --- | --- |
| `routePrefix` | `/universer-api`；绝对路径，不带末尾斜杠 |
| `maxUploadBytes` | 不限；按解压后实际读到的字节计数 |
| `uploadTimeoutMs` | 600000（10 分钟），从请求开始处理时计时 |
| `downloadCacheMaxAgeSeconds` | 3600；代理下载的 `max-age`，`0` 表示浏览器每次都重新确认 |

## 路由

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| `POST` | `{prefix}/stream/file/upload?size=&source=&assign=&flate=` | `{ error, FileId }` |
| `GET` | `{prefix}/file/{fileID}/sign-url` | `{ error, url }` |
| `GET` | `{prefix}/file/{fileID}/download` | 文件内容 |

使用默认前缀时，这些就是 `exchange-client` 和 `collaboration-client` 默认请求的地址。只有 API 不在页面
同源下时，客户端才需要配置 `downloadEndpointUrl`。

**上传**：请求体为 `multipart/form-data`，名为 `file` 的 part 不经缓冲直接流式写入 blob store，
因此不受 Transport `maxRequestBodyBytes` 限制。`flate=true` 表示该 part 是 raw DEFLATE，读取时边读边解压。
`size` 只作提示，保存的大小是实际写入的字节数，允许上传空文件。`source` 缺失或不是整数时按 `0` 保存。
被拒绝、超出大小或超时的请求会立即响应并关闭连接，不再读取剩余的请求体。

**sign-url**：blob store 签发了直链时返回绝对 URL，否则返回下载路由的相对路径，客户端用
`downloadEndpointUrl` 解析相对路径。

**下载**：响应带记录中的 `Content-Type`、`Content-Length`、带文件名的 `Content-Disposition: attachment`、
`X-Content-Type-Options: nosniff`、`ETag` 以及 `Cache-Control: private, max-age=<downloadCacheMaxAgeSeconds>, immutable`。
所有文件都以附件形式返回，不影响 `<img>` 嵌入显示。

## 认证

Endpoint 使用 Transport 中间件为本次请求设置的 `userID`，缺失时返回 `401`。

图片由浏览器直接加载：只有文件路由与页面同源时，请求才会带 cookie；应用自己添加的 `Authorization` 头则始终不会带上。

- **cookie 认证，同源部署**：代理下载无需额外配置。
- **cookie 认证，文件路由在其他源**（不同子域名也算）：用反向代理把文件路由挂到页面同源下，或配置能签发直链的 blob store。
- **只用 Bearer token**：配置能签发直链的 blob store。

直链在通过 `sign-url` 签发时就完成了鉴权，加载时不需要凭证。

## 错误

JSON 路由总是返回 protocol `error` 对象，成功时 `error.code` 为 `OK`。代理下载失败时只返回状态码和纯文本消息。

| `FileError` code | HTTP | protocol `ErrorCode` |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | `INVALID_ARGUMENT` |
| `UNAUTHENTICATED` | 401 | `UNAUTHENTICATED` |
| `PERMISSION_DENIED` | 403 | `PERMISSION_DENIED` |
| `FILE_NOT_FOUND` | 404 | `NOT_FOUND` |
| `UPLOAD_TIMEOUT` | 408 | `INTERNAL_ERROR` |
| `PAYLOAD_TOO_LARGE` | 413 | `INVALID_ARGUMENT` |
| `STORAGE_FAILURE`、`SERVICE_DISPOSED` | 503 | `INTERNAL_ERROR` |
