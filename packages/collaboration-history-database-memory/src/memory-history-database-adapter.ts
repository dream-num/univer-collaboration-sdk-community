import type {
  AppendHistoryRecordResult,
  HistoryCreatorIndex,
  HistoryDatabaseContext,
  HistoryOrigin,
  HistoryRecord,
  HistoryRecordRange,
  IHistoryDatabaseAdapter,
  ListHistoryRecordsOptions,
  ListHistoryRecordsResult,
} from "@univerjs-pro/collaboration-history-service";

/**
 * An in-memory `IHistoryDatabaseAdapter`. Data is scoped to this instance and lost on process exit.
 *
 * Every method runs synchronously inside its `async` body, which gives each call the atomicity a
 * database implementation provides with a transaction. Returned records are copies.
 */
export class MemoryHistoryDatabaseAdapter implements IHistoryDatabaseAdapter {
  // Boundaries of each Unit in ascending start revision order; appends only ever add at the end.
  private readonly _records = new Map<string, HistoryRecord[]>();

  async getLatestRecord(_context: HistoryDatabaseContext, unitID: string): Promise<HistoryRecord | null> {
    const latest = this._records.get(unitID)?.at(-1);
    return latest ? { ...latest } : null;
  }

  async appendRecord(
    _context: HistoryDatabaseContext,
    record: HistoryRecord,
    options: { readonly expectedLatestStartRevision: number | null },
  ): Promise<AppendHistoryRecordResult> {
    validateRecord(record);
    const records = this._records.get(record.unitID) ?? [];
    const existing = records.find((candidate) => candidate.startRevision === record.startRevision);
    if (existing) {
      return { status: sameRecord(existing, record) ? "already-exists" : "conflict" };
    }
    const latest = records.at(-1)?.startRevision ?? null;
    if (latest !== options.expectedLatestStartRevision || record.startRevision <= (latest ?? 0)) {
      return { status: "conflict" };
    }
    records.push({ ...record });
    this._records.set(record.unitID, records);
    return { status: "appended" };
  }

  async listRecords(
    _context: HistoryDatabaseContext,
    unitID: string,
    options: ListHistoryRecordsOptions,
  ): Promise<ListHistoryRecordsResult> {
    const records = this._records.get(unitID) ?? [];
    const head = Math.min(options.throughRevision, (options.beforeRevision ?? Infinity) - 1);
    const users = new Set(options.userIDs ?? []);
    const page: HistoryRecordRange[] = [];
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index]!;
      if (record.startRevision > head) continue;
      if (options.origin && record.origin !== options.origin) continue;
      if (users.size > 0 && !users.has(record.userID)) continue;
      if (page.length === options.length) return { records: page, hasMore: true };
      // The successor is the next boundary of the Unit regardless of the page's filters.
      const successor = records[index + 1];
      page.push({
        record: { ...record },
        endRevision: Math.min(options.throughRevision, (successor?.startRevision ?? Infinity) - 1),
      });
    }
    return { records: page, hasMore: false };
  }

  async listCreators(
    _context: HistoryDatabaseContext,
    unitID: string,
    options: { readonly throughRevision: number },
  ): Promise<readonly HistoryCreatorIndex[]> {
    const creators = new Map<string, Set<HistoryOrigin>>();
    for (const record of this._records.get(unitID) ?? []) {
      if (record.startRevision > options.throughRevision) break;
      const origins = creators.get(record.userID) ?? new Set<HistoryOrigin>();
      origins.add(record.origin);
      creators.set(record.userID, origins);
    }
    return [...creators]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([userID, origins]) => ({ userID, origins: [...origins].sort((left, right) => left - right) }));
  }

  async dispose(): Promise<void> {
    this._records.clear();
  }
}

function validateRecord(record: HistoryRecord): void {
  if (
    !record.unitID ||
    !record.userID ||
    !Number.isSafeInteger(record.startRevision) ||
    record.startRevision < 1 ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0
  ) {
    throw new TypeError("History record is invalid");
  }
}

function sameRecord(left: HistoryRecord, right: HistoryRecord): boolean {
  return (
    left.userID === right.userID &&
    left.createdAt === right.createdAt &&
    left.origin === right.origin &&
    left.additionalFields === right.additionalFields
  );
}
