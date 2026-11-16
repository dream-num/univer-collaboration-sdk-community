# @univerjs-pro/collaboration-database-postgres-s3

[English](./README.md) | 简体中文

把 Sheet block 存放在 S3 兼容存储桶中的 PostgreSQL `IDatabaseAdapter`。Unit、changeset 和 snapshot 仍在 PostgreSQL 中，block 内容是对象。基于 [node-postgres](https://node-postgres.com/) 和 AWS SDK for JavaScript v3 构建。需要 Node.js 22 及以上、PostgreSQL 13 及以上。

使用 PostgreSQL 部署时推荐这个 Adapter。[`@univerjs-pro/collaboration-database-postgres`](../collaboration-database-postgres/README.zh-CN.md) 把 block 也放在 PostgreSQL 中，适合没有对象存储的部署。

## Sheet block

一个 Sheet snapshot 由两部分组成：

- **snapshot 记录**保存工作簿的结构：工作表、元数据和资源。
- **Sheet block** 保存单元格数据。每个工作表的单元格按分块保存，每个 block 按 ID 单独保存和读取。

大型工作簿的体积几乎都在 block 上。Service 默认每 50 个 revision 保存一次 snapshot，并按 ID 读取 block。

## 为什么把 block 放在 S3

block 体积大、写入一次、按 key 读取，这正是对象存储适合的数据。放在 PostgreSQL 中时，它的每个字节都要经过预写日志、副本和备份。

| | PostgreSQL | PostgreSQL + S3 |
| --- | --- | --- |
| block 内容 | `BYTEA` 行 | 对象 |
| 数据库体积 | 包含全部单元格数据 | 不含单元格数据 |
| WAL、复制和备份 | 包含每个 block | 只包含 block ID |
| 基础设施 | PostgreSQL | PostgreSQL 和一个存储桶 |

- **数据库保持小巧。** 数据库里只剩 Unit、changeset 和 snapshot 记录，工作簿变大后备份、恢复和副本依然很快。
- **大写入不经过数据库。** 保存大型 snapshot 时上传的是对象，预写日志和复制流只带 ID。
- **存储独立扩展。** block 的容量和成本取决于存储桶，不取决于数据库磁盘。
- **契约相同。** 它与 PostgreSQL Adapter 通过同一套 `IDatabaseAdapter` 契约测试。

## 创建 Adapter

```bash
pnpm add \
  @univerjs-pro/collaboration-service \
  @univerjs-pro/collaboration-database-postgres-s3 \
  @aws-sdk/client-s3 \
  pg
```

连接池和 S3 client 由应用持有。`create` 在空数据库中初始化 schema，对已有的 schema 做校验：

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { PostgresS3DatabaseAdapter } from '@univerjs-pro/collaboration-database-postgres-s3';
import { UniverCollabService } from '@univerjs-pro/collaboration-service';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = new S3Client({ region: process.env.S3_REGION });
const database = await PostgresS3DatabaseAdapter.create({
  pool,
  s3: { client, bucket: process.env.S3_BUCKET!, prefix: 'collaboration/blocks' },
});
const service = new UniverCollabService({ dbAdapter: database });

await service.dispose();
await pool.end();
client.destroy();
```

把 Adapter 作为 `dbAdapter` 传给 `UniverCollabService`。先 dispose Service，再结束连接池并销毁 client。

### `s3` 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `client` | 必填 | 所有对象请求使用的 `S3Client`。 |
| `bucket` | 必填 | 存放 block 的存储桶。 |
| `prefix` | 无 | 对象 key 前缀，首尾不带斜杠。 |
| `concurrency` | `8` | 一次 Adapter 调用同时发出的对象请求数上限，取值 1 到 64。 |

凭证需要对该存储桶有 `PutObject`、`GetObject`、`DeleteObject` 和 `ListBucket` 权限。

## 存储行为

- block 存放在 `{prefix}/{unitID}/{blockID}`，Unit ID 和 block ID 做百分号编码，内容为 MessagePack 对象。
- 表位于 `collaboration` schema：`units`、`snapshots`、`changesets`、`sheet_blocks` 和 `schema_versions`。`sheet_blocks` 是账本，Unit 在存储桶中的每个 block 对象对应一行，不保存内容；`snapshots.block_ids` 记录每个 snapshot 引用的 block。
- `schema_versions` 记录 `('core-s3', 1)`。`create` 打开该版本的 schema，并拒绝由 `@univerjs-pro/collaboration-database-postgres` 创建的数据库。
- Unit 已存储的 block 不会再次上传，因此一次 snapshot 只上传发生变化的 block。
- 读取 block 时先查账本，再取对象。
- block 在对象写入且其 snapshot 保存之后才可读。两步之间失败的保存可能留下无人引用的对象；同一 block 下次保存时会覆盖它们。
- 硬删除 Unit 时，在数据库变更提交之后删除其前缀下的全部对象。删除对象失败时，Unit 的删除仍然成功，该 Unit 的 `sheet_blocks` 行保留下来，表示清理尚未完成，再次硬删除该 Unit 会重试。
- 存储桶不要开启版本控制，或者配置生命周期规则清理非当前版本。

## 应用元数据

`UnitRecord.metadata` 和 `ChangesetRecord.metadata` 使用 `Record<string, unknown>`，只接受 JSON 值。
创建时保存 `record.metadata`，通过 `getUnit()` 和 `getChangesets()` 读取已保存的值。
`commitChangeset()` 必须接收完整的 `unitMetadata` 和 `changeset.metadata`，并与新 head
原子保存。metadata 的默认值和草稿由 Service 在每次提交前统一准备。保存 snapshot 不修改 metadata。

## S3 兼容服务

按所用服务配置 client：endpoint、region 和寻址方式。部分服务会拒绝新版 SDK 默认附加的请求校验和；对这类服务，在 client 上把 `requestChecksumCalculation` 和 `responseChecksumValidation` 设为 `'WHEN_REQUIRED'`。
