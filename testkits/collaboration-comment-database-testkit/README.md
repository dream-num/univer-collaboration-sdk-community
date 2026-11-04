# @univerjs-pro/collaboration-comment-database-testkit

Contract tests for `ICommentDatabaseAdapter` implementations of the Univer Collaboration SDK.
Every adapter in [univer-collaboration-sdk-community](https://github.com/dream-num/univer-collaboration-sdk-community)
passes this suite, and an adapter for your own storage should too.

```bash
pnpm add -D @univerjs-pro/collaboration-comment-database-testkit vitest
```

```ts
import { commentDatabaseAdapterContract } from '@univerjs-pro/collaboration-comment-database-testkit';
import { MyCommentDatabaseAdapter } from './my-comment-database-adapter.js';

commentDatabaseAdapterContract('MyDatabase', async () => {
  const adapter = new MyCommentDatabaseAdapter(/* ... */);
  return { adapter, dispose: () => adapter.dispose() };
});
```

The factory runs once per test and returns a fresh, empty adapter.

## Contract notes

The interface documentation in `@univerjs-pro/collaboration-comment-service` is the contract. These
points are the ones implementations most often get wrong:

- A root comment's `replyID` equals its `threadID`. `listThreads` returns roots before their replies
  and replies in creation order; an empty `threadIDs` lists the whole Unit, and unknown IDs are
  ignored.
- Replies and edits are accepted only while the thread is open; an edit must come from the author.
  The check and the write happen inside one atomic boundary, so a concurrent solve or delete never
  lets a stale write through.
- Every record carries a `generation` that is new on each creation. `deleteComment` succeeds only
  with the current generation, and deleting a root removes the whole thread.
- Returned records are copies: mutating them never changes stored data.
