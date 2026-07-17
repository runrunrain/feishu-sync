/**
 * Controlled v5 runtime-state migration runner.
 *
 * The desktop runtime applies the same migration automatically through
 * LocalMapStore.initialize(). This CLI exists for operators who need an
 * auditable backup/verification boundary before opening an older database.
 * Backups are external to the knowledge base and database directory by
 * default, and rollback requires an explicit backup path.
 *
 * Usage:
 *   npm run migrate:v5 -- --db /path/to/feishu-sync.db
 *   npm run migrate:v5 -- --db /path/to/feishu-sync.db --dry-run
 *   npm run migrate:v5 -- --db /path/to/feishu-sync.db --rollback /path/to/backup.db
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LocalMapStore } from '../src/modules/local-map-store.js';

interface Args {
  dbPath: string | null;
  backupDir: string;
  dryRun: boolean;
  rollbackPath: string | null;
}

function parseArgs(argv: string[]): Args {
  let dbPath: string | null = null;
  let rollbackPath: string | null = null;
  let backupDir = path.join(os.homedir(), '.feishu-sync', 'recovery');
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') {
      dbPath = argv[++index] ?? null;
    } else if (arg === '--backup-dir') {
      backupDir = argv[++index] ?? backupDir;
    } else if (arg === '--rollback') {
      rollbackPath = argv[++index] ?? null;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: migrate:v5 -- --db <database> [--dry-run] [--backup-dir <directory>] [--rollback <backup>]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { dbPath, backupDir, dryRun, rollbackPath };
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Produce a transactionally consistent snapshot, including a live WAL if
 * present. A raw copy of the main database file is not safe while the app is
 * running in WAL mode.
 */
async function backupSqlite(sourcePath: string, destinationPath: string): Promise<void> {
  const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await database.backup(destinationPath);
  } finally {
    database.close();
  }
}

function verifyV5(dbPath: string): { columns: string[]; migrationApplied: boolean } {
  const database = new Database(dbPath, { readonly: true });
  try {
    const columns = (database.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>)
      .map((row) => row.name);
    const migrationApplied = Boolean(
      database
        .prepare("SELECT 1 FROM schema_migrations WHERE version = 'v5_runtime_state'")
        .get(),
    );
    return { columns, migrationApplied };
  } finally {
    database.close();
  }
}

function copyAtomically(source: string, destination: string): void {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, destination);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dbPath) throw new Error('必须提供 --db <database>');
  const dbPath = path.resolve(args.dbPath);
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);

  if (args.rollbackPath) {
    const rollbackPath = path.resolve(args.rollbackPath);
    if (!fs.existsSync(rollbackPath)) throw new Error(`回滚备份不存在：${rollbackPath}`);
    if (args.dryRun) {
      console.log(JSON.stringify({ mode: 'rollback-dry-run', dbPath, rollbackPath, backupSha256: sha256(rollbackPath) }, null, 2));
      return;
    }
    copyAtomically(rollbackPath, dbPath);
    console.log(JSON.stringify({ mode: 'rollback', dbPath, restoredFrom: rollbackPath, sha256: sha256(dbPath) }, null, 2));
    return;
  }

  if (args.dryRun) {
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-v5-dry-run-'));
    const temporaryDb = path.join(temporaryDir, path.basename(dbPath));
    try {
      await backupSqlite(dbPath, temporaryDb);
      const store = new LocalMapStore(temporaryDb);
      store.initialize();
      store.close();
      const verification = verifyV5(temporaryDb);
      console.log(JSON.stringify({
        mode: 'dry-run',
        dbPath,
        sourceSha256: sha256(dbPath),
        migrationApplied: verification.migrationApplied,
        v5Columns: verification.columns.filter((name) => [
          'observed_obj_edit_time', 'synced_obj_edit_time', 'sync_state',
          'watched_root_id', 'local_rel_path', 'missing_complete_count',
          'last_sync_error_code', 'has_child',
        ].includes(name)),
      }, null, 2));
    } finally {
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
    return;
  }

  fs.mkdirSync(args.backupDir, { recursive: true });
  const backupPath = path.join(
    args.backupDir,
    `${path.basename(dbPath, path.extname(dbPath))}-before-v5-${new Date().toISOString().replace(/[:.]/g, '-')}${path.extname(dbPath) || '.db'}`,
  );
  await backupSqlite(dbPath, backupPath);
  const store = new LocalMapStore(dbPath);
  store.initialize();
  store.close();
  const verification = verifyV5(dbPath);
  if (!verification.migrationApplied) {
    throw new Error('v5 migration ledger record missing after migration');
  }
  console.log(JSON.stringify({
    mode: 'apply',
    dbPath,
    backupPath,
    backupSha256: sha256(backupPath),
    migratedSha256: sha256(dbPath),
    v5Columns: verification.columns.filter((name) => [
      'observed_obj_edit_time', 'synced_obj_edit_time', 'sync_state',
      'watched_root_id', 'local_rel_path', 'missing_complete_count',
      'last_sync_error_code', 'has_child',
    ].includes(name)),
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
