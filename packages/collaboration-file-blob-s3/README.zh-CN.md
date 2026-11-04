# @univerjs-pro/collaboration-file-blob-s3

[English](./README.md) | [简体中文](./README.zh-CN.md)

面向 `@univerjs-pro/collaboration-file-service` 的 S3 兼容 `IFileBlobStore`，可选签发预签名直链。
它使用应用持有的 `S3Client`。支持 Node.js 22 及以上。

## 安装与使用

```bash
pnpm add \
  @univerjs-pro/collaboration-file-service \
  @univerjs-pro/collaboration-file-blob-s3 \
  @aws-sdk/client-s3
```

```ts
// 服务端读写对象用，地址只需服务端能访问。
const client = new S3Client({ region: 'us-east-1', endpoint: 'http://minio:9000', forcePathStyle: true });
// 只用于签发直链，不发出任何请求。签名 URL 使用这里的 endpoint，所以必须是浏览器能访问的地址。
// 它必须指向与 `client` 相同的存储和桶，region 与寻址方式一致，凭证要有读取对象的权限（只读即可）。
// 服务端和浏览器能用同一个地址访问存储时，这里直接传 `client`。
const signer = new S3Client({ region: 'us-east-1', endpoint: 'https://files.example.com', forcePathStyle: true });

const blobStore = new S3FileBlobStore({
  client,
  bucket: 'univer-files',
  prefix: 'files',
  directUrl: { client: signer, expiresInSeconds: 3600 },
});
const fileService = new UniverFileService({ database, blobStore });
```

`@aws-sdk/client-s3` 是 peer dependency。store 不会销毁传入的 client。

| 选项 | 含义 |
| --- | --- |
| `client` | 读写对象 |
| `bucket` | 目标桶 |
| `prefix` | 对象保存在 `{prefix}/{fileID}`，不设前缀时为 `{fileID}`；不能以斜杠开头或结尾 |
| `directUrl.client` | 仅用于签名的 client，配置浏览器能访问的地址；不传 `directUrl` 时所有下载都走 File Endpoint 代理路由 |
| `directUrl.expiresInSeconds` | 签名 URL 的有效期，1 到 604800；默认 3600 |

## 行为

- 上传通过 `@aws-sdk/lib-storage` 分段上传流式写入，不需要事先知道内容长度。上传失败时会中止分段上传，不留下对象。
- 直链是预签名的 `GET` URL，和代理路由一样设置 `Content-Type` 与 `Content-Disposition: attachment`。
- 删除不存在的键视为成功。

## 桶配置

- **生命周期**：添加 `AbortIncompleteMultipartUpload` 规则，清理进程崩溃时中断的分段上传。
- **CORS**：使用直链时浏览器从桶的域名加载对象。允许应用域名的 `GET` 请求，并在 `ExposeHeaders` 中暴露
  `Content-Disposition`，客户端才能读到文件名。
- **S3 兼容服务**：新版 AWS SDK 默认发送 CRC 校验头，部分 S3 兼容服务不接受。请求因校验或 `Content-MD5`
  报错时，创建 client 时设置 `requestChecksumCalculation: 'WHEN_REQUIRED'`。
