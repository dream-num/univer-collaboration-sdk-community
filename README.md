# Univer Collaboration SDK Community

English | [简体中文](./README.zh-CN.md)

Open-source packages of the Univer Collaboration SDK, licensed under Apache-2.0. They are published
to npm under the same names and versions as the rest of the SDK and work with the matching SDK
release.

The packages are developed in the Univer Collaboration SDK repository together with the closed-source
Service and Endpoint packages, and this repository receives their source at every SDK release. It is
the published, read-only copy: read it, build it, fork it, and report problems or propose changes
through issues and pull requests as described in [CONTRIBUTING.md](./CONTRIBUTING.md).

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

### File

| Package | Description |
| --- | --- |
| [`@univerjs-pro/collaboration-file-service`](./packages/collaboration-file-service/README.md) | File Service: metadata and content contracts, ownership rules, middleware and expiry cleanup |
| [`@univerjs-pro/collaboration-file-endpoint`](./packages/collaboration-file-endpoint/README.md) | HTTP routes the Univer frontend calls for uploads, downloads and import/export transfers |
| [`@univerjs-pro/collaboration-file-memory`](./packages/collaboration-file-memory/README.md) | In-process metadata adapter and blob store for tests and demos |
| [`@univerjs-pro/collaboration-file-database-sqlite`](./packages/collaboration-file-database-sqlite/README.md) | SQLite metadata adapter built on `libsql` |
| [`@univerjs-pro/collaboration-file-database-postgres`](./packages/collaboration-file-database-postgres/README.md) | PostgreSQL metadata adapter built on `node-postgres` |
| [`@univerjs-pro/collaboration-file-blob-local`](./packages/collaboration-file-blob-local/README.md) | Local directory blob store |
| [`@univerjs-pro/collaboration-file-blob-s3`](./packages/collaboration-file-blob-s3/README.md) | S3-compatible blob store with optional presigned direct links |

## Development

Requires Node.js 22 or later and pnpm 11.

```bash
pnpm install
pnpm check
pnpm test
```

PostgreSQL tests run when `UNIVER_COLLAB_POSTGRES_URL` points at a reachable server, for example
`postgres://localhost:5432/postgres`. Repository conventions are in [AGENTS.md](./AGENTS.md); how
changes reach this repository is in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Implementing your own adapter

Each SPI ships a testkit with the contract tests every implementation passes. Implement the
interface, run the contract against it, and read the matching package here as a reference.

| SPI | Testkit |
| --- | --- |
| `IDatabaseAdapter` | [`collaboration-database-testkit`](./testkits/collaboration-database-testkit/README.md) |
| `ICommentDatabaseAdapter` | [`collaboration-comment-database-testkit`](./testkits/collaboration-comment-database-testkit/README.md) |
| `IHistoryDatabaseAdapter` | [`collaboration-history-database-testkit`](./testkits/collaboration-history-database-testkit/README.md) |
| `IFileDatabaseAdapter` | [`collaboration-file-database-testkit`](./testkits/collaboration-file-database-testkit/README.md) |
| `IFileBlobStore` | [`collaboration-file-blob-testkit`](./testkits/collaboration-file-blob-testkit/README.md) |
