export const SCHEMA_COMPONENT = "comment";
export const SCHEMA_VERSION = 1;

export const SCHEMA_VERSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS collaboration_schema_versions (
    component TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 1)
  );
`;

export const COMMENT_SCHEMA_SQL = `
  CREATE TABLE collaboration_comments (
    unit_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    reply_id TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    mentions_json TEXT NOT NULL,
    solved INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    generation TEXT NOT NULL,
    PRIMARY KEY (unit_id, reply_id)
  );
  CREATE INDEX collaboration_comments_thread_lookup
    ON collaboration_comments(unit_id, thread_id, created_at, reply_id);
`;
