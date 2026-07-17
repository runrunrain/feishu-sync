/**
 * Runtime SQLite integration tests.
 *
 * These intentionally use the same better-sqlite3 binding as production.
 * A Python SQL mirror cannot prove that LocalMapStore.initialize() creates
 * every table its TypeScript methods require on a fresh installation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import type { DocumentRecord } from '../src/types/index.js';

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-local-map-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'feishu-sync.db');
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeDocument(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    objToken: 'sheet-object-token',
    wikiNodeToken: 'wiki-node-token',
    objType: 'sheet',
    title: '工作簿',
    localMdPath: '/tmp/工作簿.md',
    lastSyncedModifyTime: '2026-07-17T00:00:00.000Z',
    lastSyncedAt: '2026-07-17T00:00:00.000Z',
    status: 'synced',
    ...overrides,
  };
}

describe('LocalMapStore runtime schema', () => {
  it('creates every runtime table on a fresh database and initializes idempotently', () => {
    const dbPath = createDatabasePath();
    const store = new LocalMapStore(dbPath);
    store.initialize();
    store.initialize();
    store.close();

    const database = new Database(dbPath, { readonly: true });
    const tables = new Set(
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    database.close();

    expect([...tables]).toEqual(expect.arrayContaining([
      'documents',
      'localDirs',
      'sheet_sheets',
      'schema_migrations',
      'sync_log',
      'run_log',
    ]));
  });

  it('supports sub-sheet upserts immediately after fresh initialization', () => {
    const dbPath = createDatabasePath();
    const store = new LocalMapStore(dbPath);
    store.initialize();
    store.upsertDocument(makeDocument());

    store.upsertSheetSheet({
      sheetObjToken: 'sheet-object-token',
      sheetId: 'sheet-1',
      sheetTitle: '第一页',
      localCsvPath: '/tmp/工作簿.csv-data/第一页.csv',
      localMdPath: '/tmp/工作簿.md',
      lastSyncedModifyTime: '2026-07-17T00:00:00.000Z',
      status: 'synced',
    });

    expect(store.getSheetSheets('sheet-object-token')).toEqual([
      expect.objectContaining({
        sheet_obj_token: 'sheet-object-token',
        sheet_id: 'sheet-1',
        sheet_title: '第一页',
        status: 'synced',
      }),
    ]);
    store.close();
  });
});
