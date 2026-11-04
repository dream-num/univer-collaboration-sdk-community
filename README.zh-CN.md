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
对应的包作为参考。`IDatabaseAdapter` 见
[`collaboration-database-testkit`](./testkits/collaboration-database-testkit/README.md)，`ICommentDatabaseAdapter` 见
[`collaboration-comment-database-testkit`](./testkits/collaboration-comment-database-testkit/README.md)，`IHistoryDatabaseAdapter` 见
[`collaboration-history-database-testkit`](./testkits/collaboration-history-database-testkit/README.md)。
