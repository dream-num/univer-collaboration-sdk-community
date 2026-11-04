import { Buffer } from "node:buffer";
import { Decoder, Encoder } from "@msgpack/msgpack";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  CollabError,
  type CommitChangesetInput,
  type CommitChangesetResult,
  type CreateUnitDatabaseInput,
  type CreateUnitDatabaseResult,
  type DatabaseContext,
  type DeleteUnitsDatabaseInput,
  type DeleteUnitsDatabaseResult,
  type IDatabaseAdapter,
  type RecoverUnitsDatabaseInput,
  type RecoverUnitsDatabaseResult,
  type SaveSnapshotInput,
  type SnapshotInfo,
  type SubmitDatabaseContext,
  type UnitRecord,
} from "@univerjs-pro/collaboration-service";
import type { IChangeset, ISheetBlock, ISnapshot } from "@univerjs/protocol";

const SCHEMA_COMPONENT = "core";
const SCHEMA_VERSION = 1;

interface PayloadRow {
  readonly payload: Buffer;
}

// BIGINT columns arrive as strings from node-postgres.
interface UnitRecordRow extends Omit<UnitRecord, "createdAt"> {
  readonly createdAt: string | number;
}

interface UnitRow extends UnitRecordRow {
  readonly deletedStatus: "soft" | "hard" | null;
}

export interface PostgresDatabaseAdapterOptions {
  /** Connection pool owned by the application; the adapter never ends it. */
  readonly pool: Pool;
}

/**
 * PostgreSQL implementation of the collaboration persistence contract, built on `node-postgres`.
 * Protocol objects are stored as MessagePack `BYTEA` payloads.
 *
 * Create instances with {@link PostgresDatabaseAdapter.create}, which initializes an empty
 * `collaboration` schema and rejects one whose core version differs from the one this adapter writes.
 */
export class PostgresDatabaseAdapter implements IDatabaseAdapter {
  private readonly _encoder = new Encoder({ ignoreUndefined: true });
  private readonly _decoder = new Decoder();

  private constructor(private readonly _pool: Pool) {}

  /** Initializes or verifies the schema, then returns a ready adapter. */
  static async create(options: PostgresDatabaseAdapterOptions): Promise<PostgresDatabaseAdapter> {
    const adapter = new PostgresDatabaseAdapter(options.pool);
    await adapter._initializeSchema();
    return adapter;
  }

  async getUnit(_ctx: DatabaseContext, unitID: string): Promise<UnitRecord | null> {
    const { rows } = await this._query<UnitRecordRow>("get_unit", `
      SELECT unit_id AS "unitID", type, head_revision AS "headRevision",
        creator_id AS "creatorID", created_at_ms AS "createdAt"
      FROM collaboration.units
      WHERE unit_id = $1 AND deleted_status IS NULL
    `, [unitID]);
    return rows[0] ? toUnitRecord(rows[0]) : null;
  }

  /** Reads the latest snapshot, optionally bounded by the specified revision. */
  async getSnapshot(
    _ctx: DatabaseContext,
    unitID: string,
    options?: { readonly revision?: number },
  ): Promise<ISnapshot | null> {
    const revision = validateRevisionBound(options?.revision);
    const { rows } = revision === undefined
      ? await this._query<PayloadRow>("get_snapshot", `
        SELECT s.payload
        FROM collaboration.snapshots s
        JOIN collaboration.units u USING (unit_id)
        WHERE u.unit_id = $1 AND u.deleted_status IS NULL
        ORDER BY s.revision DESC
        LIMIT 1
      `, [unitID])
      : await this._query<PayloadRow>("get_snapshot_at_revision", `
        SELECT s.payload
        FROM collaboration.snapshots s
        JOIN collaboration.units u USING (unit_id)
        WHERE u.unit_id = $1 AND u.deleted_status IS NULL AND s.revision <= $2
        ORDER BY s.revision DESC
        LIMIT 1
      `, [unitID, revision]);
    return rows[0] ? this._decode<ISnapshot>(rows[0].payload) : null;
  }

  /** Reads metadata with the same selection rules as getSnapshot, without decoding the payload. */
  async getSnapshotInfo(
    _ctx: DatabaseContext,
    unitID: string,
    options?: { readonly revision?: number },
  ): Promise<SnapshotInfo | null> {
    const revision = validateRevisionBound(options?.revision);
    const { rows } = revision === undefined
      ? await this._query<SnapshotInfo>("get_snapshot_info", `
        SELECT s.unit_id AS "unitID", u.type, s.revision AS rev
        FROM collaboration.snapshots s
        JOIN collaboration.units u USING (unit_id)
        WHERE u.unit_id = $1 AND u.deleted_status IS NULL
        ORDER BY s.revision DESC
        LIMIT 1
      `, [unitID])
      : await this._query<SnapshotInfo>("get_snapshot_info_at_revision", `
        SELECT s.unit_id AS "unitID", u.type, s.revision AS rev
        FROM collaboration.snapshots s
        JOIN collaboration.units u USING (unit_id)
        WHERE u.unit_id = $1 AND u.deleted_status IS NULL AND s.revision <= $2
        ORDER BY s.revision DESC
        LIMIT 1
      `, [unitID, revision]);
    const row = rows[0];
    return row ? { unitID: row.unitID, type: row.type, rev: row.rev } : null;
  }

  /** Reads changesets in (from, to], ordered by revision. */
  async getChangesets(
    _ctx: DatabaseContext,
    unitID: string,
    range: { readonly from: number; readonly to?: number },
  ): Promise<readonly IChangeset[] | null> {
    if (range.from < 0 || (range.to !== undefined && range.to < 0)) {
      throw new CollabError("INVALID_REQUEST", "Changeset range revisions cannot be negative");
    }

    // LEFT JOIN distinguishes an inaccessible Unit (no rows) from an empty range (one null row).
    const { rows } = range.to === undefined
      ? await this._query<{ readonly payload: Buffer | null }>("get_changesets", `
        SELECT c.payload
        FROM collaboration.units u
        LEFT JOIN collaboration.changesets c ON c.unit_id = u.unit_id AND c.revision > $2
        WHERE u.unit_id = $1 AND u.deleted_status IS NULL
        ORDER BY c.revision
      `, [unitID, range.from])
      : await this._query<{ readonly payload: Buffer | null }>("get_changesets_in_range", `
        SELECT c.payload
        FROM collaboration.units u
        LEFT JOIN collaboration.changesets c
          ON c.unit_id = u.unit_id AND c.revision > $2 AND c.revision <= $3
        WHERE u.unit_id = $1 AND u.deleted_status IS NULL
        ORDER BY c.revision
      `, [unitID, range.from, range.to]);
    if (rows.length === 0) return null;

    const changesets: IChangeset[] = [];
    for (const row of rows) {
      if (row.payload !== null) changesets.push(this._decode<IChangeset>(row.payload));
    }
    return changesets;
  }

  async getSheetBlock(
    _ctx: DatabaseContext,
    unitID: string,
    blockID: string,
  ): Promise<ISheetBlock | null> {
    const { rows } = await this._query<PayloadRow>("get_sheet_block", `
      SELECT b.payload
      FROM collaboration.sheet_blocks b
      JOIN collaboration.units u USING (unit_id)
      WHERE u.unit_id = $1 AND u.deleted_status IS NULL AND b.block_id = $2
    `, [unitID, blockID]);
    return rows[0] ? this._decode<ISheetBlock>(rows[0].payload) : null;
  }

  /** Atomically creates a Unit at revision 1 with its snapshot and blocks; an existing active Unit returns its record. */
  async createUnit(
    _ctx: DatabaseContext,
    input: CreateUnitDatabaseInput,
  ): Promise<CreateUnitDatabaseResult> {
    validateInitialUnit(input);
    const { record, snapshot, sheetBlocks = [] } = input;
    const blocks = this._encodeBlocks(sheetBlocks);

    return this._transaction(async (client) => {
      // One statement inserts the Unit, its blocks and its snapshot, or nothing on conflict.
      const result = await this._query("create_unit", `
        WITH created AS (
          INSERT INTO collaboration.units (unit_id, type, head_revision, creator_id, created_at_ms)
          VALUES ($1, $2, 1, $6, $7)
          ON CONFLICT (unit_id) DO NOTHING
          RETURNING unit_id
        ), saved_blocks AS (
          INSERT INTO collaboration.sheet_blocks (unit_id, block_id, payload)
          SELECT u.unit_id, b.id, b.payload
          FROM created u
          CROSS JOIN unnest($4::text[], $5::bytea[]) AS b(id, payload)
        )
        INSERT INTO collaboration.snapshots (unit_id, revision, payload)
        SELECT unit_id, 1, $3 FROM created
      `, [
        record.unitID,
        record.type,
        this._encode(snapshot),
        blocks.ids,
        blocks.payloads,
        record.creatorID,
        record.createdAt,
      ], client);
      if (result.rowCount) return { status: "created", record: { ...record } };

      // After a conflict, read the row under a lock so a concurrent delete or recover cannot interleave.
      const [unit] = await this._lockUnits(client, [record.unitID]);
      if (!unit || unit.deletedStatus !== null) {
        throw new CollabError("INVALID_REQUEST", "A deleted unit ID cannot be reused");
      }
      return { status: "already-exists", record: toUnitRecord(unit) };
    });
  }

  /** Confirms the changeset when the stored head equals `revision - 1`; otherwise reports the actual head. */
  async commitChangeset(
    ctx: SubmitDatabaseContext,
    input: CommitChangesetInput,
  ): Promise<CommitChangesetResult> {
    const { changeset } = input;
    // The persisted time replaces any caller-provided value; the input object is left unchanged.
    const createdAt = Date.now();
    const committed: IChangeset = { ...changeset, createTime: Math.floor(createdAt / 1000) };

    // The UPDATE performs the CAS under a row lock; a failed history insert rolls back the head too.
    const result = await this._query("commit_changeset", `
      WITH updated_unit AS (
        UPDATE collaboration.units
        SET head_revision = $2
        WHERE unit_id = $1 AND deleted_status IS NULL AND head_revision = $2::integer - 1
        RETURNING unit_id, head_revision
      )
      INSERT INTO collaboration.changesets
        (unit_id, revision, base_revision, sid, req_id, created_at_ms, payload)
      SELECT unit_id, head_revision, $3, $4, $5, $6, $7 FROM updated_unit
      RETURNING revision
    `, [
      changeset.unitID,
      changeset.revision,
      changeset.baseRev,
      changeset.sid,
      changeset.reqId,
      createdAt,
      this._encode(committed),
    ]);
    if (result.rowCount) {
      return { status: "committed", changeset: committed, headRevision: changeset.revision };
    }

    // Read the head that won, using a fresh statement snapshot.
    const unit = await this.getUnit(ctx, changeset.unitID);
    if (!unit) throw new CollabError("UNIT_NOT_FOUND", "Unit is not active");
    return { status: "revision-mismatch", actualHeadRevision: unit.headRevision };
  }

  /** Publishes a snapshot together with the blocks it references. */
  async saveSnapshot(_ctx: DatabaseContext, input: SaveSnapshotInput): Promise<void> {
    const { snapshot, sheetBlocks = [] } = input;
    const blocks = this._encodeBlocks(sheetBlocks);
    // The locked Unit row is validated inside the statement; writes apply only when it passes.
    const { rows } = await this._query<{ deletedStatus: "soft" | "hard" | null; saved: boolean }>("save_snapshot", `
      WITH locked_unit AS MATERIALIZED (
        SELECT unit_id, type, head_revision, deleted_status
        FROM collaboration.units
        WHERE unit_id = $1
        FOR UPDATE
      ), valid_unit AS (
        SELECT unit_id FROM locked_unit
        WHERE deleted_status IS NULL AND type = $2 AND $3::integer BETWEEN 1 AND head_revision
      ), saved_blocks AS (
        INSERT INTO collaboration.sheet_blocks (unit_id, block_id, payload)
        SELECT u.unit_id, b.id, b.payload
        FROM valid_unit u
        CROSS JOIN unnest($5::text[], $6::bytea[]) AS b(id, payload)
        ON CONFLICT (unit_id, block_id) DO UPDATE SET payload = excluded.payload
      ), saved_snapshot AS (
        INSERT INTO collaboration.snapshots (unit_id, revision, payload)
        SELECT unit_id, $3, $4 FROM valid_unit
        ON CONFLICT (unit_id, revision) DO UPDATE SET payload = excluded.payload
        RETURNING revision
      )
      SELECT deleted_status AS "deletedStatus", EXISTS (SELECT 1 FROM saved_snapshot) AS saved
      FROM locked_unit
    `, [snapshot.unitID, snapshot.type, snapshot.rev, this._encode(snapshot), blocks.ids, blocks.payloads]);
    const unit = rows[0];
    if (!unit || unit.deletedStatus !== null) {
      throw new CollabError("UNIT_NOT_FOUND", "Unit is not active");
    }
    if (!unit.saved) {
      throw new CollabError("INVALID_REQUEST", "Snapshot does not match the stored unit head");
    }
  }

  /** Deletes the whole batch or fails it; hard deletion keeps the Unit row as a permanent marker. */
  async deleteUnits(
    _ctx: DatabaseContext,
    input: DeleteUnitsDatabaseInput,
  ): Promise<DeleteUnitsDatabaseResult> {
    const { unitIDs } = input;
    if (unitIDs.length === 0) return { units: [] };

    return this._transaction(async (client) => {
      const locked = await this._lockUnits(client, unitIDs);
      const units = locked.map((unit): DeleteUnitsDatabaseResult["units"][number] => {
        if (!unit || (unit.deletedStatus === "hard" && !input.hardDelete)) {
          throw new CollabError("UNIT_NOT_FOUND", "Cannot delete a missing unit");
        }
        return {
          unitID: unit.unitID,
          status: input.hardDelete
            ? unit.deletedStatus === "hard" ? "already-hard-deleted" : "hard-deleted"
            : unit.deletedStatus === "soft" ? "already-soft-deleted" : "soft-deleted",
        };
      });

      const deletedAt = Date.now();
      if (input.hardDelete) {
        await this._query("hard_delete_units", `
          WITH deleted_units AS (
            UPDATE collaboration.units
            SET deleted_at_ms = $2, deleted_status = 'hard'
            WHERE unit_id = ANY($1::text[]) AND deleted_status IS DISTINCT FROM 'hard'
            RETURNING unit_id
          ), removed_snapshots AS (
            DELETE FROM collaboration.snapshots WHERE unit_id IN (SELECT unit_id FROM deleted_units)
          ), removed_blocks AS (
            DELETE FROM collaboration.sheet_blocks WHERE unit_id IN (SELECT unit_id FROM deleted_units)
          )
          DELETE FROM collaboration.changesets WHERE unit_id IN (SELECT unit_id FROM deleted_units)
        `, [unitIDs, deletedAt], client);
      } else {
        await this._query("soft_delete_units", `
          UPDATE collaboration.units
          SET deleted_at_ms = $2, deleted_status = 'soft'
          WHERE unit_id = ANY($1::text[]) AND deleted_status IS NULL
        `, [unitIDs, deletedAt], client);
      }
      return { units };
    });
  }

  /** Recovers the whole batch or fails it; hard-deleted IDs cannot be recovered. */
  async recoverUnits(
    _ctx: DatabaseContext,
    input: RecoverUnitsDatabaseInput,
  ): Promise<RecoverUnitsDatabaseResult> {
    const { unitIDs } = input;
    if (unitIDs.length === 0) return { units: [] };

    return this._transaction(async (client) => {
      const locked = await this._lockUnits(client, unitIDs);
      const units = locked.map((unit): RecoverUnitsDatabaseResult["units"][number] => {
        if (!unit) throw new CollabError("UNIT_NOT_FOUND", "Cannot recover a missing unit");
        if (unit.deletedStatus === "hard") {
          throw new CollabError("INVALID_REQUEST", "A hard-deleted unit cannot be recovered");
        }
        return {
          unitID: unit.unitID,
          status: unit.deletedStatus === "soft" ? "recovered" : "already-active",
        };
      });

      await this._query("recover_units", `
        UPDATE collaboration.units SET deleted_at_ms = NULL, deleted_status = NULL
        WHERE unit_id = ANY($1::text[]) AND deleted_status = 'soft'
      `, [unitIDs], client);
      return { units };
    });
  }

  private async _initializeSchema(): Promise<void> {
    await this._transaction(async (client) => {
      await client.query(`
        CREATE SCHEMA IF NOT EXISTS collaboration;
        CREATE TABLE IF NOT EXISTS collaboration.schema_versions (
          component TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version >= 1)
        );
      `);
      const version = await this._readSchemaVersion(client);
      if (version === SCHEMA_VERSION) return;
      if (version !== undefined) throw unsupportedSchemaVersion(version);
      await this._createSchema(client);
    });
  }

  private async _readSchemaVersion(client: PoolClient): Promise<number | undefined> {
    const { rows } = await client.query<{ version: number }>(
      `SELECT version FROM collaboration.schema_versions WHERE component = $1`,
      [SCHEMA_COMPONENT],
    );
    return rows[0]?.version;
  }

  private async _createSchema(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE collaboration.units (
        unit_id TEXT PRIMARY KEY,
        type INTEGER NOT NULL,
        head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
        creator_id TEXT NOT NULL,
        created_at_ms BIGINT NOT NULL,
        deleted_at_ms BIGINT,
        deleted_status TEXT CHECK (deleted_status IN ('soft', 'hard')),
        CHECK ((deleted_status IS NULL) = (deleted_at_ms IS NULL))
      );
      CREATE TABLE collaboration.snapshots (
        unit_id TEXT NOT NULL REFERENCES collaboration.units(unit_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        payload BYTEA NOT NULL,
        PRIMARY KEY (unit_id, revision)
      );
      CREATE TABLE collaboration.changesets (
        unit_id TEXT NOT NULL REFERENCES collaboration.units(unit_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 2),
        base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
        sid TEXT NOT NULL,
        req_id INTEGER NOT NULL CHECK (req_id >= 1),
        created_at_ms BIGINT NOT NULL,
        payload BYTEA NOT NULL,
        PRIMARY KEY (unit_id, revision),
        UNIQUE (unit_id, sid, req_id)
      );
      CREATE TABLE collaboration.sheet_blocks (
        unit_id TEXT NOT NULL REFERENCES collaboration.units(unit_id) ON DELETE CASCADE,
        block_id TEXT NOT NULL,
        payload BYTEA NOT NULL,
        PRIMARY KEY (unit_id, block_id)
      );
      INSERT INTO collaboration.schema_versions (component, version)
      VALUES ('${SCHEMA_COMPONENT}', ${SCHEMA_VERSION});
    `);
  }

  private async _transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this._pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error("Rollback failed");
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  private async _lockUnits(
    client: PoolClient,
    unitIDs: readonly string[],
  ): Promise<(UnitRow | undefined)[]> {
    // Locks rows in unit_id order so batches with different input orders cannot deadlock.
    const { rows } = await this._query<UnitRow>("lock_units", `
      SELECT unit_id AS "unitID", type, head_revision AS "headRevision",
        creator_id AS "creatorID", created_at_ms AS "createdAt", deleted_status AS "deletedStatus"
      FROM collaboration.units
      WHERE unit_id = ANY($1::text[])
      ORDER BY unit_id
      FOR UPDATE
    `, [unitIDs], client);
    // Returns rows in the input order, with undefined for missing Units.
    const units = new Map(rows.map((unit) => [unit.unitID, unit]));
    return unitIDs.map((unitID) => units.get(unitID));
  }

  private _query<R extends QueryResultRow = QueryResultRow>(
    name: string,
    text: string,
    values: unknown[],
    client?: PoolClient,
  ): Promise<QueryResult<R>> {
    return (client ?? this._pool).query<R>({ name, text, values });
  }

  private _encode(value: IChangeset | ISnapshot | ISheetBlock): Buffer {
    const bytes = this._encoder.encode(value);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private _decode<T>(payload: Buffer): T {
    // A plain byte view makes protocol binary fields decode as Uint8Array rather than Buffer.
    const bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    return this._decoder.decode(bytes) as T;
  }

  private _encodeBlocks(sheetBlocks: readonly ISheetBlock[]): { ids: string[]; payloads: Buffer[] } {
    const ids: string[] = [];
    const payloads: Buffer[] = [];
    // The last block wins for a duplicate ID, matching sequential upserts.
    const blocks = new Map(sheetBlocks.map((block) => [block.id, block]));
    for (const block of blocks.values()) {
      ids.push(block.id);
      payloads.push(this._encode(block));
    }
    return { ids, payloads };
  }
}

function validateInitialUnit({ record, snapshot }: CreateUnitDatabaseInput): void {
  if (
    record.headRevision !== 1 ||
    snapshot.rev !== 1 ||
    snapshot.unitID !== record.unitID ||
    snapshot.type !== record.type
  ) {
    throw new CollabError("INVALID_REQUEST", "Initial record and snapshot must match at revision 1");
  }
  if (
    typeof record.creatorID !== "string" ||
    record.creatorID.length === 0 ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0
  ) {
    throw new CollabError(
      "INVALID_REQUEST",
      "Unit creation requires creatorID and createdAt in Unix milliseconds",
    );
  }
}

function validateRevisionBound(revision: number | undefined): number | undefined {
  if (revision !== undefined && revision < 0) {
    throw new CollabError("INVALID_REQUEST", "Snapshot revision cannot be negative");
  }
  return revision;
}

function unsupportedSchemaVersion(version: number): CollabError {
  return new CollabError(
    "INTERNAL_ERROR",
    `Core schema version ${version} is not supported by this adapter (expected ${SCHEMA_VERSION}); migrate the database explicitly first`,
  );
}

function toUnitRecord(unit: UnitRecordRow): UnitRecord {
  return {
    unitID: unit.unitID,
    type: unit.type,
    headRevision: unit.headRevision,
    creatorID: unit.creatorID,
    createdAt: Number(unit.createdAt),
  };
}
