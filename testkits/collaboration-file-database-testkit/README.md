# @univerjs-pro/collaboration-file-database-testkit

Contract tests for `IFileDatabaseAdapter` implementations of the Univer Collaboration SDK. Every
adapter in [univer-collaboration-sdk-community](https://github.com/dream-num/univer-collaboration-sdk-community)
passes this suite, and an adapter for your own storage should too.

```bash
pnpm add -D @univerjs-pro/collaboration-file-database-testkit vitest
```

```ts
import { fileDatabaseAdapterContract } from '@univerjs-pro/collaboration-file-database-testkit';
import { MyFileDatabaseAdapter } from './my-file-database-adapter.js';

fileDatabaseAdapterContract('MyDatabase', async () => {
  const adapter = await MyFileDatabaseAdapter.create(/* ... */);
  return { adapter, dispose: () => adapter.dispose() };
});
```

The factory runs once per test and returns a fresh, empty adapter.

## Contract notes

The interface documentation in `@univerjs-pro/collaboration-file-service` is the contract. These
points are the ones implementations most often get wrong:

- `create` stores every field of the `FileRecord` as given, including unknown `source` values, and
  fails with `FileError("INVALID_REQUEST")` for a duplicate `fileID` while keeping the first record.
- `get` and `delete` return `null` for a missing record. `delete` returns the removed record and
  the `blobKey` it released; one-to-one adapters always release the record's own key.
- `list` filters by `source`, optional `assign` and an exclusive `createdBefore`, orders by
  `(createdAt, fileID)` ascending and pages with an opaque cursor encoded from the last record of
  the page. The cursor stays valid when earlier records are deleted, an undecodable cursor fails
  with `FileError("INVALID_REQUEST")`, and `nextCursor` is `null` on the last page.
