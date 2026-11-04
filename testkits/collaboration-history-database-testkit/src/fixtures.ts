import type { HistoryDatabaseContext, HistoryRecord } from "@univerjs-pro/collaboration-history-service";

/** A reader context; adapters receive it for logging and extension and never read it back. */
export function createHistoryDatabaseContext(): HistoryDatabaseContext {
  return { userID: "reader", customData: {}, request: {} };
}

/** A segment boundary for `unit-1` whose author, time and origin derive from the start revision. */
export function createHistoryRecord(startRevision: number, overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    unitID: "unit-1",
    startRevision,
    userID: `user-${startRevision % 3}`,
    createdAt: startRevision * 1000,
    origin: startRevision % 2 ? 1 : 2,
    ...overrides,
  };
}
