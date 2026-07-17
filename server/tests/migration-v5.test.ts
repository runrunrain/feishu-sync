/**
 * v5 runtime-state migration integration tests.
 *
 * Each fixture is a real SQLite database shaped like a v2, v3, or v4
 * installation. The test proves that LocalMapStore.initialize() upgrades it
 * idempotently, preserves a verifiable sync baseline, demotes unsafe legacy
 * deletions to candidates, and can be restored from the pre-migration copy.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalMapStore } from '../src/modules/local-map-store.js';

const temporaryDirectories: string[] = [];
const v5Columns = [
  'observed_obj_edit_time',
  'synced_obj_edit_time',
  'sync_state',
  'watched_root_id',
  'local_rel_path',
  'missing_complete_count',
  'last_sync_error_code',
  'has_child',
];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(version: 2 | 3 | 4): { directory: string; dbPath: string; backupPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `feishu-sync-v${version}-`));
  temporaryDirectories.push(directory);
  const dbPath = path.join(directory, 'feishu-sync.db');
  const localFile = path.join(directory, 'synced.md');
  fs.writeFileSync(localFile, '# verified local content\n', 'utf8');

  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE documents (
      obj_token TEXT PRIMARY KEY,
      wiki_node_token TEXT,
      obj_type TEXT NOT NULL,
      title TEXT NOT NULL,
      local_md_path TEXT NOT NULL,
      last_synced_modify_time TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'synced',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      parent_node_token TEXT,
      space_id TEXT,
      obj_edit_time INTEGER,
      cloud_deleted INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      local_sort_order INTEGER
    );
  `);
  if (version >= 3) {
    database.exec(`
      ALTER TABLE documents ADD COLUMN original_link TEXT;
      ALTER TABLE documents ADD COLUMN cloud_match TEXT NOT NULL DEFAULT 'unknown';
    `);
  }
  if (version >= 4) {
    database.exec(`
      ALTER TABLE documents ADD COLUMN watched_root_url TEXT;
      CREATE TABLE localDirs (
        local_path TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        parent_path TEXT,
        watched_root_url TEXT,
        mapped_wiki_node_token TEXT,
        mapped_obj_token TEXT,
        cloud_match TEXT NOT NULL DEFAULT 'unknown',
        auto_detected INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  const insert = database.prepare(`
    INSERT INTO documents (
      obj_token, wiki_node_token, obj_type, title, local_md_path,
      last_synced_modify_time, last_synced_at, status,
      parent_node_token, space_id, obj_edit_time, cloud_deleted, last_seen_at
    ) VALUES (?, ?, 'docx', ?, ?, '', '2026-07-17T00:00:00.000Z', ?, 'root-node', 'space-1', ?, ?, '2026-07-17T00:00:00.000Z')
  `);
  insert.run('SYNCED', 'node-synced', 'synced document', localFile, 'synced', 100, 0);
  insert.run('MISSING_FILE', 'node-missing', 'missing file', path.join(directory, 'gone.md'), 'synced', 200, 0);
  // `package.json` exists in the test process working directory. A legacy
  // relative path must not gain a trusted synced baseline merely because it
  // happens to resolve there.
  insert.run('RELATIVE_PATH', 'node-relative', 'relative path', 'package.json', 'synced', 250, 0);
  insert.run('LEGACY_DELETE', 'node-deleted', 'legacy deleted', localFile, 'synced', 300, 1);
  insert.run('RESTRICTED', 'node-restricted', '', '', 'placeholder', null, 0);
  if (version >= 3) {
    database.prepare("UPDATE documents SET cloud_match = 'restricted' WHERE obj_token = 'RESTRICTED'").run();
  }
  database.close();

  const backupPath = path.join(directory, `before-v${version}-migration.db`);
  fs.copyFileSync(dbPath, backupPath);
  return { directory, dbPath, backupPath };
}

describe.each([2, 3, 4] as const)('LocalMapStore v%d -> v5 runtime migration', (version) => {
  it('is idempotent, conservative, and restorable from the pre-migration backup', () => {
    const { dbPath, backupPath } = createFixture(version);
    const store = new LocalMapStore(dbPath);
    store.initialize();
    // A second initialization is the runtime idempotency check.
    store.initialize();

    expect(store.getDocumentByObjToken('SYNCED')).toMatchObject({
      observedObjEditTime: 100,
      syncedObjEditTime: 100,
      syncState: 'synced',
      watchedRootId: version >= 4 ? null : null,
    });
    expect(store.getDocumentByObjToken('MISSING_FILE')).toMatchObject({
      observedObjEditTime: 200,
      syncedObjEditTime: null,
      syncState: 'pending_modified',
    });
    expect(store.getDocumentByObjToken('RELATIVE_PATH')).toMatchObject({
      observedObjEditTime: 250,
      syncedObjEditTime: null,
      syncState: 'pending_modified',
    });
    expect(store.getDocumentByObjToken('LEGACY_DELETE')).toMatchObject({
      syncState: 'missing_candidate',
      missingCompleteCount: 2,
      cloudDeleted: 0,
    });
    expect(store.getDocumentByObjToken('RESTRICTED')).toMatchObject({
      syncState: 'restricted',
      cloudDeleted: 0,
    });
    store.close();

    const migrated = new Database(dbPath, { readonly: true });
    const migratedColumns = new Set(
      (migrated.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map((row) => row.name),
    );
    expect(v5Columns.every((column) => migratedColumns.has(column))).toBe(true);
    expect(
      (migrated.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 'v5_runtime_state'").get() as { count: number }).count,
    ).toBe(1);
    migrated.close();

    // Recovery rehearsal: restore the external pre-migration copy and prove
    // it has its original schema. This is deliberately a file-level restore,
    // matching the v5 migration CLI's rollback strategy.
    fs.copyFileSync(backupPath, dbPath);
    const restored = new Database(dbPath, { readonly: true });
    const restoredColumns = new Set(
      (restored.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map((row) => row.name),
    );
    expect(v5Columns.some((column) => restoredColumns.has(column))).toBe(false);
    expect(
      (restored.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number }).count,
    ).toBe(5);
    restored.close();
  });
});
