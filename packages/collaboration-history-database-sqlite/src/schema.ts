export const HISTORY_SCHEMA_COMPONENT = "history";
export const HISTORY_SCHEMA_VERSION = 2;

// Shared by the adapter and the v1 to v2 migration so a migrated database matches a fresh one exactly.
export const HISTORY_TABLE_SQL = `
  CREATE TABLE collaboration_history_records (
    unit_id TEXT NOT NULL,
    start_revision INTEGER NOT NULL CHECK (start_revision >= 1),
    user_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    origin INTEGER NOT NULL,
    additional_fields TEXT,
    PRIMARY KEY (unit_id, start_revision)
  );
`;

export const HISTORY_INDEX_SQL = `
  CREATE INDEX collaboration_history_origin_lookup
    ON collaboration_history_records(unit_id, origin, start_revision);
  CREATE INDEX collaboration_history_creator_lookup
    ON collaboration_history_records(unit_id, user_id, start_revision);
`;
