# @univerjs-pro/collaboration-history-database-testkit

English | [简体中文](./README.zh-CN.md)

Contract tests and fixtures for `IHistoryDatabaseAdapter` implementations of the Univer
Collaboration SDK. Every adapter in
[univer-collaboration-sdk-community](https://github.com/dream-num/univer-collaboration-sdk-community)
passes this suite, and an adapter for your own storage should too.

The testkit is not published to npm. It lives in this repository as a private workspace package:
depend on it with `workspace:*` from a package in this workspace, or copy its `src/` directory into
your project. It runs on Vitest.

```ts
import { historyDatabaseAdapterContract } from '@univerjs-pro/collaboration-history-database-testkit';
import { MyHistoryDatabaseAdapter } from './my-history-database-adapter.js';

historyDatabaseAdapterContract('MyDatabase', async () => {
  const adapter = new MyHistoryDatabaseAdapter(/* ... */);
  return { adapter, dispose: () => adapter.dispose() };
});
```

The factory runs once per test and returns a fresh, empty adapter. `createHistoryRecord` and
`createHistoryDatabaseContext` build valid inputs for your own tests.

## Contract notes

The interface documentation in `@univerjs-pro/collaboration-history-service` is the contract. These
points are the ones implementations most often get wrong:

- A record is a segment boundary, not a copy of changesets. `appendRecord` compares the Unit's
  latest start revision with `expectedLatestStartRevision` and appends only when they match and the
  new start revision is greater. The identical record at an existing start revision returns
  `already-exists`; any other record there returns `conflict`.
- Records with an empty `unitID` or `userID`, a start revision below 1, or a non-integer or negative
  value fail with a `TypeError` and leave the database unchanged.
- `listRecords` returns boundaries newest first, at or below `min(throughRevision, beforeRevision - 1)`.
  `origin` (other than 0) and `userIDs` filter the page, while each `endRevision` comes from the
  Unit's next boundary regardless of filters, capped at `throughRevision`. `hasMore` reports whether
  another page exists.
- `origin` is stored and compared as an opaque integer; 0 or an omitted origin means no filter.
- `listCreators` returns the authors of boundaries at or below `throughRevision`, sorted by user ID,
  each with the sorted set of origins they used.
- Returned records are copies: mutating them never changes stored data.
