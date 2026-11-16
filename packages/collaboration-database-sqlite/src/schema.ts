export const CORE_SCHEMA_COMPONENT = "core";
export const CORE_SCHEMA_VERSION = 4;

export const SCHEMA_VERSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS collaboration_schema_versions (
    component TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 1)
  );
`;

export const CORE_SCHEMA_SQL = `
  CREATE TABLE collaboration_units (
    unit_id TEXT PRIMARY KEY NOT NULL,
    type INTEGER NOT NULL,
    head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
    creator_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    deleted_status TEXT CHECK (deleted_status IN ('soft', 'hard')),
    metadata TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(metadata)),
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
    metadata TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(metadata)),
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
