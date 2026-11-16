import type { Pool } from "pg";
import type {
  AppendHistoryRecordResult, HistoryCreatorIndex, HistoryDatabaseContext, HistoryOrigin, HistoryRecord,
  IHistoryDatabaseAdapter, ListHistoryRecordsOptions, ListHistoryRecordsResult,
} from "@univerjs-pro/collaboration-history-service";
import { initializeSchema } from "./schema.js";
import { transaction } from "./transaction.js";

interface HistoryRow {
  unit_id: string;
  start_revision: string;
  user_id: string;
  created_at_ms: string;
  origin: HistoryOrigin;
  additional_fields: string | null;
}

const latestQuery = `SELECT * FROM collaboration.history_records
  WHERE unit_id = $1 ORDER BY start_revision DESC LIMIT 1`;

/** @public */
export interface PostgresHistoryDatabaseAdapterOptions {
  /** Application-owned connection pool. */
  readonly pool: Pool;
}

/** PostgreSQL storage for history segment boundaries. @public */
export class PostgresHistoryDatabaseAdapter implements IHistoryDatabaseAdapter {
  private constructor(private readonly _pool: Pool) {}

  /** Creates or validates the History schema before returning. */
  static async create({ pool }: PostgresHistoryDatabaseAdapterOptions): Promise<PostgresHistoryDatabaseAdapter> {
    await initializeSchema(pool);
    return new PostgresHistoryDatabaseAdapter(pool);
  }

  async getLatestRecord(_context: HistoryDatabaseContext, unitID: string): Promise<HistoryRecord | null> {
    const { rows } = await this._pool.query<HistoryRow>(latestQuery, [unitID]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async appendRecord(
    _context: HistoryDatabaseContext,
    record: HistoryRecord,
    options: { readonly expectedLatestStartRevision: number | null },
  ): Promise<AppendHistoryRecordResult> {
    validateRecord(record);
    return transaction(this._pool, async (client) => {
      // Serialize even the first append, when there is no row to lock.
      await client.query("SELECT pg_advisory_xact_lock(1, hashtext($1))", [record.unitID]);
      const existing = await client.query<HistoryRow>(
        "SELECT * FROM collaboration.history_records WHERE unit_id = $1 AND start_revision = $2",
        [record.unitID, record.startRevision],
      );
      const row = existing.rows[0];
      if (row) {
        const same = row.user_id === record.userID && Number(row.created_at_ms) === record.createdAt &&
          row.origin === record.origin && row.additional_fields === (record.additionalFields ?? null);
        return { status: same ? "already-exists" : "conflict" };
      }
      const { rows } = await client.query<HistoryRow>(latestQuery, [record.unitID]);
      const latest = rows[0] ? Number(rows[0].start_revision) : null;
      if (latest !== options.expectedLatestStartRevision || record.startRevision <= (latest ?? 0)) {
        return { status: "conflict" };
      }
      await client.query(
        `INSERT INTO collaboration.history_records
         (unit_id, start_revision, user_id, created_at_ms, origin, additional_fields)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [record.unitID, record.startRevision, record.userID, record.createdAt, record.origin, record.additionalFields],
      );
      return { status: "appended" };
    });
  }

  async listRecords(
    _context: HistoryDatabaseContext, unitID: string, options: ListHistoryRecordsOptions,
  ): Promise<ListHistoryRecordsResult> {
    // Look up the successor independently of the page's cursor and filters.
    const { rows } = await this._pool.query<HistoryRow & { end_revision: string }>(`
      SELECT r.*, LEAST($2::bigint, (
        SELECT n.start_revision - 1 FROM collaboration.history_records n
        WHERE n.unit_id = r.unit_id AND n.start_revision > r.start_revision
        ORDER BY n.start_revision LIMIT 1
      )) AS end_revision
      FROM collaboration.history_records r
      WHERE unit_id = $1 AND start_revision <= $2
        AND ($3::bigint IS NULL OR start_revision < $3)
        AND ($4::integer IS NULL OR origin = $4)
        AND ($5::text[] IS NULL OR user_id = ANY($5))
      ORDER BY start_revision DESC LIMIT $6
    `, [unitID, options.throughRevision, options.beforeRevision, options.origin || null,
      options.userIDs?.length ? options.userIDs : null, options.length + 1]);
    return {
      records: rows.slice(0, options.length).map(row => ({ record: toRecord(row), endRevision: Number(row.end_revision) })),
      hasMore: rows.length > options.length,
    };
  }

  async listCreators(
    _context: HistoryDatabaseContext, unitID: string, options: { readonly throughRevision: number },
  ): Promise<readonly HistoryCreatorIndex[]> {
    const { rows } = await this._pool.query<HistoryCreatorIndex>(
      `SELECT user_id AS "userID", array_agg(DISTINCT origin ORDER BY origin) AS origins
       FROM collaboration.history_records WHERE unit_id = $1 AND start_revision <= $2
       GROUP BY user_id ORDER BY user_id`, [unitID, options.throughRevision],
    );
    return rows;
  }

  /** The application owns the pool and closes it after use. */
  async dispose(): Promise<void> {}
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

function toRecord(row: HistoryRow): HistoryRecord {
  return {
    unitID: row.unit_id,
    startRevision: Number(row.start_revision),
    userID: row.user_id,
    createdAt: Number(row.created_at_ms),
    origin: row.origin,
    ...(row.additional_fields === null ? {} : { additionalFields: row.additional_fields }),
  };
}
