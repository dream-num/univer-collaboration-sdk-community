# @univerjs-pro/collaboration-database-testkit

English | [简体中文](./README.zh-CN.md)

Contract tests and fixtures for `IDatabaseAdapter` implementations of the Univer Collaboration SDK.
Every adapter in [univer-collaboration-sdk-community](https://github.com/dream-num/univer-collaboration-sdk-community)
passes this suite, and an adapter for your own storage should too.

The testkit is not published to npm. It lives in this repository as a private workspace package:
depend on it with `workspace:*` from a package in this workspace, or copy its `src/` directory into
your project. It runs on Vitest.

```ts
import { databaseAdapterContract } from '@univerjs-pro/collaboration-database-testkit';
import { MyDatabaseAdapter } from './my-database-adapter.js';

databaseAdapterContract('MyDatabase', async () => {
  const adapter = await MyDatabaseAdapter.create(/* ... */);
  return { adapter, dispose: () => adapter.dispose() };
});
```

The factory runs once per test and returns a fresh, empty adapter. `createUnitRecord`,
`createSnapshot`, `createChangeset`, `createSheetBlock` and `createDatabaseContext` build valid
protocol objects for your own tests.

## Contract notes

The interface documentation in `@univerjs-pro/collaboration-service` is the contract. These points
are the ones implementations most often get wrong:

- `createUnit` persists `record.creatorID` and `record.createdAt` as given and validates them: a
  non-empty string and a non-negative safe integer. Invalid values fail with `INVALID_REQUEST` and
  leave the database unchanged.
- `commitChangeset` checks the head, writes the changeset and updates the head inside one atomic
  boundary. The adapter assigns `createTime` as the persistence time in Unix seconds, leaves the
  input object unchanged and returns the changeset it stored.
- `deleteUnits` and `recoverUnits` receive `unitIDs` that the Service guarantees to be non-empty,
  free of empty strings and free of duplicates. A batch succeeds or fails as a whole.
- `getChangesets` treats `to: 0` as an explicit upper bound and returns `[]`; only an omitted `to`
  is unbounded. An invisible Unit returns `null`, an empty range returns `[]`.
- After a hard delete the Unit ID stays as a permanent marker: `createUnit` and `recoverUnits`
  fail with `INVALID_REQUEST`, and a repeated hard delete returns `already-hard-deleted`.
