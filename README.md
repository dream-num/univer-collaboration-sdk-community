# Univer Collaboration SDK Community

English | [简体中文](./README.zh-CN.md)

Open-source packages of the Univer Collaboration SDK, licensed under Apache-2.0. They are published
to npm under the same names and versions as the rest of the SDK and work with the matching SDK
release.

## Packages

### Collaboration database adapters

| Package | Description |
| --- | --- |
| [`@univerjs-pro/collaboration-database-memory`](./packages/collaboration-database-memory/README.md) | In-process adapter for tests and temporary services |
| [`@univerjs-pro/collaboration-database-sqlite`](./packages/collaboration-database-sqlite/README.md) | SQLite adapter built on `libsql` |
| [`@univerjs-pro/collaboration-database-postgres`](./packages/collaboration-database-postgres/README.md) | PostgreSQL adapter built on `node-postgres` |

### Thread Comment database adapters

| Package | Description |
| --- | --- |
| [`@univerjs-pro/collaboration-comment-database-memory`](./packages/collaboration-comment-database-memory/README.md) | In-process adapter for tests and temporary services |
| [`@univerjs-pro/collaboration-comment-database-sqlite`](./packages/collaboration-comment-database-sqlite/README.md) | SQLite adapter built on `libsql` |

### History database adapters

| Package | Description |
| --- | --- |
| [`@univerjs-pro/collaboration-history-database-memory`](./packages/collaboration-history-database-memory/README.md) | In-process adapter for tests and temporary services |
| [`@univerjs-pro/collaboration-history-database-sqlite`](./packages/collaboration-history-database-sqlite/README.md) | SQLite adapter built on `libsql` |

## Development

Requires Node.js 22 or later and pnpm 11.

```bash
pnpm install
pnpm check
pnpm test
```

PostgreSQL tests run when `UNIVER_COLLAB_POSTGRES_URL` points at a reachable server, for example
`postgres://localhost:5432/postgres`. Repository conventions are in [AGENTS.md](./AGENTS.md).

## Implementing your own adapter

Each SPI ships a testkit with the contract tests every implementation passes. Implement the
interface, run the contract against it, and read the matching package here as a reference. See
[`collaboration-database-testkit`](./testkits/collaboration-database-testkit/README.md) for
`IDatabaseAdapter` and [`collaboration-comment-database-testkit`](./testkits/collaboration-comment-database-testkit/README.md)
for `ICommentDatabaseAdapter`, and [`collaboration-history-database-testkit`](./testkits/collaboration-history-database-testkit/README.md)
for `IHistoryDatabaseAdapter`.
