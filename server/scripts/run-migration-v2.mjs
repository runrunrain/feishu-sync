/**
 * run-migration-v2.mjs — runner for migration_v2.sql
 *
 * Flow:
 *   1. Resolve DB path (~/.feishu-sync/feishu-sync.db unless --db override)
 *   2. Backup DB to <db>.bak-v2-<timestamp> (preserves prior .bak)
 *   3. Snapshot documents row count + a few obj_tokens for integrity check
 *   4. Run additive ALTER TABLE statements (only for columns missing from
 *      PRAGMA table_info) inside a transaction
 *   5. Run the static parts of migration_v2.sql (indexes, sheet_sheets,
 *      schema_migrations) which are all CREATE … IF NOT EXISTS / INSERT OR
 *      REPLACE, hence idempotent
 *   6. Verify: row count unchanged + new columns present + schema_migrations
 *      contains v2_mapping_expansion
 *
 * Usage:
 *   node server/scripts/run-migration-v2.mjs [--db <path>] [--dry-run]
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db || defaultDbPath();
const dryRun = args['dry-run'] === true;

console.log(`[migration_v2] DB path: ${dbPath}`);
console.log(`[migration_v2] Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);

if (!fs.existsSync(dbPath)) {
  console.error(`[migration_v2] DB file does not exist. Aborting.`);
  process.exit(2);
}

// Required new columns on documents (canonical list from migration_v2.sql §1).
const REQUIRED_COLUMNS = [
  { name: 'parent_node_token', type: 'TEXT', dml: 'ALTER TABLE documents ADD COLUMN parent_node_token TEXT' },
  { name: 'space_id', type: 'TEXT', dml: 'ALTER TABLE documents ADD COLUMN space_id TEXT' },
  { name: 'obj_edit_time', type: 'INTEGER', dml: 'ALTER TABLE documents ADD COLUMN obj_edit_time INTEGER' },
  {
    name: 'cloud_deleted',
    type: 'INTEGER',
    dml: "ALTER TABLE documents ADD COLUMN cloud_deleted INTEGER NOT NULL DEFAULT 0",
  },
  { name: 'last_seen_at', type: 'TEXT', dml: 'ALTER TABLE documents ADD COLUMN last_seen_at TEXT' },
  { name: 'local_sort_order', type: 'INTEGER', dml: 'ALTER TABLE documents ADD COLUMN local_sort_order INTEGER' },
];

const SCHEMA_VERSION = 'v2_mapping_expansion';

// --- Step 1: snapshot for integrity verification ---------------------------
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const beforeRowCount = (
  db.prepare('SELECT COUNT(*) AS n FROM documents').get()
).n;
const beforeSample = db
  .prepare('SELECT obj_token, local_md_path, status FROM documents LIMIT 5')
  .all();
console.log(`[migration_v2] Pre-migration documents row count: ${beforeRowCount}`);
console.log(`[migration_v2] Sample rows:`, beforeSample);

// --- Step 2: determine which ALTER statements are needed -------------------
const currentCols = db.prepare('PRAGMA table_info(documents)').all();
const currentColNames = new Set(currentCols.map((c) => c.name));
const pendingAlters = REQUIRED_COLUMNS.filter((c) => !currentColNames.has(c.name));
console.log(
  `[migration_v2] Columns to add: ${pendingAlters.length === 0 ? 'none (already migrated)' : pendingAlters.map((c) => c.name).join(', ')}`,
);

if (dryRun) {
  console.log('[migration_v2] Dry-run preview:');
  console.log('  Would execute ALTERs:', pendingAlters.map((c) => c.dml));
  console.log('  Would execute static DDL: indexes, sheet_sheets, schema_migrations');
  console.log('  Would record schema version:', SCHEMA_VERSION);
  db.close();
  process.exit(0);
}

// --- Step 3: backup --------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${dbPath}.bak-v2-${stamp}`;
fs.copyFileSync(dbPath, backupPath);
console.log(`[migration_v2] Backup written: ${backupPath}`);

// --- Step 4: apply migration inside a transaction --------------------------
try {
  const tx = db.transaction(() => {
    // 4a. Additive ALTERs (skip already-present columns)
    for (const col of pendingAlters) {
      db.exec(col.dml);
      console.log(`[migration_v2] + documents.${col.name}`);
    }

    // 4b. Indexes (idempotent)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_node_token);
      CREATE INDEX IF NOT EXISTS idx_documents_space ON documents(space_id);
      CREATE INDEX IF NOT EXISTS idx_documents_cloud_deleted ON documents(cloud_deleted);
      CREATE INDEX IF NOT EXISTS idx_documents_obj_edit_time ON documents(obj_edit_time);
      CREATE INDEX IF NOT EXISTS idx_documents_parent_sort ON documents(parent_node_token, local_sort_order);
    `);
    console.log('[migration_v2] + documents indexes (5)');

    // 4c. sheet_sheets table (idempotent)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sheet_sheets (
        sheet_obj_token TEXT NOT NULL,
        sheet_id        TEXT NOT NULL,
        sheet_title     TEXT NOT NULL,
        local_csv_path  TEXT NOT NULL,
        local_md_path   TEXT,
        last_synced_modify_time TEXT,
        status          TEXT NOT NULL DEFAULT 'synced' CHECK(status IN ('synced', 'changed', 'error', 'placeholder')),
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (sheet_obj_token, sheet_id),
        FOREIGN KEY (sheet_obj_token) REFERENCES documents(obj_token) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sheet_sheets_sheet_obj ON sheet_sheets(sheet_obj_token);
      CREATE INDEX IF NOT EXISTS idx_sheet_sheets_status ON sheet_sheets(status);
    `);
    console.log('[migration_v2] + sheet_sheets table + 2 indexes');

    // 4d. schema_migrations ledger
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR REPLACE INTO schema_migrations(version) VALUES ('${SCHEMA_VERSION}');
    `);
    console.log(`[migration_v2] + schema_migrations record: ${SCHEMA_VERSION}`);
  });

  tx();
  console.log('[migration_v2] Transaction committed.');
} catch (err) {
  console.error('[migration_v2] Migration failed, rolling back via backup restore.');
  db.close();
  // Restore from backup so DB is in pre-migration state.
  fs.copyFileSync(backupPath, dbPath);
  console.error('[migration_v2] Error:', err.message);
  process.exit(1);
}

// --- Step 5: verification --------------------------------------------------
const afterCols = db.prepare('PRAGMA table_info(documents)').all();
const afterColNames = new Set(afterCols.map((c) => c.name));
const missingCols = REQUIRED_COLUMNS.filter((c) => !afterColNames.has(c.name));
if (missingCols.length > 0) {
  console.error(`[migration_v2] VERIFY FAIL: missing columns ${missingCols.map((c) => c.name).join(', ')}`);
  db.close();
  process.exit(1);
}

const afterRowCount = (
  db.prepare('SELECT COUNT(*) AS n FROM documents').get()
).n;
if (afterRowCount !== beforeRowCount) {
  console.error(
    `[migration_v2] VERIFY FAIL: row count changed ${beforeRowCount} -> ${afterRowCount}`,
  );
  db.close();
  process.exit(1);
}

// Spot-check sample obj_tokens survived.
const afterSample = db
  .prepare('SELECT obj_token, local_md_path, status FROM documents LIMIT 5')
  .all();
const beforeTokens = new Set(beforeSample.map((r) => r.obj_token));
const lostTokens = afterSample.filter((r) => !beforeTokens.has(r.obj_token));
if (afterSample.length > 0 && lostTokens.length === afterSample.length) {
  console.error('[migration_v2] VERIFY WARN: sample tokens do not match pre-migration (data may have shifted).');
}

const versionRow = db
  .prepare("SELECT version, applied_at FROM schema_migrations WHERE version = ?")
  .get(SCHEMA_VERSION);
if (!versionRow) {
  console.error('[migration_v2] VERIFY FAIL: schema_migrations row not inserted');
  db.close();
  process.exit(1);
}

console.log('[migration_v2] Verification:');
console.log(`  documents row count: ${afterRowCount} (unchanged from ${beforeRowCount})`);
console.log(`  documents columns: ${afterCols.length} (was ${currentCols.length})`);
console.log(`  schema_migrations: ${versionRow.version} applied at ${versionRow.applied_at}`);

db.close();
console.log('[migration_v2] Done.');

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
      console.log('Usage: node run-migration-v2.mjs [--db <path>] [--dry-run]');
      process.exit(0);
    }
  }
  return out;
}

function defaultDbPath() {
  const home = os.homedir();
  return path.join(home, '.feishu-sync', 'feishu-sync.db');
}
