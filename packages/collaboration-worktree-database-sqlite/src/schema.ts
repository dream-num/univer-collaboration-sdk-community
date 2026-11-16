export const SCHEMA_COMPONENT = "worktree";
export const SCHEMA_VERSION = 4;

export const SCHEMA_VERSIONS_SQL = `
  CREATE TABLE collaboration_schema_versions (
    component TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 1)
  );
`;

export const WORKTREE_SCHEMA_SQL = `
  CREATE TABLE collaboration_worktrees (
    worktree_id TEXT PRIMARY KEY,
    sid TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('draft', 'ready', 'merging', 'merged', 'discarded'))
  );

  CREATE TABLE collaboration_worktree_units (
    removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
    worktree_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    unit_order INTEGER NOT NULL CHECK (unit_order >= 0),
    type INTEGER NOT NULL,
    source TEXT NOT NULL
      CHECK (source IN ('trunk', 'worktree')),
    baseline_trunk_revision INTEGER NOT NULL
      CHECK (baseline_trunk_revision >= 1),
    draft_head_revision INTEGER NOT NULL
      CHECK (draft_head_revision >= baseline_trunk_revision),
    ready_draft_head_revision INTEGER,
    merge_result_json TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(metadata_json)),
    creator_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (worktree_id, unit_id),
    UNIQUE (worktree_id, unit_order),
    FOREIGN KEY (worktree_id)
      REFERENCES collaboration_worktrees(worktree_id) ON DELETE CASCADE
  );

  CREATE TABLE collaboration_worktree_changesets (
    worktree_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 2),
    base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
    sid TEXT NOT NULL,
    req_id INTEGER NOT NULL CHECK (req_id >= 1),
    created_at_ms INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(metadata_json)),
    PRIMARY KEY (worktree_id, unit_id, revision),
    UNIQUE (worktree_id, unit_id, sid, req_id),
    FOREIGN KEY (worktree_id, unit_id)
      REFERENCES collaboration_worktree_units(worktree_id, unit_id)
      ON DELETE CASCADE
  );

  CREATE INDEX collaboration_worktree_changesets_revision
    ON collaboration_worktree_changesets(
      worktree_id, unit_id, revision ASC
    );

  CREATE TABLE collaboration_worktree_unit_seeds (
    worktree_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    sheet_blocks_json TEXT,
    resources_json TEXT,
    PRIMARY KEY (worktree_id, unit_id),
    FOREIGN KEY (worktree_id, unit_id)
      REFERENCES collaboration_worktree_units(worktree_id, unit_id)
      ON DELETE CASCADE
  );

  CREATE TABLE collaboration_worktree_unit_merge_artifacts (
    worktree_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    ready_draft_head_revision INTEGER NOT NULL
      CHECK (ready_draft_head_revision >= 1),
    snapshot_json TEXT NOT NULL,
    sheet_blocks_json TEXT,
    resources_json TEXT,
    PRIMARY KEY (worktree_id, unit_id),
    FOREIGN KEY (worktree_id, unit_id)
      REFERENCES collaboration_worktree_units(worktree_id, unit_id)
      ON DELETE CASCADE
  );
`;
