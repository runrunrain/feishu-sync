-- migration_v3.sql — feishu-sync v0.2.0 cloud-link coverage expansion
--
-- Implements schema changes for "every local doc has explicit feishu link
-- or explicit no-cloud marker" requirement (2026-06-22).
--
-- Adds two columns to documents:
--   original_link TEXT       — feishu wiki URL (https://xxx.feishu.cn/wiki/<token>)
--                              extracted from .md header; NULL when the row
--                              was written by change-detector with no .md at all.
--   cloud_match   TEXT NOT NULL DEFAULT 'unknown'
--                            — three-state cloud-relationship marker:
--                              'synced'     : has original_link + title verified
--                                             (feishu cloud reachable + readable)
--                              'restricted' : has obj_token but feishu returned
--                                             permission-denied (131006) so title
--                                             is empty; link is best-effort guess
--                                             from wiki_node_token
--                              'local_only' : no obj_token in header (orphan);
--                                             not applicable to documents rows
--                                             (orphans live in _index.json only)
--                              'unknown'    : default for legacy rows; will be
--                                             re-classified on next rebuild
--
-- Idempotent: safe to run multiple times (uses ALTER … ADD COLUMN guarded by
-- PRAGMA table_info checks performed by the runner, plus CREATE … IF NOT EXISTS
-- for all indexes). Wrapped in a transaction so partial failures roll back cleanly.
--
-- Schema version recorded: v3_cloud_link_coverage
--
-- Run via:
--   node server/scripts/run-migration-v3.mjs
--   (the runner backs up feishu-sync.db to .bak first, then executes this file)

BEGIN TRANSACTION;

-- ---------------------------------------------------------------------------
-- 1. documents table — additive column expansion
-- ---------------------------------------------------------------------------
-- Each ALTER is wrapped so a re-run on an already-migrated DB does not fail.
-- SQLite raises "duplicate column name" if the column already exists; the
-- runner checks PRAGMA table_info(documents) and only emits the ALTER lines
-- for missing columns. Here we list them in source-of-truth order.

-- ALTER TABLE documents ADD COLUMN original_link TEXT;
-- ALTER TABLE documents ADD COLUMN cloud_match TEXT NOT NULL DEFAULT 'unknown';

-- NOTE: The actual ALTER statements are emitted dynamically by the runner
-- (run-migration-v3.mjs) based on PRAGMA table_info introspection. This file
-- keeps the canonical column list for documentation + audit. Static ALTER
-- would fail on re-run because SQLite lacks "ADD COLUMN IF NOT EXISTS".

-- ---------------------------------------------------------------------------
-- 2. Indexes for documents (safe to CREATE IF NOT EXISTS)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_documents_cloud_match ON documents(cloud_match);
CREATE INDEX IF NOT EXISTS idx_documents_original_link ON documents(original_link);

-- ---------------------------------------------------------------------------
-- 3. Backfill cloud_match for existing rows
-- ---------------------------------------------------------------------------
-- Strategy: rows with non-empty title → 'synced'; rows with empty title but
-- non-empty obj_token → 'restricted'; everything else stays 'unknown'.
-- This classification is also recomputed on every rebuild by IndexScanner
-- and by LocalMapStore.recomputeCloudMatch(), so this UPDATE only needs to
-- give a sensible initial value for legacy rows written before this migration.
UPDATE documents
SET cloud_match = CASE
  WHEN title IS NOT NULL AND title <> '' THEN 'synced'
  WHEN obj_token IS NOT NULL AND obj_token <> '' THEN 'restricted'
  ELSE 'unknown'
END
WHERE cloud_match = 'unknown' OR cloud_match IS NULL;

-- Backfill original_link for placeholder/restricted rows that have a
-- wiki_node_token: construct the canonical feishu wiki URL from it. This
-- is a best-effort guess — if the node was originally a doc the URL is
-- correct; if it was a sheet/bitable the URL may be wrong, but the link
-- is still "feishu cloud" identifiable. Restricted rows are flagged
-- cloud_match='restricted' so the UI can communicate uncertainty.
UPDATE documents
SET original_link = 'https://qcnbafdrjx7n.feishu.cn/wiki/' || wiki_node_token
WHERE original_link IS NULL
  AND wiki_node_token IS NOT NULL
  AND wiki_node_token <> '';

-- ---------------------------------------------------------------------------
-- 4. schema_migrations — version ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR REPLACE INTO schema_migrations(version) VALUES ('v3_cloud_link_coverage');

COMMIT;
