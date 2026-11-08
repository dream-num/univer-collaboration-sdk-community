# @univerjs-pro/collaboration-exchange-endpoint

English | [简体中文](./README.zh-CN.md)

`UniverExchangeEndpoint` serves the HTTP routes the Univer frontend calls for Office and PDF import and export. It maps each request to `@univerjs-pro/collaboration-exchange-service` and runs on `@univerjs-pro/collaboration-transport-node`.

```text
HTTP request
→ Transport authentication middleware (sets ctx.userID)
→ UniverExchangeEndpoint (route type, JSON fields, error codes)
→ UniverExchangeService (validation, ownership, middleware, tasks)
```

## Installation and registration

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

Register it after the File Endpoint, so that Transport disposes it first. The Endpoint does not dispose the Exchange Service.

| Option | Default |
| --- | --- |
| `routePrefix` | `/universer-api`; absolute, without a trailing slash |

## Routes

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `POST` | `{prefix}/exchange/{type}/import` | `{ fileID, outputType, options? }` | `{ error, taskID }` |
| `POST` | `{prefix}/exchange/{type}/export` | `{ unitID or jsonID, format, options? }` | `{ error, taskID }` |
| `GET` | `{prefix}/exchange/task/{taskID}` | | `{ error, taskID, status, import?, export? }` |

`{type}` is the `UniverType` number. With the default prefix these are the URLs `exchange-client` uses by default.

All three routes answer HTTP 200 and put the result in `error.code`. A task response has `status: "pending"` or `"done"` with `error.code = OK`, and `status: "failed"` with the failure code. `export.fileUrl` is always empty; clients get the download URL from the File sign-url route.

## Error codes

| Source | `error.code` |
| --- | --- |
| Invalid request, unsupported type, format or option; invalid file or snapshot | `INVALID_ARGUMENT` |
| Missing user | `UNAUTHENTICATED` |
| File, Unit or task not found | `NOT_FOUND` |
| Permission denied by the collaboration Service or File Service | `PERMISSION_DENIED` |
| `exchange-node` License errors | the `LICENSE_*` code with the same name |
| Anything else, including errors thrown by Exchange middleware | `INTERNAL_ERROR` |

`error.message` keeps the original message.
