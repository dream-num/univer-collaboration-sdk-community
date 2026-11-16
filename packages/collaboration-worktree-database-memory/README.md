# @univerjs-pro/collaboration-worktree-database-memory

English | [简体中文](./README.zh-CN.md)

An in-process `IWorktreeDatabaseAdapter` for tests, local development, and temporary Worktree data.

## Installation and usage

```bash
pnpm add \
  @univerjs-pro/collaboration-worktree-service \
  @univerjs-pro/collaboration-worktree-database-memory
```

```ts
const worktreeDatabase = new MemoryWorktreeDatabaseAdapter();
const worktreeService = new UniverCollabWorktreeService({
  trunk: {
    service: collabService,
    dbAdapter: trunkDatabase,
  },
  dbAdapter: worktreeDatabase,
});

await worktreeService.dispose();
await worktreeDatabase.dispose();
```

## Storage contract

It implements Worktree state transitions, draft revision CAS, and per-Unit merge-result contracts. Draft submission idempotency is resolved by Worktree Service from continuous history.

`setUnitRemoved` atomically updates reversible draft intent. Removed Units reject draft commits; terminal removal merge results prevent later restoration.

Draft Unit records contain application `metadata`; confirmed draft changesets are `ChangesetRecord`
values with their own `metadata`. `commitDraftChangeset` requires complete `unitMetadata` and
`changeset.metadata` objects from the Service and atomically saves both with the draft head.

## Limitations

All Worktree data is lost when the process exits, and state is not shared between Node.js processes. Use SQLite or another persistent Adapter for persistent production data.
