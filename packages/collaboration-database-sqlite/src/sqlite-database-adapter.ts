import type { Buffer } from "node:buffer";
import { Decoder, Encoder } from "@msgpack/msgpack";
import Database from "libsql";
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
import { CORE_SCHEMA_COMPONENT, CORE_SCHEMA_V3_SQL, CORE_SCHEMA_VERSION } from "./schema.js";

interface UnitRow extends UnitRecord {
  readonly deletedStatus: "soft" | "hard" | null;
}

interface PayloadRow {
  readonly payload: ArrayBuffer | Buffer;
}

export interface SQLiteDatabaseAdapterOptions {
  /** SQLite filename or `:memory:`. The parent directory must already exist. */
  readonly filename: string;
  /** How long SQLite waits for another writer before reporting SQLITE_BUSY. Defaults to 5000. */
  readonly busyTimeoutMs?: number;
}

/**
 * SQLite implementation of the collaboration persistence contract, built on the synchronous
 * `libsql` API. Protocol objects are stored as MessagePack blobs.
 *
 * The constructor initializes an empty database and rejects a database whose core schema
 * version differs from the one this adapter writes; migrations are always explicit.
 */
export class SQLiteDatabaseAdapter implements IDatabaseAdapter {
  private readonly _database: Database.Database;
  private readonly _encoder = new Encoder({ ignoreUndefined: true });
  private readonly _decoder = new Decoder();
  private _disposed = false;

  private readonly _getUnit: Database.Statement;
  private readonly _getSnapshot: Database.Statement;
  private readonly _getSnapshotAtRevision: Database.Statement;
  private readonly _getSnapshotInfo: Database.Statement;
  private readonly _getSnapshotInfoAtRevision: Database.Statement;
  private readonly _getChangesets: Database.Statement;
  private readonly _getChangesetsInRange: Database.Statement;
  private readonly _getSheetBlock: Database.Statement;
  private readonly _insertUnit: Database.Statement;
  private readonly _insertChangeset: Database.Statement;
  private readonly _updateHeadRevision: Database.Statement;
  private readonly _upsertSnapshot: Database.Statement;
  private readonly _upsertSheetBlock: Database.Statement;
  private readonly _deleteSnapshots: Database.Statement;
  private readonly _deleteChangesets: Database.Statement;
  private readonly _deleteSheetBlocks: Database.Statement;
  private readonly _markSoftDeleted: Database.Statement;
  private readonly _markHardDeleted: Database.Statement;
  private readonly _markActive: Database.Statement;

  constructor(options: SQLiteDatabaseAdapterOptions) {
    if (!options.filename) {
      throw new CollabError("INVALID_REQUEST", "SQLite filename is required");
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    this._database = new Database(options.filename, { timeout: busyTimeoutMs });

    try {
      this._database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs};`);
      this._initializeSchema();

      this._getUnit = this._database.prepare(`
        SELECT unit_id AS unitID, type, head_revision AS headRevision,
          creator_id AS creatorID, created_at_ms AS createdAt, deleted_status AS deletedStatus
        FROM collaboration_units
        WHERE unit_id = ?
      `);

      // Writes guarantee snapshot revisions never exceed the head, so reads only check that the
      // Unit is active and pick the nearest revision through the primary key index.
      this._getSnapshot = this._database.prepare(`
        SELECT s.payload
        FROM collaboration_snapshots s
        JOIN collaboration_units u ON u.unit_id = s.unit_id
        WHERE s.unit_id = ? AND u.deleted_status IS NULL
        ORDER BY s.revision DESC
        LIMIT 1
      `);
      this._getSnapshotAtRevision = this._database.prepare(`
        SELECT s.payload
        FROM collaboration_snapshots s
        JOIN collaboration_units u ON u.unit_id = s.unit_id
        WHERE s.unit_id = ? AND u.deleted_status IS NULL AND s.revision <= ?
        ORDER BY s.revision DESC
        LIMIT 1
      `);
      this._getSnapshotInfo = this._database.prepare(`
        SELECT s.unit_id AS unitID, u.type, s.revision AS rev
        FROM collaboration_snapshots s
        JOIN collaboration_units u ON u.unit_id = s.unit_id
        WHERE s.unit_id = ? AND u.deleted_status IS NULL
        ORDER BY s.revision DESC
        LIMIT 1
      `);
      this._getSnapshotInfoAtRevision = this._database.prepare(`
        SELECT s.unit_id AS unitID, u.type, s.revision AS rev
        FROM collaboration_snapshots s
        JOIN collaboration_units u ON u.unit_id = s.unit_id
        WHERE s.unit_id = ? AND u.deleted_status IS NULL AND s.revision <= ?
        ORDER BY s.revision DESC
        LIMIT 1
      `);

      // LEFT JOIN distinguishes an inaccessible Unit (no rows) from an empty range (one null row).
      this._getChangesets = this._database.prepare(`
        SELECT c.payload
        FROM collaboration_units u
        LEFT JOIN collaboration_changesets c ON c.unit_id = u.unit_id AND c.revision > ?
        WHERE u.unit_id = ? AND u.deleted_status IS NULL
        ORDER BY c.revision ASC
      `);
      this._getChangesetsInRange = this._database.prepare(`
        SELECT c.payload
        FROM collaboration_units u
        LEFT JOIN collaboration_changesets c
          ON c.unit_id = u.unit_id AND c.revision > ? AND c.revision <= ?
        WHERE u.unit_id = ? AND u.deleted_status IS NULL
        ORDER BY c.revision ASC
      `);

      this._getSheetBlock = this._database.prepare(`
        SELECT b.payload
        FROM collaboration_sheet_blocks b
        JOIN collaboration_units u ON u.unit_id = b.unit_id
        WHERE b.unit_id = ? AND b.block_id = ? AND u.deleted_status IS NULL
      `);

      this._insertUnit = this._database.prepare(`
        INSERT INTO collaboration_units (unit_id, type, head_revision, creator_id, created_at_ms)
        VALUES (?, ?, 1, ?, ?)
      `);
      this._insertChangeset = this._database.prepare(`
        INSERT INTO collaboration_changesets
          (unit_id, revision, base_revision, sid, req_id, created_at_ms, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      this._updateHeadRevision = this._database.prepare(
        "UPDATE collaboration_units SET head_revision = ? WHERE unit_id = ?",
      );
      this._upsertSnapshot = this._database.prepare(`
        INSERT INTO collaboration_snapshots (unit_id, revision, payload) VALUES (?, ?, ?)
        ON CONFLICT (unit_id, revision) DO UPDATE SET payload = excluded.payload
      `);
      this._upsertSheetBlock = this._database.prepare(`
        INSERT INTO collaboration_sheet_blocks (unit_id, block_id, payload) VALUES (?, ?, ?)
        ON CONFLICT (unit_id, block_id) DO UPDATE SET payload = excluded.payload
      `);

      this._deleteSnapshots = this._database.prepare(
        "DELETE FROM collaboration_snapshots WHERE unit_id = ?",
      );
      this._deleteChangesets = this._database.prepare(
        "DELETE FROM collaboration_changesets WHERE unit_id = ?",
      );
      this._deleteSheetBlocks = this._database.prepare(
        "DELETE FROM collaboration_sheet_blocks WHERE unit_id = ?",
      );
      this._markSoftDeleted = this._database.prepare(
        "UPDATE collaboration_units SET deleted_at_ms = ?, deleted_status = 'soft' WHERE unit_id = ?",
      );
      this._markHardDeleted = this._database.prepare(
        "UPDATE collaboration_units SET deleted_at_ms = ?, deleted_status = 'hard' WHERE unit_id = ?",
      );
      this._markActive = this._database.prepare(
        "UPDATE collaboration_units SET deleted_at_ms = NULL, deleted_status = NULL WHERE unit_id = ?",
      );
    } catch (error) {
      this._database.close();
      throw error;
    }
  }

  async getUnit(_ctx: DatabaseContext, unitID: string): Promise<UnitRecord | null> {
    this._assertOpen();
    const unit = this._readUnit(unitID);
    return unit && unit.deletedStatus === null ? toUnitRecord(unit) : null;
  }

  /** Reads the latest snapshot, optionally bounded by the specified revision. */
  async getSnapshot(
    _ctx: DatabaseContext,
    unitID: string,
    options?: { readonly revision?: number },
  ): Promise<ISnapshot | null> {
    this._assertOpen();
    const revision = validateRevisionBound(options?.revision);
    const row = (
      revision === undefined
        ? this._getSnapshot.get(unitID)
        : this._getSnapshotAtRevision.get(unitID, revision)
    ) as PayloadRow | undefined;
    return row ? this._decode<ISnapshot>(row.payload) : null;
  }

  /** Reads metadata with the same selection rules as getSnapshot, without decoding the payload. */
  async getSnapshotInfo(
    _ctx: DatabaseContext,
    unitID: string,
    options?: { readonly revision?: number },
  ): Promise<SnapshotInfo | null> {
    this._assertOpen();
    const revision = validateRevisionBound(options?.revision);
    const row = (
      revision === undefined
        ? this._getSnapshotInfo.get(unitID)
        : this._getSnapshotInfoAtRevision.get(unitID, revision)
    ) as SnapshotInfo | undefined;
    return row ? { unitID: row.unitID, type: row.type, rev: row.rev } : null;
  }

  /** Reads changesets in (from, to], ordered by revision. */
  async getChangesets(
    _ctx: DatabaseContext,
    unitID: string,
    range: { readonly from: number; readonly to?: number },
  ): Promise<readonly IChangeset[] | null> {
    this._assertOpen();
    if (range.from < 0 || (range.to !== undefined && range.to < 0)) {
      throw new CollabError("INVALID_REQUEST", "Changeset range revisions cannot be negative");
    }

    const rows = (
      range.to === undefined
        ? this._getChangesets.all(range.from, unitID)
        : this._getChangesetsInRange.all(range.from, range.to, unitID)
    ) as { readonly payload: ArrayBuffer | Buffer | null }[];
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
    this._assertOpen();
    const row = this._getSheetBlock.get(unitID, blockID) as PayloadRow | undefined;
    return row ? this._decode<ISheetBlock>(row.payload) : null;
  }

  /** Atomically creates a Unit at revision 1 with its snapshot and blocks; an existing active Unit returns its record. */
  async createUnit(
    _ctx: DatabaseContext,
    input: CreateUnitDatabaseInput,
  ): Promise<CreateUnitDatabaseResult> {
    this._assertOpen();
    validateInitialUnit(input);
    const { record, snapshot, sheetBlocks = [] } = input;
    // Encoding before the transaction keeps serialization failures out of the write lock.
    const encodedSnapshot = this._encode(snapshot);
    const encodedBlocks = this._encodeBlocks(sheetBlocks);

    return this._database
      .transaction((): CreateUnitDatabaseResult => {
        const existing = this._readUnit(record.unitID);
        if (existing) {
          if (existing.deletedStatus !== null) {
            throw new CollabError("INVALID_REQUEST", "A deleted unit ID cannot be reused");
          }
          return { status: "already-exists", record: toUnitRecord(existing) };
        }

        this._insertUnit.run(record.unitID, record.type, record.creatorID, record.createdAt);
        this._writeSnapshot(record.unitID, 1, encodedSnapshot, encodedBlocks);
        return { status: "created", record: { ...record } };
      })
      .immediate();
  }

  /** Confirms the changeset when the stored head equals `revision - 1`; otherwise reports the actual head. */
  async commitChangeset(
    _ctx: SubmitDatabaseContext,
    input: CommitChangesetInput,
  ): Promise<CommitChangesetResult> {
    this._assertOpen();
    const { changeset } = input;

    return this._database
      .transaction((): CommitChangesetResult => {
        // The head check and both writes share one immediate transaction, which is the CAS.
        const unit = this._requireActiveUnit(changeset.unitID);
        if (unit.headRevision !== changeset.revision - 1) {
          return { status: "revision-mismatch", actualHeadRevision: unit.headRevision };
        }

        // The persisted time replaces any caller-provided value; the input object is left unchanged.
        const createdAt = Date.now();
        const committed: IChangeset = { ...changeset, createTime: Math.floor(createdAt / 1000) };
        this._insertChangeset.run(
          changeset.unitID,
          changeset.revision,
          changeset.baseRev,
          changeset.sid,
          changeset.reqId,
          createdAt,
          this._encode(committed),
        );
        this._updateHeadRevision.run(changeset.revision, changeset.unitID);
        return { status: "committed", changeset: committed, headRevision: changeset.revision };
      })
      .immediate();
  }

  /** Publishes a snapshot together with the blocks it references. */
  async saveSnapshot(_ctx: DatabaseContext, input: SaveSnapshotInput): Promise<void> {
    this._assertOpen();
    const { snapshot, sheetBlocks = [] } = input;
    const encodedSnapshot = this._encode(snapshot);
    const encodedBlocks = this._encodeBlocks(sheetBlocks);

    this._database
      .transaction(() => {
        const unit = this._requireActiveUnit(snapshot.unitID);
        if (snapshot.type !== unit.type || snapshot.rev < 1 || snapshot.rev > unit.headRevision) {
          throw new CollabError("INVALID_REQUEST", "Snapshot does not match the stored unit head");
        }
        this._writeSnapshot(snapshot.unitID, snapshot.rev, encodedSnapshot, encodedBlocks);
      })
      .immediate();
  }

  /** Deletes the whole batch or fails it; hard deletion keeps the Unit row as a permanent marker. */
  async deleteUnits(
    _ctx: DatabaseContext,
    input: DeleteUnitsDatabaseInput,
  ): Promise<DeleteUnitsDatabaseResult> {
    this._assertOpen();
    const { unitIDs } = input;
    if (unitIDs.length === 0) return { units: [] };

    return this._database
      .transaction((): DeleteUnitsDatabaseResult => {
        // Validate the entire batch first so a missing ID cannot leave earlier Units deleted.
        const units: DeleteUnitsDatabaseResult["units"] = unitIDs.map((unitID) => {
          const unit = this._readUnit(unitID);
          if (!unit || (unit.deletedStatus === "hard" && !input.hardDelete)) {
            throw new CollabError("UNIT_NOT_FOUND", "Cannot delete a missing unit");
          }
          return {
            unitID,
            status: input.hardDelete
              ? unit.deletedStatus === "hard" ? "already-hard-deleted" : "hard-deleted"
              : unit.deletedStatus === null ? "soft-deleted" : "already-soft-deleted",
          };
        });

        const deletedAt = Date.now();
        for (const unit of units) {
          if (unit.status === "hard-deleted") {
            this._deleteSnapshots.run(unit.unitID);
            this._deleteChangesets.run(unit.unitID);
            this._deleteSheetBlocks.run(unit.unitID);
            this._markHardDeleted.run(deletedAt, unit.unitID);
          } else if (unit.status === "soft-deleted") {
            this._markSoftDeleted.run(deletedAt, unit.unitID);
          }
        }
        return { units };
      })
      .immediate();
  }

  /** Recovers the whole batch or fails it; hard-deleted IDs cannot be recovered. */
  async recoverUnits(
    _ctx: DatabaseContext,
    input: RecoverUnitsDatabaseInput,
  ): Promise<RecoverUnitsDatabaseResult> {
    this._assertOpen();
    const { unitIDs } = input;
    if (unitIDs.length === 0) return { units: [] };

    return this._database
      .transaction((): RecoverUnitsDatabaseResult => {
        const units: RecoverUnitsDatabaseResult["units"] = unitIDs.map((unitID) => {
          const unit = this._readUnit(unitID);
          if (!unit) {
            throw new CollabError("UNIT_NOT_FOUND", "Cannot recover a missing unit");
          }
          if (unit.deletedStatus === "hard") {
            throw new CollabError("INVALID_REQUEST", "A hard-deleted unit cannot be recovered");
          }
          return { unitID, status: unit.deletedStatus === null ? "already-active" : "recovered" };
        });

        for (const unit of units) {
          if (unit.status === "recovered") this._markActive.run(unit.unitID);
        }
        return { units };
      })
      .immediate();
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._database.close();
  }

  private _initializeSchema(): void {
    this._database
      .transaction(() => {
        this._database.exec(`
          CREATE TABLE IF NOT EXISTS collaboration_schema_versions (
            component TEXT PRIMARY KEY,
            version INTEGER NOT NULL CHECK (version >= 1)
          );
        `);
        const version = this._readSchemaVersion();
        if (version === CORE_SCHEMA_VERSION) return;
        if (version !== undefined) throw unsupportedSchemaVersion(version);
        this._createSchema();
      })
      .immediate();
  }

  private _readSchemaVersion(): number | undefined {
    const row = this._database
      .prepare("SELECT version FROM collaboration_schema_versions WHERE component = ?")
      .get(CORE_SCHEMA_COMPONENT) as { version: number } | undefined;
    return row?.version;
  }

  private _createSchema(): void {
    this._database.exec(`
      ${CORE_SCHEMA_V3_SQL}
      INSERT INTO collaboration_schema_versions (component, version)
      VALUES ('${CORE_SCHEMA_COMPONENT}', ${CORE_SCHEMA_VERSION});
    `);
  }

  private _readUnit(unitID: string): UnitRow | undefined {
    return this._getUnit.get(unitID) as UnitRow | undefined;
  }

  private _requireActiveUnit(unitID: string): UnitRow {
    const unit = this._readUnit(unitID);
    if (!unit || unit.deletedStatus !== null) {
      throw new CollabError("UNIT_NOT_FOUND", "Unit is not active");
    }
    return unit;
  }

  private _writeSnapshot(
    unitID: string,
    revision: number,
    snapshot: Uint8Array,
    blocks: readonly { readonly id: string; readonly payload: Uint8Array }[],
  ): void {
    for (const block of blocks) {
      this._upsertSheetBlock.run(unitID, block.id, block.payload);
    }
    this._upsertSnapshot.run(unitID, revision, snapshot);
  }

  private _assertOpen(): void {
    if (this._disposed) {
      throw new CollabError("INTERNAL_ERROR", "SQLite Database Adapter is disposed");
    }
  }

  private _encode(value: IChangeset | ISnapshot | ISheetBlock): Uint8Array {
    return this._encoder.encode(value);
  }

  private _encodeBlocks(
    blocks: readonly ISheetBlock[],
  ): { readonly id: string; readonly payload: Uint8Array }[] {
    return blocks.map((block) => ({ id: block.id, payload: this._encode(block) }));
  }

  private _decode<T>(payload: ArrayBuffer | Buffer): T {
    // A plain byte view makes protocol binary fields decode as Uint8Array rather than Buffer.
    const bytes =
      payload instanceof ArrayBuffer
        ? new Uint8Array(payload)
        : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    return this._decoder.decode(bytes) as T;
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
  const remedy = version < CORE_SCHEMA_VERSION ? "run migrateSQLiteCore first" : "upgrade the adapter";
  return new CollabError(
    "INTERNAL_ERROR",
    `Core schema version ${version} is not supported by this adapter (expected ${CORE_SCHEMA_VERSION}); ${remedy}`,
  );
}

function toUnitRecord(row: UnitRow): UnitRecord {
  return {
    unitID: row.unitID,
    type: row.type,
    headRevision: row.headRevision,
    creatorID: row.creatorID,
    createdAt: row.createdAt,
  };
}
