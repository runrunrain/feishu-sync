/**
 * run-migration-v3.mjs — runner for migration_v3.sql
 *
 * Adds original_link + cloud_match columns to documents, backfills existing
 * rows with sensible defaults (synced / restricted / unknown), and records
 * schema version v3_cloud_link_coverage.
 *
 * Flow:
 *   1. Resolve DB path (~/.feishu-sync/feishu-sync.db unless --db override)
 *   2. Backup DB to <db>.bak-v3-<timestamp>
 *   3. Snapshot documents row count for integrity check
 *   4. Run additive ALTER TABLE statements (only for columns missing)
 *   5. Run static DDL: indexes + schema_migrations ledger row
 *   6. Run backfill UPDATEs (cloud_match classification + original_link
 *      construction from wiki_node_token for restricted rows)
 *   7. Verify: row count unchanged + new columns present + schema_migrations
 *      contains v3_cloud_link_coverage + report cloud_match distribution
 *
 * Usage:
 *   node server/scripts/run-migration-v3.mjs [--db <path>] [--dry-run]
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db || defaultDbPath();
const dryRun = args['dry-run'] === true;

console.log(`[migration_v3] DB path: ${dbPath}`);
console.log(`[migration_v3] Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);

if (!fs.existsSync(dbPath)) {
  console.error(`[migration_v3] DB file does not exist. Aborting.`);
  process.exit(2);
}

// Required new columns on documents (canonical list from migration_v3.sql §1).
const REQUIRED_COLUMNS = [
  { name: 'original_link', type: 'TEXT', dml: 'ALTER TABLE documents ADD COLUMN original_link TEXT' },
  {
    name: 'cloud_match',
    type: 'TEXT',
    dml: "ALTER TABLE documents ADD COLUMN cloud_match TEXT NOT NULL DEFAULT 'unknown'",
  },
];

const SCHEMA_VERSION = 'v3_cloud_link_coverage';

// --- Step 1: snapshot for integrity verification ---------------------------
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const beforeRowCount = (
  db.prepare('SELECT COUNT(*) AS n FROM documents').get()
).n;
const beforeSample = db
  .prepare('SELECT obj_token, local_md_path, status, title FROM documents LIMIT 5')
  .all();
console.log(`[migration_v3] Pre-migration documents row count: ${beforeRowCount}`);
console.log(`[migration_v3] Sample rows:`, beforeSample);

// --- Step 2: determine which ALTER statements are needed -------------------
const currentCols = db.prepare('PRAGMA table_info(documents)').all();
const currentColNames = new Set(currentCols.map((c) => c.name));
const pendingAlters = REQUIRED_COLUMNS.filter((c) => !currentColNames.has(c.name));
console.log(
  `[migration_v3] Columns to add: ${pendingAlters.length === 0 ? 'none (already migrated)' : pendingAlters.map((c) => c.name).join(', ')}`,
);

if (dryRun) {
  console.log('[migration_v3] Dry-run preview:');
  console.log('  Would execute ALTERs:', pendingAlters.map((c) => c.dml));
  console.log('  Would execute static DDL: 2 indexes, schema_migrations');
  console.log('  Would backfill cloud_match from title/obj_token presence');
  console.log('  Would backfill original_link from wiki_node_token for restricted rows');
  console.log('  Would record schema version:', SCHEMA_VERSION);
  db.close();
  process.exit(0);
}

// --- Step 3: backup --------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${dbPath}.bak-v3-${stamp}`;
fs.copyFileSync(dbPath, backupPath);
console.log(`[migration_v3] Backup written: ${backupPath}`);

// --- Step 4: apply migration inside a transaction --------------------------
try {
  const tx = db.transaction(() => {
    // 4a. Additive ALTERs (skip already-present columns)
    for (const col of pendingAlters) {
      db.exec(col.dml);
      console.log(`[migration_v3] + documents.${col.name}`);
    }

    // 4b. Indexes (idempotent)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_cloud_match ON documents(cloud_match);
      CREATE INDEX IF NOT EXISTS idx_documents_original_link ON documents(original_link);
    `);
    console.log('[migration_v3] + documents indexes (2)');

    // 4c. Backfill cloud_match for existing rows (see migration_v3.sql §3)
    const cmResult = db.exec(`
      UPDATE documents
      SET cloud_match = CASE
        WHEN title IS NOT NULL AND title <> '' THEN 'synced'
        WHEN obj_token IS NOT NULL AND obj_token <> '' THEN 'restricted'
        ELSE 'unknown'
      END
      WHERE cloud_match = 'unknown' OR cloud_match IS NULL
    `);
    console.log(`[migration_v3] + cloud_match backfill: ${cmResult.changes} rows classified`);

    // 4d. Backfill original_link from wiki_node_token for rows that lack it
    const olResult = db.exec(`
      UPDATE documents
      SET original_link = 'https://qcnbafdrjx7n.feishu.cn/wiki/' || wiki_node_token
      WHERE original_link IS NULL
        AND wiki_node_token IS NOT NULL
        AND wiki_node_token <> ''
    `);
    console.log(`[migration_v3] + original_link backfill: ${olResult.changes} rows got best-effort URL`);

    // 4e. schema_migrations ledger
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR REPLACE INTO schema_migrations(version) VALUES ('${SCHEMA_VERSION}');
    `);
    console.log(`[migration_v3] + schema_migrations record: ${SCHEMA_VERSION}`);
  });

  tx();
  console.log('[migration_v3] Transaction committed.');
} catch (err) {
  console.error('[migration_v3] Migration failed, rolling back via backup restore.');
  db.close();
  fs.copyFileSync(backupPath, dbPath);
  console.error('[migration_v3] Error:', err.message);
  process.exit(1);
}

// --- Step 5: verification --------------------------------------------------
const afterCols = db.prepare('PRAGMA table_info(documents)').all();
const afterColNames = new Set(afterCols.map((c) => c.name));
const missingCols = REQUIRED_COLUMNS.filter((c) => !afterColNames.has(c.name));
if (missingCols.length > 0) {
  console.error(`[migration_v3] VERIFY FAIL: missing columns ${missingCols.map((c) => c.name).join(', ')}`);
  db.close();
  process.exit(1);
}

const afterRowCount = (
  db.prepare('SELECT COUNT(*) AS n FROM documents').get()
).n;
if (afterRowCount !== beforeRowCount) {
  console.error(
    `[migration_v3] VERIFY FAIL: row count changed ${beforeRowCount} -> ${afterRowCount}`,
  );
  db.close();
  process.exit(1);
}

// Distribution reports
const cmDist = db
  .prepare('SELECT cloud_match, COUNT(*) AS n FROM documents GROUP BY cloud_match ORDER BY n DESC')
  .all();
const olStats = db
  .prepare(`SELECT
    SUM(CASE WHEN original_link IS NOT NULL AND original_link <> '' THEN 1 ELSE 0 END) AS with_link,
    SUM(CASE WHEN original_link IS NULL OR original_link = '' THEN 1 ELSE 0 END) AS without_link
    FROM documents`)
  .get();

const versionRow = db
  .prepare("SELECT version, applied_at FROM schema_migrations WHERE version = ?")
  .get(SCHEMA_VERSION);
if (!versionRow) {
  console.error('[migration_v3] VERIFY FAIL: schema_migrations row not inserted');
  db.close();
  process.exit(1);
}

console.log('[migration_v3] Verification:');
console.log(`  documents row count: ${afterRowCount} (unchanged from ${beforeRowCount})`);
console.log(`  documents columns: ${afterCols.length} (was ${currentCols.length})`);
console.log(`  cloud_match distribution:`, cmDist);
console.log(`  original_link coverage: ${olStats.with_link} with link / ${olStats.without_link} without`);
console.log(`  schema_migrations: ${versionRow.version} applied at ${versionRow.applied_at}`);

db.close();
console.log('[migration_v3] Done.');

// --- helpers ---------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      out['dry-run'] = true;
    } else if (a === '--db') {
      out.db = argv[++i];
    } else if (a.startsWith('--db=')) {
      out.db = a.slice(5);
    } else if (a === '-h' || a === '--help') {
      console.log('Usage: node run-migration-v3.mjs [--db <path>] [--dry-run]');
      process.exit(0);
    }
  }
  return out;
}

function defaultDbPath() {
  return path.join(os.homedir(), '.feishu-sync', 'feishu-sync.db');
}
