-- migration_v2.sql — feishu-sync v0.2.0 mapping expansion
--
-- Implements schema changes described in 03-迭代架构设计.md §3.2.3.
-- Idempotent: safe to run multiple times (uses ALTER … ADD COLUMN guarded by
-- PRAGMA table_info checks performed by the runner, plus CREATE … IF NOT EXISTS
-- for all indexes/tables). Wrapped in a transaction so partial failures roll
-- back cleanly.
--
-- Schema version recorded: v2_mapping_expansion
--   (covers: parent_node_token, space_id, obj_edit_time, cloud_deleted,
--    last_seen_at, local_sort_order, sheet_sheets table, schema_migrations)
--
-- Run via:
--   node --experimental-vm-modules server/scripts/run-migration-v2.mjs
--   (the runner backs up feishu-sync.db to .bak first, then executes this file)

BEGIN TRANSACTION;

-- ---------------------------------------------------------------------------
-- 1. documents table — additive column expansion
-- ---------------------------------------------------------------------------
-- Each ALTER is wrapped so a re-run on an already-migrated DB does not fail.
-- SQLite raises "duplicate column name" if the column already exists; the
-- runner checks PRAGMA table_info(documents) and only emits the ALTER lines
-- for missing columns. Here we list them in source-of-truth order.

-- ALTER TABLE documents ADD COLUMN parent_node_token TEXT;
-- ALTER TABLE documents ADD COLUMN space_id TEXT;
-- ALTER TABLE documents ADD COLUMN obj_edit_time INTEGER;
-- ALTER TABLE documents ADD COLUMN cloud_deleted INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE documents ADD COLUMN last_seen_at TEXT;
-- ALTER TABLE documents ADD COLUMN local_sort_order INTEGER;

-- NOTE: The actual ALTER statements are emitted dynamically by the runner
-- (run-migration-v2.mjs) based on PRAGMA table_info introspection. This file
-- keeps the canonical column list for documentation + audit. Static ALTER
-- would fail on re-run because SQLite lacks "ADD COLUMN IF NOT EXISTS".

-- ---------------------------------------------------------------------------
-- 2. Indexes for documents (safe to CREATE IF NOT EXISTS)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_node_token);
CREATE INDEX IF NOT EXISTS idx_documents_space ON documents(space_id);
CREATE INDEX IF NOT EXISTS idx_documents_cloud_deleted ON documents(cloud_deleted);
CREATE INDEX IF NOT EXISTS idx_documents_obj_edit_time ON documents(obj_edit_time);
-- Composite index for the node tree query: children of a parent ordered by
-- the local user-defined sort weight. local_sort_order may be NULL (user has
-- not reordered); SQLite indexes still include NULL rows.
CREATE INDEX IF NOT EXISTS idx_documents_parent_sort ON documents(parent_node_token, local_sort_order);

-- ---------------------------------------------------------------------------
-- 3. sheet_sheets table — sub-sheet granularity mapping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sheet_sheets (
  sheet_obj_token TEXT NOT NULL,                  -- parent sheet obj_token (FK -> documents.obj_token)
  sheet_id        TEXT NOT NULL,                  -- feishu sub-sheet id (from workbook-info)
  sheet_title     TEXT NOT NULL,
  local_csv_path  TEXT NOT NULL,
  local_md_path   TEXT,                           -- reconstructed .md path (nullable for raw CSV-only state)
  last_synced_modify_time TEXT,                   -- ISO8601; sub-sheets share workbook edit time
  status          TEXT NOT NULL DEFAULT 'synced' CHECK(status IN ('synced', 'changed', 'error', 'placeholder')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sheet_obj_token, sheet_id),
  FOREIGN KEY (sheet_obj_token) REFERENCES documents(obj_token) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sheet_sheets_sheet_obj ON sheet_sheets(sheet_obj_token);
CREATE INDEX IF NOT EXISTS idx_sheet_sheets_status ON sheet_sheets(status);

-- ---------------------------------------------------------------------------
-- 4. schema_migrations — version ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR REPLACE INTO schema_migrations(version) VALUES ('v2_mapping_expansion');

COMMIT;
