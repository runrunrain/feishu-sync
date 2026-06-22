/**
 * run-migration-v4.mjs — runner for migration_v4.sql
 *
 * Adds the structure-align Phase B schema on top of v3 (cloud-link-coverage):
 *   - documents.watched_root_url TEXT
 *   - local_dirs table (local directory ↔ feishu node mapping)
 *
 * Flow (mirrors run-migration-v3):
 *   1. Resolve DB path (~/.feishu-sync/feishu-sync.db unless --db override)
 *   2. Backup DB to <db>.bak-v4-<timestamp>
 *   3. Snapshot documents row count + column list for integrity check
 *   4. Read migration_v4.sql and split into statements
 *   5. Skip ALTER statements whose target column already exists
 *      (v3 pattern: avoids "duplicate column name" on re-runs)
 *   6. Run remaining statements inside a transaction
 *   7. Verify: row count unchanged + watched_root_url column present +
 *      local_dirs table present + schema_migrations has v4_structure_align_phaseB
 *
 * Usage:
 *   node server/scripts/run-migration-v4.mjs [--db <path>] [--dry-run]
 *
 * Design note: this runner is for manual / migration-script use. The
 * desktop runtime auto-migrates via LocalMapStore.applyAdditiveMigrations
 * on startup (see local-map-store.ts). Both paths must stay in sync.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db || defaultDbPath();
const dryRun = args['dry-run'] === true;

console.log(`[migration_v4] DB path: ${dbPath}`);
console.log(`[migration_v4] Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);

if (!fs.existsSync(dbPath)) {
  console.error(`[migration_v4] DB file does not exist. Aborting.`);
  process.exit(2);
}

const sqlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migration_v4.sql');
if (!fs.existsSync(sqlPath)) {
  console.error(`[migration_v4] migration_v4.sql not found at ${sqlPath}`);
  process.exit(2);
}
const sqlText = fs.readFileSync(sqlPath, 'utf-8');

const SCHEMA_VERSION = 'v4_structure_align_phaseB';

// --- Step 1: snapshot for integrity verification ---------------------------
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const beforeRowCount = (
  db.prepare('SELECT COUNT(*) AS n FROM documents').get()
).n;
const beforeCols = db.prepare('PRAGMA table_info(documents)').all();
const beforeColNames = new Set(beforeCols.map((c) => c.name));
console.log(`[migration_v4] Pre-migration documents row count: ${beforeRowCount}`);
console.log(`[migration_v4] Pre-migration documents columns (${beforeCols.length}):`, beforeColNames);

const hasWatchedRootUrl = beforeColNames.has('watched_root_url');
const hasLocalDirsTable = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='localDirs'")
  .get() != null;

// --- Step 2: split SQL into statements and decide what to skip ------------
// The migration_v4.sql is structured so each ALTER/CREATE is its own statement.
// We split on semicolons followed by newlines (DDL-only; no triggers / functions).
const statements = splitStatements(sqlText);
console.log(`[migration_v4] Parsed ${statements.length} statements from migration_v4.sql`);

// Skip logic: we always run CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
// (they are idempotent). We only need to skip ALTER TABLE ... ADD COLUMN when the
// column is already present. The PRAGMA check below is the authoritative guard.
const skipReasons = [];
for (const stmt of statements) {
  const alterMatch = stmt.match(/^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i);
  if (alterMatch) {
    const [, table, col] = alterMatch;
    if (table.toLowerCase() === 'documents' && beforeColNames.has(col)) {
      skipReasons.push({ stmt, reason: `documents.${col} already exists` });
    }
  }
}
const skipStmts = new Set(skipReasons.map((s) => s.stmt));
const toRun = statements.filter((s) => !skipStmts.has(s));

console.log(`[migration_v4] Statements to execute: ${toRun.length}`);
console.log(`[migration_v4] Statements to skip: ${skipReasons.length}`);
for (const skip of skipReasons) {
  console.log(`  SKIP: ${skip.reason}`);
}

if (dryRun) {
  console.log('[migration_v4] Dry-run preview of statements that would run:');
  for (const stmt of toRun) {
    console.log('  >>', stmt.split('\n').map((l) => l.trim()).filter(Boolean).join(' ').slice(0, 120));
  }
  db.close();
  process.exit(0);
}

// --- Step 3: backup --------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${dbPath}.bak-v4-${stamp}`;
fs.copyFileSync(dbPath, backupPath);
console.log(`[migration_v4] Backup written: ${backupPath}`);

// --- Step 4: apply migration inside a transaction --------------------------
try {
  const tx = db.transaction(() => {
    for (const stmt of toRun) {
      db.exec(stmt);
    }
    console.log(`[migration_v4] Executed ${toRun.length} statements.`);
  });
  tx();
  console.log('[migration_v4] Transaction committed.');
} catch (err) {
  console.error('[migration_v4] Migration failed, restoring backup.');
  db.close();
  fs.copyFileSync(backupPath, dbPath);
  console.error('[migration_v4] Error:', err.message);
  process.exit(1);
}

// --- Step 5: verification --------------------------------------------------
const afterCols = db.prepare('PRAGMA table_info(documents)').all();
const afterColNames = new Set(afterCols.map((c) => c.name));
if (!afterColNames.has('watched_root_url')) {
  console.error('[migration_v4] VERIFY FAIL: documents.watched_root_url missing');
  db.close();
  process.exit(1);
}

const localDirsTable = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='localDirs'")
  .get();
if (!localDirsTable) {
  console.error('[migration_v4] VERIFY FAIL: localDirs table missing');
  db.close();
  process.exit(1);
}

const afterRowCount = (
  db.prepare('SELECT COUNT(*) AS n FROM documents').get()
).n;
if (afterRowCount !== beforeRowCount) {
  console.error(
    `[migration_v4] VERIFY FAIL: row count changed ${beforeRowCount} -> ${afterRowCount}`,
  );
  db.close();
  process.exit(1);
}

const versionRow = db
  .prepare("SELECT version, applied_at FROM schema_migrations WHERE version = ?")
  .get(SCHEMA_VERSION);
if (!versionRow) {
  console.error('[migration_v4] VERIFY FAIL: schema_migrations row not inserted');
  db.close();
  process.exit(1);
}

const localDirsCols = db.prepare('PRAGMA table_info(localDirs)').all();
console.log('[migration_v4] Verification:');
console.log(`  documents row count: ${afterRowCount} (unchanged)`);
console.log(`  documents columns: ${afterCols.length} (was ${beforeCols.length})`);
console.log(`  documents.watched_root_url: present`);
console.log(`  localDirs columns (${localDirsCols.length}):`, localDirsCols.map((c) => c.name).join(', '));
console.log(`  schema_migrations: ${versionRow.version} applied at ${versionRow.applied_at}`);

db.close();
console.log('[migration_v4] Done.');

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
      console.log('Usage: node run-migration-v4.mjs [--db <path>] [--dry-run]');
      process.exit(0);
    }
  }
  return out;
}

function defaultDbPath() {
  return path.join(os.homedir(), '.feishu-sync', 'feishu-sync.db');
}

/**
 * Split a .sql file into executable statements.
 * - Strips line comments (-- ...) and block comments (/* ... *\/).
 * - Splits on semicolons that are followed by a newline (DDL is statement-per-line).
 * - Ignores empty statements.
 */
function splitStatements(sql) {
  // Remove block comments.
  const noBlocks = sql.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments.
  const lines = noBlocks.split('\n').map((l) => l.replace(/--.*$/, ''));
  const joined = lines.join('\n');
  // Split on ; followed by newline (possibly with whitespace).
  const raw = joined.split(/;\s*\n/);
  return raw
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.endsWith(';') ? s : `${s};`));
}
