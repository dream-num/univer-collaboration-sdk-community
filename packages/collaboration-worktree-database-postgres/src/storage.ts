import { decode, encode } from "@msgpack/msgpack";
import type { Pool, PoolClient } from "pg";
import type {
  WorktreeAggregateRecord, WorktreeStatus, WorktreeUnitMergeArtifact,
  WorktreeUnitRecord, WorktreeUnitSeed,
} from "@univerjs-pro/collaboration-worktree-service";

type Reader = Pool | PoolClient;

export function pack(value: unknown): Buffer {
  return Buffer.from(encode(value, { ignoreUndefined: true }));
}

export function unpack<T>(payload: Buffer): T {
  // Decode protocol byte fields as Uint8Array even though pg returns a Buffer.
  return decode(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)) as T;
}

interface UnitRow {
  unit_id: string;
  type: WorktreeUnitRecord["type"];
  source: WorktreeUnitRecord["source"];
  baseline_trunk_revision: string | null;
  draft_head_revision: string;
  ready_draft_head_revision: string | null;
  creator_id: string;
  created_at_ms: string;
  metadata: WorktreeUnitRecord["metadata"];
  removed: boolean;
  merge_result: NonNullable<WorktreeUnitRecord["mergeResult"]> | null;
}

// Seeds and merge artifacts can be large. Only fetch them on the dedicated read paths.
const unitColumns = `u.unit_id, u.type, u.source, u.baseline_trunk_revision, u.draft_head_revision,
  u.ready_draft_head_revision, u.creator_id, u.created_at_ms, u.metadata, u.removed, u.merge_result`;

function unitFromRow(worktreeID: string, row: UnitRow): WorktreeUnitRecord {
  return {
    worktreeID,
    unitID: row.unit_id,
    type: row.type,
    source: row.source,
    draftHeadRevision: Number(row.draft_head_revision),
    creatorID: row.creator_id,
    createdAt: Number(row.created_at_ms),
    metadata: row.metadata,
    ...(row.baseline_trunk_revision === null ? {} : { baselineTrunkRevision: Number(row.baseline_trunk_revision) }),
    ...(row.ready_draft_head_revision === null ? {} : { readyDraftHeadRevision: Number(row.ready_draft_head_revision) }),
    ...(row.removed ? { removed: true } : {}),
    ...(row.merge_result === null ? {} : { mergeResult: row.merge_result }),
  };
}

export async function getAggregate(db: Reader, worktreeID: string): Promise<WorktreeAggregateRecord | null> {
  // One statement gives status and ordered Units the same MVCC snapshot, including empty Worktrees.
  type AggregateRow = (UnitRow | { unit_id: null }) & { sid: string; status: WorktreeStatus };
  const { rows } = await db.query<AggregateRow>(
    `SELECT w.sid, w.status, ${unitColumns} FROM collaboration.worktrees w
     LEFT JOIN collaboration.worktree_units u USING (worktree_id)
     WHERE w.worktree_id = $1 ORDER BY u.unit_order`, [worktreeID],
  );
  if (!rows[0]) return null;
  return {
    worktree: { worktreeID, sid: rows[0].sid, status: rows[0].status },
    units: rows.flatMap(row => row.unit_id === null ? [] : [unitFromRow(worktreeID, row)]),
  };
}

export async function requireAggregate(db: PoolClient, id: string): Promise<WorktreeAggregateRecord> {
  const aggregate = await getAggregate(db, id);
  if (!aggregate) throw new Error("Worktree disappeared inside a write transaction");
  return aggregate;
}

export async function getUnit(db: Reader, id: string, unitID: string): Promise<WorktreeUnitRecord | null> {
  const { rows } = await db.query<UnitRow>(
    `SELECT ${unitColumns} FROM collaboration.worktree_units u WHERE worktree_id = $1 AND unit_id = $2`,
    [id, unitID],
  );
  return rows[0] ? unitFromRow(id, rows[0]) : null;
}

export async function getSeed(db: Reader, id: string, unitID: string): Promise<WorktreeUnitSeed | null> {
  const { rows } = await db.query<{ seed: Buffer | null }>(
    "SELECT seed FROM collaboration.worktree_units WHERE worktree_id = $1 AND unit_id = $2", [id, unitID],
  );
  return rows[0]?.seed ? unpack(rows[0].seed) : null;
}

export async function getArtifact(db: Reader, id: string, unitID: string): Promise<WorktreeUnitMergeArtifact | null> {
  const { rows } = await db.query<{ merge_artifact: Buffer | null }>(
    "SELECT merge_artifact FROM collaboration.worktree_units WHERE worktree_id = $1 AND unit_id = $2", [id, unitID],
  );
  return rows[0]?.merge_artifact ? unpack(rows[0].merge_artifact) : null;
}

export async function insertUnit(db: PoolClient, unit: WorktreeUnitRecord, seed?: Buffer): Promise<void> {
  await db.query(`
    INSERT INTO collaboration.worktree_units
      (worktree_id, unit_id, unit_order, type, source, baseline_trunk_revision, draft_head_revision,
       creator_id, created_at_ms, metadata, seed, removed)
    VALUES ($1, $2, (SELECT COALESCE(MAX(unit_order), -1) + 1 FROM collaboration.worktree_units WHERE worktree_id = $1),
            $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [unit.worktreeID, unit.unitID, unit.type, unit.source, unit.baselineTrunkRevision, unit.draftHeadRevision,
      unit.creatorID, unit.createdAt, JSON.stringify(unit.metadata), seed, unit.removed ?? false],
  );
}
