export const SCHEMA_COMPONENT = "file";
export const SCHEMA_VERSION = 1;

export const SCHEMA_VERSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS collaboration_schema_versions (
    component TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 1)
  );
`;

// The two source indexes serve cleanup (by source) and listing a Unit's files (by source and assign);
// both end with (created_at, file_id) for keyset paging. No query uses the blob_key index yet: it is in
// version 1 so content sharing needs no schema migration, and it stays non-unique because shared
// content means several rows with one blob_key.
export const FILE_SCHEMA_SQL = `
  CREATE TABLE collaboration_files (
    file_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    source INTEGER NOT NULL,
    assign TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX collaboration_files_source_created
    ON collaboration_files(source, created_at, file_id);
  CREATE INDEX collaboration_files_source_assign_created
    ON collaboration_files(source, assign, created_at, file_id);
  CREATE INDEX collaboration_files_blob_key
    ON collaboration_files(blob_key);
`;
