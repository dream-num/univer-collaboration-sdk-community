import type {
  HistoryRecord,
  ListHistoryRecordsOptions,
  ListHistoryRecordsResult,
} from "@univerjs-pro/collaboration-history-service";

// The selection rules of listRecords, written as plainly as possible so the contract can compare
// an adapter against them for many combinations of filters and cursors.
export function selectReferencePage(
  records: readonly HistoryRecord[],
  options: ListHistoryRecordsOptions,
): ListHistoryRecordsResult {
  const ascending = [...records].sort((left, right) => left.startRevision - right.startRevision);
  const head = Math.min(options.throughRevision, (options.beforeRevision ?? Infinity) - 1);
  const users = new Set(options.userIDs ?? []);
  const candidates = ascending
    .filter((record) => record.startRevision <= head)
    .filter((record) => !options.origin || record.origin === options.origin)
    .filter((record) => users.size === 0 || users.has(record.userID))
    .reverse();
  return {
    records: candidates.slice(0, options.length).map((record) => {
      // The successor is the next boundary of the Unit regardless of the page's filters.
      const successor = ascending.find((candidate) => candidate.startRevision > record.startRevision);
      return {
        record: { ...record },
        endRevision: Math.min(options.throughRevision, (successor?.startRevision ?? Infinity) - 1),
      };
    }),
    hasMore: candidates.length > options.length,
  };
}
