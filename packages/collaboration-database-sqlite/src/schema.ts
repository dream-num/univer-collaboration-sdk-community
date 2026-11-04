export const CORE_SCHEMA_COMPONENT = "core";
export const CORE_SCHEMA_VERSION = 3;

// Shared by the adapter and the v2 to v3 migration so a migrated database matches a fresh one exactly.
export const CORE_SCHEMA_V3_SQL = `
  CREATE TABLE collaboration_units (
    unit_id TEXT PRIMARY KEY NOT NULL,
    type INTEGER NOT NULL,
    head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
    creator_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    deleted_status TEXT CHECK (deleted_status IN ('soft', 'hard')),
    CHECK ((deleted_status IS NULL) = (deleted_at_ms IS NULL))
  );
  CREATE TABLE collaboration_snapshots (
    unit_id TEXT NOT NULL REFERENCES collaboration_units(unit_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    payload BLOB NOT NULL,
    PRIMARY KEY (unit_id, revision)
  );
  CREATE TABLE collaboration_changesets (
    unit_id TEXT NOT NULL REFERENCES collaboration_units(unit_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 2),
    base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
    sid TEXT NOT NULL,
    req_id INTEGER NOT NULL CHECK (req_id >= 1),
    created_at_ms INTEGER NOT NULL,
    payload BLOB NOT NULL,
    PRIMARY KEY (unit_id, revision),
    UNIQUE (unit_id, sid, req_id)
  );
  CREATE TABLE collaboration_sheet_blocks (
    unit_id TEXT NOT NULL REFERENCES collaboration_units(unit_id) ON DELETE CASCADE,
    block_id TEXT NOT NULL,
    payload BLOB NOT NULL,
    PRIMARY KEY (unit_id, block_id)
  );
`;
