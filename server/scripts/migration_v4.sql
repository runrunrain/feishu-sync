-- migration_v4.sql
-- feishu-sync v0.2.0 structure-align Phase B (B1)
--
-- Applies on top of v3 (cloud-link-coverage). Adds:
--   1. documents.watched_root_url TEXT  (which watchedRoot owns this row)
--   2. local_dirs table                 (local directory ↔ feishu node mapping)
--
-- Design constraints (inherited from v3):
--   - Additive only: never drop / never rewrite existing columns.
--   - ALTERs guarded by PRAGMA table_info at runtime so re-runs are no-ops.
--   - Indexes that reference the new column are created AFTER the ALTER
--     to avoid the "no such column" startup failure on legacy databases
--     (v3 lesson: CREATE INDEX IF NOT EXISTS in the base DDL breaks when
--     the column it references was added via ALTER and hasn't run yet).
--   - Schema version is recorded in schema_migrations ledger.
--
-- Backfill:
--   watched_root_url is intentionally left NULL by this migration. The
--   runtime backfill happens in IndexScanner.scanKnowledgeBase (B3) which
--   has the knowledgeBaseRoot context required to map local_md_path →
--   watchedRoot. The SQL migration must stay context-free.

-- ===========================================================================
-- §1. documents.watched_root_url
-- ===========================================================================

ALTER TABLE documents ADD COLUMN watched_root_url TEXT;

-- Index for "filter by watchedRoot" queries (MappingService.getTree cloud view).
-- Created here (not in the base DDL) so it only runs after the ALTER succeeds.
CREATE INDEX IF NOT EXISTS idx_documents_watched_root ON documents(watched_root_url);

-- ===========================================================================
-- §2. local_dirs table (S3 explicit mapping)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS localDirs (
  -- Local directory relative path (POSIX-style, relative to knowledgeBaseRoot).
  -- Acts as the natural primary key: one row per directory.
  local_path TEXT PRIMARY KEY,

  -- Display title (directory basename without suffix decoration).
  title TEXT NOT NULL DEFAULT '',

  -- Parent directory path (POSIX-style). NULL for top-level directories.
  parent_path TEXT,

  -- feishu wiki node URL of the watchedRoot that owns this directory.
  -- NULL means the directory is mounted/local-only (no cloud tracking).
  watched_root_url TEXT,

  -- feishu wiki node token this directory maps to. NULL when the directory
  -- is purely a local grouping (e.g. csv-data / .assets / images).
  mapped_wiki_node_token TEXT,

  -- feishu object token (the docx/sheet obj under the wiki node).
  -- Useful for jumping straight to the document body.
  mapped_obj_token TEXT,

  -- Cloud correspondence classification, mirrors documents.cloud_match
  -- semantics. 'local_only' marks directories with no feishu counterpart
  -- (attachments / images / orphan csv-data).
  cloud_match TEXT NOT NULL DEFAULT 'unknown'
                    CHECK(cloud_match IN ('synced','restricted','unknown','local_only')),

  -- Auto-detected by IndexScanner (1) vs user-pinned via UI (0).
  auto_detected INTEGER NOT NULL DEFAULT 0,

  -- Free-form sort order within the same parent (decision 5 style).
  sort_order INTEGER,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_local_dirs_watched_root  ON localDirs(watched_root_url);
CREATE INDEX IF NOT EXISTS idx_local_dirs_wiki_node     ON localDirs(mapped_wiki_node_token);
CREATE INDEX IF NOT EXISTS idx_local_dirs_cloud_match   ON localDirs(cloud_match);
CREATE INDEX IF NOT EXISTS idx_local_dirs_parent        ON localDirs(parent_path);

-- ===========================================================================
-- §3. schema_migrations ledger
-- ===========================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR REPLACE INTO schema_migrations(version) VALUES ('v4_structure_align_phaseB');
