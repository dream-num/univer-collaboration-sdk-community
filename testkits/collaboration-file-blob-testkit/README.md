# @univerjs-pro/collaboration-file-blob-testkit

English | [简体中文](./README.zh-CN.md)

Contract tests for `IFileBlobStore` implementations of the Univer Collaboration SDK. Every store in
[univer-collaboration-sdk-community](https://github.com/dream-num/univer-collaboration-sdk-community)
passes this suite, and a store for your own object storage should too.

The testkit is not published to npm. It lives in this repository as a private workspace package:
depend on it with `workspace:*` from a package in this workspace, or copy its `src/` directory into
your project. It runs on Vitest.

```ts
import { fileBlobStoreContract } from '@univerjs-pro/collaboration-file-blob-testkit';
import { MyFileBlobStore } from './my-file-blob-store.js';

fileBlobStoreContract('MyStore', async () => {
  const store = new MyFileBlobStore(/* ... */);
  return {
    store,
    countObjects: () => store.countForTests(),
    dispose: () => store.dispose(),
  };
});
```

The factory runs once per test and returns a fresh, empty store. `countObjects` is optional; when
present, the suite also checks that a failed `put` leaves no partial object behind.

## Contract notes

The interface documentation in `@univerjs-pro/collaboration-file-service` is the contract. These
points are the ones implementations most often get wrong:

- `put` consumes a multi-chunk `AsyncIterable<Uint8Array>`, accepts empty content, reports the
  number of bytes actually written and gives different files different `blobKey`s. When the stream
  fails, `put` rejects and leaves no partial object.
- `open` fails with `FileError("FILE_NOT_FOUND")` for a missing key.
- `delete` treats a missing key as success.
- `signUrl` is optional. When it returns a link, the URL parses and `expiresAt` lies in the future.
