import { Buffer } from "node:buffer";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Decoder, Encoder } from "@msgpack/msgpack";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  CollabError,
  type ChangesetMetadata,
  type ChangesetRecord,
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
  type UnitMetadata,
  type UnitRecord,
} from "@univerjs-pro/collaboration-service";
import type { IChangeset, ISheetBlock, ISnapshot } from "@univerjs/protocol";

import { initializeSchema } from "./schema.js";
import { transaction } from "./transaction.js";

const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 64;

interface PayloadRow {
  readonly payload: Buffer;
}

type ChangesetRow =
  | { readonly payload: Buffer; readonly metadata: ChangesetMetadata }
  | { readonly payload: null; readonly metadata: null };

interface SnapshotTargetRow {
  readonly type: number;
  readonly headRevision: number;
  readonly deletedStatus: "soft" | "hard" | null;
  readonly storedBlockIDs: string[];
}

// BIGINT columns arrive as strings from node-postgres.
interface UnitRecordRow extends Omit<UnitRecord, "createdAt"> {
  readonly createdAt: string | number;
}

interface UnitRow extends UnitRecordRow {
  readonly deletedStatus: "soft" | "hard" | null;
}

/** @public */
export interface PostgresS3BlockStorageOptions {
  /** Application-owned client used for every object request. The adapter never destroys it. */
  readonly client: S3Client;
  readonly bucket: string;
  /**
   * Object key prefix. Blocks are stored at `{prefix}/{unitID}/{blockID}`, or `{unitID}/{blockID}`
   * when omitted; the Unit and block IDs are percent-encoded.
   */
  readonly prefix?: string;
  /** Maximum number of object requests one adapter call runs at a time. Defaults to 8. */
  readonly concurrency?: number;
}

/** @public */
export interface PostgresS3DatabaseAdapterOptions {
  /** Connection pool owned by the application; the adapter never ends it. */
  readonly pool: Pool;
  /** Where Sheet blocks are stored. */
  readonly s3: PostgresS3BlockStorageOptions;
}

/**
 * Collaboration persistence on PostgreSQL with Sheet blocks stored in an S3-compatible bucket.
 * Units, changesets and snapshots are stored in PostgreSQL as MessagePack `BYTEA` payloads, together
 * with a ledger of the block objects each Unit has in the bucket; the block contents are S3 objects.
 *
 * Create instances with {@link PostgresS3DatabaseAdapter.create}, which initializes an empty
 * `collaboration` schema and rejects one this adapter did not create.
 * @public
 */
export class PostgresS3DatabaseAdapter implements IDatabaseAdapter {
  private readonly _encoder = new Encoder({ ignoreUndefined: true });
  private readonly _decoder = new Decoder();
  private readonly _pool: Pool;
  private readonly _client: S3Client;
  private readonly _bucket: string;
  private readonly _prefix: string;
  private readonly _concurrency: number;

  private constructor(options: PostgresS3DatabaseAdapterOptions) {
    const { pool, s3 } = options;
    if (!pool) throw new TypeError("PostgresS3DatabaseAdapter requires a pool");
    if (!s3?.client) throw new TypeError("PostgresS3DatabaseAdapter requires an S3 client");
    if (!s3.bucket) throw new TypeError("PostgresS3DatabaseAdapter requires a bucket");
    const prefix = s3.prefix ?? "";
    if (prefix.startsWith("/") || prefix.endsWith("/")) {
      throw new TypeError("prefix must not start or end with a slash");
    }
    const concurrency = s3.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
      throw new TypeError(`concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
    }
    this._pool = pool;
    this._client = s3.client;
    this._bucket = s3.bucket;
    this._prefix = prefix;
    this._concurrency = concurrency;
  }

  /** Initializes or verifies the schema, then returns a ready adapter. */
  static async create(options: PostgresS3DatabaseAdapterOptions): Promise<PostgresS3DatabaseAdapter> {
    const adapter = new PostgresS3DatabaseAdapter(options);
    await initializeSchema(adapter._pool);
    return adapter;
  }

  async getUnit(_ctx: DatabaseContext, unitID: string): Promise<UnitRecord | null> {
    const { rows } = await this._query<UnitRecordRow>("get_unit", `
      SELECT unit_id AS "unitID", type, head_revision AS "headRevision",
        creator_id AS "creatorID", created_at_ms AS "createdAt", metadata
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

  /** Reads snapshot info with the same selection rules as getSnapshot, without decoding the payload. */
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
  ): Promise<readonly ChangesetRecord[] | null> {
    if (range.from < 0 || (range.to !== undefined && range.to < 0)) {
      throw new CollabError("INVALID_REQUEST", "Changeset range revisions cannot be negative");
    }

    // LEFT JOIN distinguishes an inaccessible Unit (no rows) from an empty range (one null row).
    const { rows } = range.to === undefined
      ? await this._query<ChangesetRow>("get_changesets", `
        SELECT c.payload, c.metadata
        FROM collaboration.units u
        LEFT JOIN collaboration.changesets c ON c.unit_id = u.unit_id AND c.revision > $2
        WHERE u.unit_id = $1 AND u.deleted_status IS NULL
        ORDER BY c.revision
      `, [unitID, range.from])
      : await this._query<ChangesetRow>("get_changesets_in_range", `
        SELECT c.payload, c.metadata
        FROM collaboration.units u
        LEFT JOIN collaboration.changesets c
          ON c.unit_id = u.unit_id AND c.revision > $2 AND c.revision <= $3
        WHERE u.unit_id = $1 AND u.deleted_status IS NULL
        ORDER BY c.revision
      `, [unitID, range.from, range.to]);
    if (rows.length === 0) return null;

    const changesets: ChangesetRecord[] = [];
    for (const row of rows) {
      if (row.payload !== null) {
        changesets.push(this._decodeChangeset(row.payload, row.metadata));
      }
    }
    return changesets;
  }

  async getSheetBlock(
    _ctx: DatabaseContext,
    unitID: string,
    blockID: string,
  ): Promise<ISheetBlock | null> {
    // The ledger decides whether the block exists: an object without a referenced row is not published.
    const { rowCount } = await this._query("get_sheet_block", `
      SELECT 1
      FROM collaboration.sheet_blocks b
      JOIN collaboration.units u USING (unit_id)
      WHERE u.unit_id = $1 AND u.deleted_status IS NULL
        AND b.block_id = $2 AND b.unreferenced_at_ms IS NULL
    `, [unitID, blockID]);
    if (!rowCount) return null;

    let bytes: Uint8Array | undefined;
    try {
      const object = await this._client.send(
        new GetObjectCommand({ Bucket: this._bucket, Key: this._blockKey(unitID, blockID) }),
      );
      bytes = await object.Body?.transformToByteArray();
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }
    if (!bytes) {
      throw new CollabError("INTERNAL_ERROR", "The object of a stored sheet block is missing");
    }
    return this._decoder.decode(bytes) as ISheetBlock;
  }

  /** Atomically creates a Unit at revision 1 with its snapshot and blocks; an existing active Unit returns its record. */
  async createUnit(
    _ctx: DatabaseContext,
    input: CreateUnitDatabaseInput,
  ): Promise<CreateUnitDatabaseResult> {
    validateInitialUnit(input);
    const metadata = JSON.stringify(input.record.metadata);
    const { record, snapshot, sheetBlocks: blocks = [] } = input;

    return transaction(this._pool, async (client) => {
      // The Unit row claims the ID first. Until this transaction ends, another creator of the same
      // ID waits on the row, so only the creator that owns the ID uploads and an existing Unit's
      // objects are never overwritten.
      const claimed = await this._query("create_unit", `
        INSERT INTO collaboration.units (unit_id, type, head_revision, creator_id, created_at_ms, metadata)
        VALUES ($1, $2, 1, $3, $4, $5::jsonb)
        ON CONFLICT (unit_id) DO NOTHING
      `, [record.unitID, record.type, record.creatorID, record.createdAt, metadata], client);
      if (claimed.rowCount) {
        // Objects are written before the rows that publish them; a failure rolls the Unit back.
        await this._putBlocks(record.unitID, blocks);
        await this._query("create_unit_snapshot", `
          WITH saved_blocks AS (
            INSERT INTO collaboration.sheet_blocks (unit_id, block_id)
            SELECT $1, b.id FROM unnest($3::text[]) AS b(id)
          )
          INSERT INTO collaboration.snapshots (unit_id, revision, payload, block_ids)
          VALUES ($1, 1, $2, $3::text[])
        `, [record.unitID, this._encode(snapshot), blocks.map((block) => block.id)], client);
        return { status: "created", record: { ...record, metadata: JSON.parse(metadata) as UnitMetadata } };
      }

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
    const { metadata, ...protocolChangeset } = changeset;
    const payload = this._encode({
      ...protocolChangeset,
      createTime: Math.floor(createdAt / 1000),
    });

    // The UPDATE performs the CAS under a row lock; a failed history insert rolls back the head too.
    const result = await this._query<{ readonly metadata: ChangesetMetadata }>("commit_changeset", `
      WITH updated_unit AS (
        UPDATE collaboration.units
        SET head_revision = $2, metadata = $8::jsonb
        WHERE unit_id = $1 AND deleted_status IS NULL AND head_revision = $2::integer - 1
        RETURNING unit_id, head_revision
      )
      INSERT INTO collaboration.changesets
        (unit_id, revision, base_revision, sid, req_id, created_at_ms, payload, metadata)
      SELECT unit_id, head_revision, $3, $4, $5, $6, $7, $9::jsonb FROM updated_unit
      RETURNING metadata
    `, [
      changeset.unitID,
      changeset.revision,
      changeset.baseRev,
      changeset.sid,
      changeset.reqId,
      createdAt,
      payload,
      JSON.stringify(input.unitMetadata),
      JSON.stringify(metadata),
    ]);
    if (result.rowCount) {
      return {
        status: "committed",
        changeset: this._decodeChangeset(payload, result.rows[0]!.metadata),
        headRevision: changeset.revision,
      };
    }

    // Read the head that won, using a fresh statement snapshot.
    const unit = await this.getUnit(ctx, changeset.unitID);
    if (!unit) throw new CollabError("UNIT_NOT_FOUND", "Unit is not active");
    return { status: "revision-mismatch", actualHeadRevision: unit.headRevision };
  }

  /** Publishes a snapshot together with the blocks it references. */
  async saveSnapshot(_ctx: DatabaseContext, input: SaveSnapshotInput): Promise<void> {
    const { snapshot, sheetBlocks = [] } = input;
    const missing = await this._missingBlocks(snapshot, sheetBlocks);
    // Objects are written before the rows that publish them, so a published block is always readable.
    // A failure after this point leaves objects without rows; the next save of the block overwrites them.
    await this._putBlocks(snapshot.unitID, missing);
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
        -- An uploaded block is referenced again, whatever its row said before.
        INSERT INTO collaboration.sheet_blocks (unit_id, block_id)
        SELECT u.unit_id, b.id
        FROM valid_unit u
        CROSS JOIN unnest($5::text[]) AS b(id)
        ON CONFLICT (unit_id, block_id) DO UPDATE SET unreferenced_at_ms = NULL
      ), saved_snapshot AS (
        INSERT INTO collaboration.snapshots (unit_id, revision, payload, block_ids)
        SELECT unit_id, $3, $4, $6::text[] FROM valid_unit
        ON CONFLICT (unit_id, revision)
          DO UPDATE SET payload = excluded.payload, block_ids = excluded.block_ids
        RETURNING revision
      )
      SELECT deleted_status AS "deletedStatus", EXISTS (SELECT 1 FROM saved_snapshot) AS saved
      FROM locked_unit
    `, [
      snapshot.unitID,
      snapshot.type,
      snapshot.rev,
      this._encode(snapshot),
      missing.map((block) => block.id),
      sheetBlocks.map((block) => block.id),
    ]);
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

    const result = await transaction(this._pool, async (client) => {
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
            SET deleted_at_ms = $2, deleted_status = 'hard', metadata = '{}'::jsonb
            WHERE unit_id = ANY($1::text[]) AND deleted_status IS DISTINCT FROM 'hard'
            RETURNING unit_id
          ), removed_snapshots AS (
            DELETE FROM collaboration.snapshots WHERE unit_id IN (SELECT unit_id FROM deleted_units)
          ), unreferenced_blocks AS (
            -- The ledger rows outlive the snapshots: they are removed once the objects are.
            UPDATE collaboration.sheet_blocks
            SET unreferenced_at_ms = $2
            WHERE unit_id IN (SELECT unit_id FROM deleted_units) AND unreferenced_at_ms IS NULL
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

    // The Units are gone for good once the transaction commits, so their objects can follow. A Unit
    // already hard-deleted is purged again: an earlier attempt may have failed halfway.
    if (input.hardDelete) {
      for (const unitID of new Set(unitIDs)) await this._purgeUnitBlocks(unitID);
    }
    return result;
  }

  /** Recovers the whole batch or fails it; hard-deleted IDs cannot be recovered. */
  async recoverUnits(
    _ctx: DatabaseContext,
    input: RecoverUnitsDatabaseInput,
  ): Promise<RecoverUnitsDatabaseResult> {
    const { unitIDs } = input;
    if (unitIDs.length === 0) return { units: [] };

    return transaction(this._pool, async (client) => {
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

  private async _lockUnits(
    client: PoolClient,
    unitIDs: readonly string[],
  ): Promise<(UnitRow | undefined)[]> {
    // Locks rows in unit_id order so batches with different input orders cannot deadlock.
    const { rows } = await this._query<UnitRow>("lock_units", `
      SELECT unit_id AS "unitID", type, head_revision AS "headRevision",
        creator_id AS "creatorID", created_at_ms AS "createdAt", metadata, deleted_status AS "deletedStatus"
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

  private _decodeChangeset(payload: Buffer, metadata: ChangesetMetadata): ChangesetRecord {
    return { ...this._decode<IChangeset>(payload), metadata };
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

  // A block ID identifies its content, so blocks the Unit already references are not uploaded again.
  // The Unit is validated here as well as in the save statement: uploading for a Unit that is
  // deleted or cannot take this snapshot would only leave objects nothing references.
  private async _missingBlocks(snapshot: ISnapshot, blocks: readonly ISheetBlock[]): Promise<readonly ISheetBlock[]> {
    if (blocks.length === 0) return blocks;
    const { rows } = await this._query<SnapshotTargetRow>("get_snapshot_target", `
      SELECT u.type, u.head_revision AS "headRevision", u.deleted_status AS "deletedStatus",
        ARRAY(
          SELECT b.block_id FROM collaboration.sheet_blocks b
          WHERE b.unit_id = u.unit_id AND b.block_id = ANY($2::text[]) AND b.unreferenced_at_ms IS NULL
        ) AS "storedBlockIDs"
      FROM collaboration.units u
      WHERE u.unit_id = $1
    `, [snapshot.unitID, blocks.map((block) => block.id)]);
    const unit = rows[0];
    if (!unit || unit.deletedStatus !== null) {
      throw new CollabError("UNIT_NOT_FOUND", "Unit is not active");
    }
    if (unit.type !== snapshot.type || !(snapshot.rev >= 1 && snapshot.rev <= unit.headRevision)) {
      throw new CollabError("INVALID_REQUEST", "Snapshot does not match the stored unit head");
    }
    if (unit.storedBlockIDs.length === 0) return blocks;
    const stored = new Set(unit.storedBlockIDs);
    return blocks.filter((block) => !stored.has(block.id));
  }

  private _unitPrefix(unitID: string): string {
    const unit = `${encodeURIComponent(unitID)}/`;
    return this._prefix ? `${this._prefix}/${unit}` : unit;
  }

  private _blockKey(unitID: string, blockID: string): string {
    return `${this._unitPrefix(unitID)}${encodeURIComponent(blockID)}`;
  }

  private async _putBlocks(unitID: string, blocks: readonly ISheetBlock[]): Promise<void> {
    await forEachLimited(blocks, this._concurrency, async (block) => {
      await this._client.send(new PutObjectCommand({
        Bucket: this._bucket,
        Key: this._blockKey(unitID, block.id),
        Body: this._encode(block),
        ContentType: "application/vnd.msgpack",
      }));
    });
  }

  // Everything under the Unit's prefix goes, including objects a failed save left without a row. The
  // ledger rows go last: while they remain, the purge is known to be unfinished and a later hard
  // delete of the Unit retries it. Objects are deleted one request each: batch deletion is not
  // supported by every compatible store.
  private async _purgeUnitBlocks(unitID: string): Promise<void> {
    try {
      let failed = false;
      let token: string | undefined;
      do {
        const page = await this._client.send(new ListObjectsV2Command({
          Bucket: this._bucket,
          Prefix: this._unitPrefix(unitID),
          ContinuationToken: token,
        }));
        const keys = (page.Contents ?? []).flatMap((item) => (item.Key ? [item.Key] : []));
        await forEachLimited(keys, this._concurrency, async (Key) => {
          try {
            await this._client.send(new DeleteObjectCommand({ Bucket: this._bucket, Key }));
          } catch {
            failed = true;
          }
        });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      if (failed) return;
      await this._query("remove_purged_blocks", `
        DELETE FROM collaboration.sheet_blocks b
        USING collaboration.units u
        WHERE b.unit_id = $1 AND u.unit_id = b.unit_id AND u.deleted_status = 'hard'
      `, [unitID]);
    } catch {
      // The Unit is already deleted; its remaining ledger rows record that the purge is unfinished.
    }
  }
}

async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  });
  await Promise.all(workers);
}

function isMissingObject(error: unknown): boolean {
  const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return failure?.name === "NoSuchKey" || failure?.$metadata?.httpStatusCode === 404;
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

function toUnitRecord(unit: UnitRecordRow): UnitRecord {
  return {
    unitID: unit.unitID,
    type: unit.type,
    headRevision: unit.headRevision,
    creatorID: unit.creatorID,
    createdAt: Number(unit.createdAt),
    metadata: unit.metadata,
  };
}
