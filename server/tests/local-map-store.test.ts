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
      'feishu_pending_items',
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

  it('keeps observed and synced baselines separate through pending and deletion-candidate transitions', () => {
    const dbPath = createDatabasePath();
    const store = new LocalMapStore(dbPath);
    store.initialize();

    const first = store.recordCloudObservation({
      objToken: 'doc-1',
      wikiNodeToken: 'node-1',
      objType: 'docx',
      title: '文档一',
      spaceId: 'space-1',
      parentNodeToken: 'root-1',
      watchedRootId: 'root-1',
      watchedRootUrl: 'https://tenant.feishu.cn/wiki/root-1',
      observedObjEditTime: 100,
      hasChild: false,
      observationStatus: 'available',
      lastSeenAt: '2026-07-17T00:00:00.000Z',
    });
    expect(first).toMatchObject({
      syncState: 'pending_added',
      observedObjEditTime: 100,
      syncedObjEditTime: null,
      watchedRootId: 'root-1',
    });

    // A repeated poll does not acknowledge the change.
    const repeated = store.recordCloudObservation({
      objToken: 'doc-1',
      wikiNodeToken: 'node-1',
      objType: 'docx',
      title: '文档一',
      spaceId: 'space-1',
      parentNodeToken: 'root-1',
      watchedRootId: 'root-1',
      watchedRootUrl: 'https://tenant.feishu.cn/wiki/root-1',
      observedObjEditTime: 100,
      hasChild: false,
      observationStatus: 'available',
      lastSeenAt: '2026-07-17T00:01:00.000Z',
    });
    expect(repeated).toMatchObject({ syncState: 'pending_added', syncedObjEditTime: null });

    store.markDocumentSynced({
      objToken: 'doc-1',
      syncedObjEditTime: 100,
      localMdPath: '/tmp/doc-1.md',
      localRelPath: '文档一.md',
      lastSyncedAt: '2026-07-17T00:02:00.000Z',
    });
    expect(store.getDocumentByObjToken('doc-1')).toMatchObject({
      syncState: 'synced',
      observedObjEditTime: 100,
      syncedObjEditTime: 100,
    });

    const changed = store.recordCloudObservation({
      objToken: 'doc-1',
      wikiNodeToken: 'node-1',
      objType: 'docx',
      title: '文档一（已更新）',
      spaceId: 'space-1',
      parentNodeToken: 'root-1',
      watchedRootId: 'root-1',
      watchedRootUrl: 'https://tenant.feishu.cn/wiki/root-1',
      observedObjEditTime: 200,
      hasChild: false,
      observationStatus: 'available',
      lastSeenAt: '2026-07-17T00:03:00.000Z',
    });
    expect(changed).toMatchObject({
      syncState: 'pending_modified',
      observedObjEditTime: 200,
      syncedObjEditTime: 100,
    });

    store.recordCompleteTraversalMiss('doc-1', '2026-07-17T00:04:00.000Z');
    expect(store.getDocumentByObjToken('doc-1')).toMatchObject({
      syncState: 'pending_modified',
      missingCompleteCount: 1,
      cloudDeleted: 0,
    });
    store.recordCompleteTraversalMiss('doc-1', '2026-07-17T00:05:00.000Z');
    expect(store.listMissingCandidates()).toHaveLength(1);
    expect(store.confirmMissingCandidateDeletion('doc-1', '2026-07-17T00:06:00.000Z')).toBe(true);
    expect(store.getDocumentByObjToken('doc-1')).toMatchObject({
      syncState: 'deleted_confirmed',
      cloudDeleted: 1,
    });
    expect(store.confirmMissingCandidateDeletion('doc-1', '2026-07-17T00:07:00.000Z')).toBe(false);
    store.close();
  });

  it('keeps Feishu-side failures out of normal state transitions until an explicit recheck succeeds', () => {
    const dbPath = createDatabasePath();
    const store = new LocalMapStore(dbPath);
    store.initialize();

    const observation = {
      objToken: 'restricted-doc',
      wikiNodeToken: 'restricted-node',
      objType: 'docx' as const,
      title: '需要授权的文档',
      spaceId: 'space-1',
      parentNodeToken: 'root-1',
      watchedRootId: 'root-1',
      watchedRootUrl: 'https://tenant.feishu.cn/wiki/root-1',
      observedObjEditTime: 100,
      hasChild: false,
      observationStatus: 'available' as const,
    };

    store.recordCloudObservation({ ...observation, lastSeenAt: '2026-07-17T00:00:00.000Z' });
    store.markDocumentSynced({
      objToken: observation.objToken,
      syncedObjEditTime: 100,
      localMdPath: '/tmp/restricted-doc.md',
      localRelPath: '需要授权的文档.md',
    });
    store.recordFeishuPending({
      objToken: observation.objToken,
      title: observation.title,
      watchedRootId: observation.watchedRootId,
      reasonCode: 'permission_denied',
      error: '无权限访问该节点',
      suggestedResolution: '请在飞书中授予当前 lark-cli 用户访问权限。',
      repairAction: 'grant_access',
    });

    expect(store.listFeishuPending()).toEqual([
      expect.objectContaining({
        objToken: observation.objToken,
        reasonCode: 'permission_denied',
        repairAction: 'grant_access',
        recheckRequestedAt: null,
      }),
    ]);
    expect(store.getDocumentByObjToken(observation.objToken)).toMatchObject({
      syncState: 'feishu_pending',
      status: 'error',
    });

    // Normal polls keep the issue suppressed; they cannot turn it back into a
    // recurring added/modified change.
    expect(store.recordCloudObservation({
      ...observation,
      lastSeenAt: '2026-07-17T00:01:00.000Z',
    })).toMatchObject({ syncState: 'feishu_pending' });
    expect(store.listFeishuPending()).toHaveLength(1);

    expect(store.requestFeishuPendingRecheck(['root-1'])).toBe(1);
    expect(store.recordCloudObservation({
      ...observation,
      lastSeenAt: '2026-07-17T00:02:00.000Z',
    })).toMatchObject({ syncState: 'synced' });
    expect(store.listFeishuPending()).toHaveLength(0);
    store.close();
  });

  it('requeues a legacy millisecond synced baseline instead of hiding it as synced', () => {
    const dbPath = createDatabasePath();
    const store = new LocalMapStore(dbPath);
    store.initialize();
    const observedSeconds = 1_783_050_076;

    store.recordCloudObservation({
      objToken: 'legacy-slides',
      wikiNodeToken: 'slides-node',
      objType: 'slides',
      title: '历史 Slides 占位',
      spaceId: 'space-1',
      parentNodeToken: 'root-1',
      watchedRootId: 'root-1',
      watchedRootUrl: 'https://tenant.feishu.cn/wiki/root-1',
      observedObjEditTime: observedSeconds,
      hasChild: false,
      observationStatus: 'available',
      lastSeenAt: '2026-07-17T00:00:00.000Z',
    });
    store.markDocumentSynced({
      objToken: 'legacy-slides',
      // Legacy code incorrectly persisted a local millisecond timestamp.
      syncedObjEditTime: 1_784_285_402_271,
      localMdPath: '/tmp/legacy-slides.md',
      localRelPath: '历史 Slides 占位.md',
      lastSyncedAt: '2026-07-17T00:01:00.000Z',
    });

    const observedAgain = store.recordCloudObservation({
      objToken: 'legacy-slides',
      wikiNodeToken: 'slides-node',
      objType: 'slides',
      title: '历史 Slides 占位',
      spaceId: 'space-1',
      parentNodeToken: 'root-1',
      watchedRootId: 'root-1',
      watchedRootUrl: 'https://tenant.feishu.cn/wiki/root-1',
      observedObjEditTime: observedSeconds,
      hasChild: false,
      observationStatus: 'available',
      lastSeenAt: '2026-07-17T00:02:00.000Z',
    });

    expect(observedAgain).toMatchObject({
      syncState: 'pending_modified',
      observedObjEditTime: observedSeconds,
      syncedObjEditTime: 1_784_285_402_271,
    });
    store.close();
  });

  it('backfills local records from structured root authority without erasing cloud-only ownership', () => {
    const dbPath = createDatabasePath();
    const kbRoot = path.join(path.dirname(dbPath), '知识库');
    const techUrl = 'https://tenant.feishu.cn/wiki/tech-root';
    const store = new LocalMapStore(dbPath);
    store.initialize();
    store.upsertDocument(makeDocument({
      objToken: 'local-tech-doc',
      localMdPath: path.join(kbRoot, '技术 - Dev', 'README.md'),
      watchedRootId: 'stale-root',
      watchedRootUrl: 'https://tenant.feishu.cn/wiki/stale-root',
    }));
    store.upsertDocument(makeDocument({
      objToken: 'cloud-only-doc',
      localMdPath: '',
      watchedRootId: 'remote-root',
      watchedRootUrl: 'https://tenant.feishu.cn/wiki/remote-root',
    }));

    const result = store.backfillWatchedRoots([{
      id: 'tech-root',
      url: techUrl,
      localDir: '技术 - Dev',
    }], kbRoot);

    expect(result).toMatchObject({ scanned: 2, tagged: 1, untagged: 1 });
    expect(store.getDocumentByObjToken('local-tech-doc')).toMatchObject({
      watchedRootId: 'tech-root',
      watchedRootUrl: techUrl,
    });
    expect(store.getDocumentByObjToken('cloud-only-doc')).toMatchObject({
      watchedRootId: 'remote-root',
      watchedRootUrl: 'https://tenant.feishu.cn/wiki/remote-root',
    });

    const roots = store.getWatchedRoots([
      {
        id: 'tech-root',
        url: techUrl,
        localDir: '技术 - Dev',
        layoutProfile: 'directory-readme',
        enabled: true,
      },
      {
        id: 'disabled-root',
        url: 'https://tenant.feishu.cn/wiki/disabled-root',
        localDir: '已停用',
        layoutProfile: 'directory-readme',
        enabled: false,
      },
    ]);
    expect(roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeToken: 'tech-root', childCount: 1, displayName: '技术 - Dev' }),
      expect.objectContaining({ nodeToken: 'disabled-root', childCount: 0, displayName: '[已停用] 已停用' }),
    ]));
    store.close();
  });
});
