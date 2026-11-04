# Univer Collaboration SDK Community

[English](./README.md) | [简体中文](./README.zh-CN.md)

Univer Collaboration SDK 的开源部分，采用 Apache-2.0 许可。这些包以与 SDK 其余部分相同的名称和
版本号发布到 npm，与同版本的 SDK 配合使用。

## 包

### 协同数据库适配器

| 包 | 说明 |
| --- | --- |
| [`@univerjs-pro/collaboration-database-memory`](./packages/collaboration-database-memory/README.zh-CN.md) | 进程内适配器，用于测试和临时服务 |
| [`@univerjs-pro/collaboration-database-sqlite`](./packages/collaboration-database-sqlite/README.zh-CN.md) | 基于 `libsql` 的 SQLite 适配器 |
| [`@univerjs-pro/collaboration-database-postgres`](./packages/collaboration-database-postgres/README.zh-CN.md) | 基于 `node-postgres` 的 PostgreSQL 适配器 |

### Thread Comment 数据库适配器

| 包 | 说明 |
| --- | --- |
| [`@univerjs-pro/collaboration-comment-database-memory`](./packages/collaboration-comment-database-memory/README.zh-CN.md) | 进程内适配器，用于测试和临时服务 |
| [`@univerjs-pro/collaboration-comment-database-sqlite`](./packages/collaboration-comment-database-sqlite/README.zh-CN.md) | 基于 `libsql` 的 SQLite 适配器 |

### History 数据库适配器

| 包 | 说明 |
| --- | --- |
| [`@univerjs-pro/collaboration-history-database-memory`](./packages/collaboration-history-database-memory/README.zh-CN.md) | 进程内适配器，用于测试和临时服务 |
| [`@univerjs-pro/collaboration-history-database-sqlite`](./packages/collaboration-history-database-sqlite/README.zh-CN.md) | 基于 `libsql` 的 SQLite 适配器 |

### File

| 包 | 说明 |
| --- | --- |
| [`@univerjs-pro/collaboration-file-service`](./packages/collaboration-file-service/README.zh-CN.md) | File Service：元数据与内容契约、归属规则、middleware 和过期清理 |
| [`@univerjs-pro/collaboration-file-memory`](./packages/collaboration-file-memory/README.zh-CN.md) | 进程内元数据适配器与 blob store，用于测试和演示 |
| [`@univerjs-pro/collaboration-file-database-sqlite`](./packages/collaboration-file-database-sqlite/README.zh-CN.md) | 基于 `libsql` 的 SQLite 元数据适配器 |
| [`@univerjs-pro/collaboration-file-database-postgres`](./packages/collaboration-file-database-postgres/README.zh-CN.md) | 基于 `node-postgres` 的 PostgreSQL 元数据适配器 |
| [`@univerjs-pro/collaboration-file-blob-local`](./packages/collaboration-file-blob-local/README.zh-CN.md) | 本地目录 blob store |
| [`@univerjs-pro/collaboration-file-blob-s3`](./packages/collaboration-file-blob-s3/README.zh-CN.md) | S3 兼容 blob store，可选预签名直链 |

## 开发

需要 Node.js 22 及以上和 pnpm 11。

```bash
pnpm install
pnpm check
pnpm test
```

PostgreSQL 测试在 `UNIVER_COLLAB_POSTGRES_URL` 指向可连接的服务器时运行，例如
`postgres://localhost:5432/postgres`。仓库约定见 [AGENTS.md](./AGENTS.md)。

## 实现自己的适配器

每个 SPI 都配有 testkit，包含所有实现都要通过的契约测试。实现接口，用契约测试验证，并以本仓库中
对应的包作为参考。

| SPI | Testkit |
| --- | --- |
| `IDatabaseAdapter` | [`collaboration-database-testkit`](./testkits/collaboration-database-testkit/README.md) |
| `ICommentDatabaseAdapter` | [`collaboration-comment-database-testkit`](./testkits/collaboration-comment-database-testkit/README.md) |
| `IHistoryDatabaseAdapter` | [`collaboration-history-database-testkit`](./testkits/collaboration-history-database-testkit/README.md) |
| `IFileDatabaseAdapter` | [`collaboration-file-database-testkit`](./testkits/collaboration-file-database-testkit/README.md) |
| `IFileBlobStore` | [`collaboration-file-blob-testkit`](./testkits/collaboration-file-blob-testkit/README.md) |
