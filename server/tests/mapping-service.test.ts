/**
 * MappingService unit tests (P2-T5/T7/T10 algorithm layer).
 *
 * Mirrors the ChangeDetector test pattern: an in-memory mock of
 * LocalMapStore + SnapshotService so the pure projection / reorder
 * logic is exercised without better-sqlite3 ABI dependency.
 *
 * Covers:
 *   - computeDiff: bucketing added/modified/deleted + unchanged/total stats
 *   - getTree: flat node projection, has_child inference, cloud_deleted filter
 *   - updateSortOrder:
 *       AC1 sibling reorder assigns 0..N
 *       AC2 setSortOrder called once per parent + snapshot refresh invoked
 *       AC3 (sync-preserve) - verified at SQL layer in local_map_store_sql.py
 *            (sync flow does not write local_sort_order; only setSortOrder does)
 *       AC4 new null-sortOrder nodes - verified by getTree sortOrder projection
 *   - cross-parent rejection: backend second-line defense (400 + mismatches)
 *   - empty reorder: no-op + snapshot still refreshed
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MappingService,
  MappingValidationError,
  CrossParentReorderError,
} from '../src/modules/mapping-service.js';
import type { ChangedDocument, DocumentRecord } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockLocalMapStore {
  rows = new Map<string, DocumentRecord>();
  setSortOrderCalls: Array<{ parent: string | null; ordered: string[] }> = [];

  getAllDocuments(): DocumentRecord[] {
    return Array.from(this.rows.values());
  }

  getDocumentByObjToken(tok: string): DocumentRecord | null {
    return this.rows.get(tok) ?? null;
  }

  setSortOrder(parent: string | null, ordered: string[]): number {
    this.setSortOrderCalls.push({ parent, ordered });
    let updated = 0;
    ordered.forEach((tok, idx) => {
      const r = this.rows.get(tok);
      if (r && (r.parentNodeToken ?? null) === parent) {
        this.rows.set(tok, { ...r, localSortOrder: idx });
        updated++;
      }
    });
    return updated;
  }

  listAllCustomFolderDocs(): DocumentRecord[] {
    return Array.from(this.rows.values()).filter(
      (r) => r.customFolderId != null && r.watchedRootUrl == null,
    );
  }
}

class MockChangeDetector {
  lastRootUrl: string | null = null;
  lastOptions: unknown = null;
  nextResult: {
    changedDocuments: ChangedDocument[];
    totalNodes: number;
    checkedAt: string;
  } = { changedDocuments: [], totalNodes: 0, checkedAt: '' };

  async detectChanges(rootUrl: string, options?: unknown) {
    this.lastRootUrl = rootUrl;
    this.lastOptions = options ?? null;
    return {
      changed: this.nextResult.changedDocuments.length > 0,
      changedDocuments: this.nextResult.changedDocuments,
      checkedAt: this.nextResult.checkedAt,
      totalNodes: this.nextResult.totalNodes,
    };
  }
}

class MockSnapshotService {
  generateCalls = 0;
  refreshCalls = 0;
  /** v0.2.0 structure-align Phase B: stub returns no prior snapshot. */
  readExistingResult: any = null;

  generate(): any {
    this.generateCalls++;
    return { version: '1.0', generated_at: new Date().toISOString() };
  }

  refreshSortOrder(): any {
    this.refreshCalls++;
    return { version: '1.0', generated_at: new Date().toISOString() };
  }

  readExisting(_kbRoot: string): any {
    return this.readExistingResult;
  }
}

function makeDoc(overrides: Partial<DocumentRecord>): DocumentRecord {
  return {
    objToken: 'TOK',
    wikiNodeToken: null,
    objType: 'docx',
    title: '',
    localMdPath: '',
    lastSyncedModifyTime: '',
    lastSyncedAt: '',
    status: 'synced',
    parentNodeToken: null,
    spaceId: null,
    objEditTime: null,
    cloudDeleted: 0,
    lastSeenAt: null,
    localSortOrder: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MappingService.computeDiff', () => {
  let store: MockLocalMapStore;
  let detector: MockChangeDetector;
  let snap: MockSnapshotService;
  let svc: MappingService;

  beforeEach(() => {
    store = new MockLocalMapStore();
    detector = new MockChangeDetector();
    snap = new MockSnapshotService();
    svc = new MappingService(detector as any, store as any, snap as any);
  });

  it('buckets changed docs into added/modified/deleted', async () => {
    detector.nextResult = {
      changedDocuments: [
        { objToken: 'A', objType: 'docx', title: 'a', changeType: 'added',
          cloudModifiedTime: '', localSyncedTime: null, localMdPath: null },
        { objToken: 'B', objType: 'docx', title: 'b', changeType: 'modified',
          cloudModifiedTime: '', localSyncedTime: null, localMdPath: null },
        { objToken: 'C', objType: 'docx', title: 'c', changeType: 'deleted',
          cloudModifiedTime: '', localSyncedTime: null, localMdPath: null },
      ],
      totalNodes: 10,
      checkedAt: '2026-06-18T00:00:00Z',
    };
    // 3 local rows exist (so totalLocal reflects store)
    store.rows.set('X', makeDoc({ objToken: 'X' }));
    store.rows.set('Y', makeDoc({ objToken: 'Y' }));
    store.rows.set('Z', makeDoc({ objToken: 'Z' }));

    const report = await svc.computeDiff('https://example/wiki/root');

    expect(detector.lastRootUrl).toBe('https://example/wiki/root');
    expect(detector.lastOptions).toEqual({ mode: 'fast' });
    expect(report.added).toHaveLength(1);
    expect(report.modified).toHaveLength(1);
    expect(report.deleted).toHaveLength(1);
    // unchanged = totalCloud - (added + modified)
    expect(report.unchanged).toBe(10 - 2);
    expect(report.totalCloud).toBe(10);
    expect(report.totalLocal).toBe(3);
    expect(report.checkedAt).toBe('2026-06-18T00:00:00Z');
  });

  it('clamps unchanged to zero when added+modified exceeds totalNodes', async () => {
    // Defensive: detectChanges contract shouldn't allow this, but
    // Math.max guards against negative counts if state drifts.
    detector.nextResult = {
      changedDocuments: [
        { objToken: 'A1', objType: 'docx', title: 'a1', changeType: 'added',
          cloudModifiedTime: '', localSyncedTime: null, localMdPath: null },
        { objToken: 'A2', objType: 'docx', title: 'a2', changeType: 'added',
          cloudModifiedTime: '', localSyncedTime: null, localMdPath: null },
        { objToken: 'M1', objType: 'docx', title: 'm1', changeType: 'modified',
          cloudModifiedTime: '', localSyncedTime: null, localMdPath: null },
        { objToken: 'D1', objType: 'docx', title: 'd1', changeType: 'deleted',
          cloudModifiedTime: '', localSyncedTime: null, localMdPath: null },
      ],
      totalNodes: 2, // smaller than added+modified (3) on purpose
      checkedAt: '2026-06-18T00:00:00Z',
    };
    const report = await svc.computeDiff('r');
    expect(report.unchanged).toBe(0); // max(0, 2 - 3) = 0
    expect(report.added).toHaveLength(2);
    expect(report.modified).toHaveLength(1);
    expect(report.deleted).toHaveLength(1);
  });

  it('deleted rows do not subtract from unchanged (deleted are local-side)', async () => {
    // 03 §3.6.1: deleted = local-side orphans; they are not part of
    // cloud traversal, so unchanged = totalCloud - (added + modified),
    // NOT minus deleted. Verifies this contract explicitly.
    detector.nextResult = {
      changedDocuments: [
        { objToken: 'D1', objType: 'docx', title: 'd1', changeType: 'deleted',
          cloudModifiedTime: '', localSyncedTime: null, localMdPath: null },
        { objToken: 'D2', objType: 'docx', title: 'd2', changeType: 'deleted',
          cloudModifiedTime: '', localSyncedTime: null, localMdPath: null },
      ],
      totalNodes: 5,
      checkedAt: '2026-06-18T00:00:00Z',
    };
    const report = await svc.computeDiff('r');
    expect(report.unchanged).toBe(5); // 5 - 0 added/modified
    expect(report.deleted).toHaveLength(2);
  });

  it('reads a persisted diff without starting another cloud detection', () => {
    const rootUrl = 'https://example.feishu.cn/wiki/rootA';
    store.rows.set('A', makeDoc({
      objToken: 'A',
      watchedRootUrl: rootUrl,
      watchedRootId: 'rootA',
      syncState: 'pending_added',
      observedObjEditTime: 200,
      lastSeenAt: '2026-07-21T01:00:00.000Z',
    }));
    store.rows.set('B', makeDoc({
      objToken: 'B',
      watchedRootUrl: rootUrl,
      watchedRootId: 'rootA',
      syncState: 'pending_modified',
      observedObjEditTime: 300,
      lastSeenAt: '2026-07-21T02:00:00.000Z',
    }));
    store.rows.set('OTHER', makeDoc({
      objToken: 'OTHER',
      watchedRootUrl: 'https://example.feishu.cn/wiki/rootB',
      watchedRootId: 'rootB',
      syncState: 'pending_modified',
    }));

    const report = svc.getStoredDiff(rootUrl);

    expect(detector.lastRootUrl).toBeNull();
    expect(report.added.map((item) => item.objToken)).toEqual(['A']);
    expect(report.modified.map((item) => item.objToken)).toEqual(['B']);
    expect(report.totalCloud).toBe(2);
    expect(report.checkedAt).toBe('2026-07-21T02:00:00.000Z');
  });

  it('projects mediaGapReason for pending_reason rows in the stored diff (media-gap grouping survives rebuild)', () => {
    const rootUrl = 'https://example.feishu.cn/wiki/rootA';
    store.rows.set('GAP', makeDoc({
      objToken: 'GAP',
      title: '图片缺失文档',
      watchedRootUrl: rootUrl,
      watchedRootId: 'rootA',
      syncState: 'pending_modified',
      status: 'changed',
      pendingReason: 'local_placeholder_tags',
      observedObjEditTime: 300,
      lastSeenAt: '2026-09-01T01:00:00.000Z',
    }));
    store.rows.set('NORMAL', makeDoc({
      objToken: 'NORMAL',
      watchedRootUrl: rootUrl,
      watchedRootId: 'rootA',
      syncState: 'pending_modified',
      observedObjEditTime: 400,
      lastSeenAt: '2026-09-01T02:00:00.000Z',
    }));
    store.rows.set('CUSTOM_GAP', makeDoc({
      objToken: 'CUSTOM_GAP',
      title: '归档图片缺失文档',
      syncState: 'pending_modified',
      status: 'changed',
      pendingReason: 'sheet_cloud_images_missing',
      customFolderId: 'folder-1',
    }));

    const report = svc.getStoredDiff(rootUrl);

    const gap = report.modified.find((item) => item.objToken === 'GAP');
    const customGap = report.modified.find((item) => item.objToken === 'CUSTOM_GAP');
    const normal = report.modified.find((item) => item.objToken === 'NORMAL');
    expect(gap?.changeType).toBe('modified');
    expect(gap?.mediaGapReason).toBe('local_placeholder_tags');
    expect(customGap?.changeType).toBe('modified');
    expect(customGap?.customFolderId).toBe('folder-1');
    expect(customGap?.mediaGapReason).toBe('sheet_cloud_images_missing');
    // Rows without the marker keep grouping gracefully as ordinary modified.
    expect(normal?.mediaGapReason).toBeUndefined();
  });

  it('excludes Feishu-side pending items from the recent-change diff', () => {
    const rootUrl = 'https://example.feishu.cn/wiki/rootA';
    store.rows.set('WAITING_FOR_ACCESS', makeDoc({
      objToken: 'WAITING_FOR_ACCESS',
      title: '等待飞书授权',
      watchedRootUrl: rootUrl,
      watchedRootId: 'rootA',
      syncState: 'feishu_pending',
      status: 'error',
      observedObjEditTime: 200,
      lastSeenAt: '2026-07-21T03:00:00.000Z',
    }));

    const report = svc.getStoredDiff(rootUrl);

    expect(report.added).toHaveLength(0);
    expect(report.modified).toHaveLength(0);
    expect(report.deleted).toHaveLength(0);
    expect(report.unchanged).toBe(1);
  });

  it('reconstructs a safe parent chain from persisted full-traversal topology', () => {
    const rootUrl = 'https://example.feishu.cn/wiki/rootA';
    store.rows.set('ROOT', makeDoc({
      objToken: 'ROOT',
      wikiNodeToken: 'rootA',
      title: '根目录',
      watchedRootUrl: rootUrl,
      watchedRootId: 'rootA',
      parentNodeToken: null,
      syncState: 'synced',
    }));
    store.rows.set('SECTION', makeDoc({
      objToken: 'SECTION',
      wikiNodeToken: 'sectionA',
      title: '200-系统设计',
      watchedRootUrl: rootUrl,
      watchedRootId: 'rootA',
      parentNodeToken: 'rootA',
      syncState: 'synced',
    }));
    store.rows.set('LEAF', makeDoc({
      objToken: 'LEAF',
      wikiNodeToken: 'leafA',
      title: '200-01-地图数据结构',
      watchedRootUrl: rootUrl,
      watchedRootId: 'rootA',
      parentNodeToken: 'sectionA',
      syncState: 'pending_added',
      observedObjEditTime: 300,
    }));

    const report = svc.getStoredDiff(rootUrl);

    expect(report.added).toEqual([
      expect.objectContaining({
        objToken: 'LEAF',
        parentChainTitles: ['200-系统设计'],
        isWatchedRootNode: false,
      }),
    ]);
  });

  it('keeps a pending node hierarchy undefined when an ancestor is absent', () => {
    const rootUrl = 'https://example.feishu.cn/wiki/rootA';
    store.rows.set('LEAF', makeDoc({
      objToken: 'LEAF',
      wikiNodeToken: 'leafA',
      title: '缺失父链文档',
      watchedRootUrl: rootUrl,
      watchedRootId: 'rootA',
      parentNodeToken: 'missing-parent',
      syncState: 'pending_added',
    }));

    const report = svc.getStoredDiff(rootUrl);

    expect(report.added[0]).toMatchObject({ objToken: 'LEAF' });
    expect(report.added[0]?.parentChainTitles).toBeUndefined();
    expect(report.added[0]?.isWatchedRootNode).toBeUndefined();
  });
});

describe('MappingService.getTree', () => {
  let store: MockLocalMapStore;
  let svc: MappingService;

  beforeEach(() => {
    store = new MockLocalMapStore();
    const detector = new MockChangeDetector();
    const snap = new MockSnapshotService();
    svc = new MappingService(detector as any, store as any, snap as any);
  });

  it('projects flat MappingNode[] and infers has_child from parent set', () => {
    // Parent P with two children; orphan Q with no parent.
    store.rows.set(
      'P',
      makeDoc({ objToken: 'P', wikiNodeToken: 'WNT_P', title: 'parent' }),
    );
    store.rows.set(
      'C1',
      makeDoc({ objToken: 'C1', parentNodeToken: 'WNT_P', title: 'c1' }),
    );
    store.rows.set(
      'C2',
      makeDoc({ objToken: 'C2', parentNodeToken: 'WNT_P', title: 'c2' }),
    );
    store.rows.set(
      'Q',
      makeDoc({ objToken: 'Q', wikiNodeToken: 'WNT_Q', title: 'orphan' }),
    );

    const nodes = svc.getTree();

    expect(nodes).toHaveLength(4);
    const parent = nodes.find((n) => n.obj_token === 'P')!;
    const c1 = nodes.find((n) => n.obj_token === 'C1')!;
    const q = nodes.find((n) => n.obj_token === 'Q')!;
    expect(parent.has_child).toBe(true);
    expect(c1.has_child).toBe(false);
    expect(q.has_child).toBe(false);
  });

  it('excludes cloud_deleted rows from tree', () => {
    store.rows.set(
      'LIVE',
      makeDoc({ objToken: 'LIVE', title: 'live', cloudDeleted: 0 }),
    );
    store.rows.set(
      'GONE',
      makeDoc({ objToken: 'GONE', title: 'gone', cloudDeleted: 1 }),
    );
    const nodes = svc.getTree();
    expect(nodes.map((n) => n.obj_token)).toEqual(['LIVE']);
  });

  it('AC4: new nodes with null sortOrder project sortOrder=null (Feishu original order)', () => {
    store.rows.set(
      'NEW',
      makeDoc({ objToken: 'NEW', localSortOrder: null }),
    );
    store.rows.set(
      'USER',
      makeDoc({ objToken: 'USER', localSortOrder: 5 }),
    );
    const nodes = svc.getTree();
    const newDoc = nodes.find((n) => n.obj_token === 'NEW')!;
    const userDoc = nodes.find((n) => n.obj_token === 'USER')!;
    expect(newDoc.sortOrder).toBeNull();
    expect(userDoc.sortOrder).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// v0.2.0 structure-align Phase B: dual-view (B4) + watched_root projection
// ---------------------------------------------------------------------------

/**
 * Mock that also implements the v4 methods used by getTreeDetailed.
 * Extends MockLocalMapStore so the existing tests keep working unchanged.
 */
class MockLocalMapStoreV4 extends MockLocalMapStore {
  watchedRootsResult: any[] = [];

  getWatchedRoots(_roots: any[]): any[] {
    return this.watchedRootsResult;
  }
}

class MockConfigManager {
  config: any;
  constructor(config: any) {
    this.config = config;
  }
  getConfig(): any {
    return this.config;
  }
}

describe('MappingService.getTreeDetailed (v0.2.0 structure-align Phase B)', () => {
  let store: MockLocalMapStoreV4;
  let snap: MockSnapshotService;
  let cfg: MockConfigManager;
  let svc: MappingService;

  const ROOT_A = 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb';
  const ROOT_B = 'https://qcnbafdrjx7n.feishu.cn/wiki/QdZpwOmgBi25JVkAUmYcBiMinIf';

  beforeEach(() => {
    store = new MockLocalMapStoreV4();
    snap = new MockSnapshotService();
    cfg = new MockConfigManager({
      watchedRoots: [
        {
          id: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
          url: ROOT_A,
          localDir: '策划 - Designer',
          layoutProfile: 'mirror-title-file',
          enabled: true,
        },
        {
          id: 'QdZpwOmgBi25JVkAUmYcBiMinIf',
          url: ROOT_B,
          localDir: '技术 - Dev',
          layoutProfile: 'directory-readme',
          enabled: true,
        },
      ],
      knowledgeBaseRoot: '/tmp/kb',
    });
    svc = new MappingService(
      new MockChangeDetector() as any,
      store as any,
      snap as any,
      cfg as any,
    );
  });

  it('feishu view filters out wiki_node_token=NULL rows', () => {
    // 3 rows: 2 with wiki_node_token, 1 local-only README (NULL token)
    store.rows.set(
      'CLOUD1',
      makeDoc({ objToken: 'CLOUD1', wikiNodeToken: 'WNT_1', title: 'cloud1' }),
    );
    store.rows.set(
      'CLOUD2',
      makeDoc({ objToken: 'CLOUD2', wikiNodeToken: 'WNT_2', title: 'cloud2' }),
    );
    store.rows.set(
      'LOCAL',
      makeDoc({ objToken: 'LOCAL', wikiNodeToken: null, title: 'README' }),
    );

    const env = svc.getTreeDetailed({ view: 'feishu' });

    expect(env.view).toBe('feishu');
    expect(env.nodes).toHaveLength(2);
    expect(env.nodes.map((n) => n.obj_token).sort()).toEqual(['CLOUD1', 'CLOUD2']);
    // Each node carries watched_root_url (null here since no backfill ran)
    for (const n of env.nodes) {
      expect(n).toHaveProperty('watched_root_url');
    }
  });

  it('local view returns all rows including wiki_node_token=NULL', () => {
    store.rows.set(
      'CLOUD1',
      makeDoc({ objToken: 'CLOUD1', wikiNodeToken: 'WNT_1', title: 'cloud1' }),
    );
    store.rows.set(
      'LOCAL1',
      makeDoc({ objToken: 'LOCAL1', wikiNodeToken: null, title: 'README' }),
    );

    const env = svc.getTreeDetailed({ view: 'local', includeOrphans: false });

    expect(env.view).toBe('local');
    expect(env.nodes).toHaveLength(2);
    // orphan_files empty because includeOrphans=false
    expect(env.orphan_files).toEqual([]);
  });

  it('watched_roots envelope reflects LocalMapStore.getWatchedRoots output', () => {
    store.watchedRootsResult = [
      {
        url: ROOT_A,
        nodeToken: 'Wramw1',
        title: '策划-Designer',
        displayName: '[策划] 策划设计',
        localDir: '策划 - Designer',
        trackMode: 'tracked',
        status: 'synced',
        lastDetectedAt: null,
        childCount: 5,
      },
      {
        url: ROOT_B,
        nodeToken: 'QdZpw',
        title: '技术-Dev',
        displayName: '[技术] 技术开发',
        localDir: '技术 - Dev',
        trackMode: 'tracked',
        status: 'missing_in_db',
        lastDetectedAt: null,
        childCount: 0,
      },
    ];

    const env = svc.getTreeDetailed({ view: 'feishu' });

    expect(env.watched_roots).toHaveLength(2);
    expect(env.watched_roots[0].displayName).toBe('[策划] 策划设计');
    expect(env.watched_roots[1].status).toBe('missing_in_db');
    expect(env.stats.watched_root_count).toBe(2);
  });

  it('stats.cloud_match_distribution counts the projected nodes', () => {
    store.rows.set(
      'S1',
      makeDoc({ objToken: 'S1', wikiNodeToken: 'W1', title: 'synced', cloudMatch: 'synced' }),
    );
    store.rows.set(
      'S2',
      makeDoc({ objToken: 'S2', wikiNodeToken: 'W2', title: 'synced2', cloudMatch: 'synced' }),
    );
    // Restricted but titled: a real restricted node whose title was
    // back-filled. Feishu view keeps it (only empty-title placeholders
    // are filtered — see "filters out placeholder nodes" test below).
    store.rows.set(
      'R1',
      makeDoc({ objToken: 'R1', wikiNodeToken: 'W3', title: 'restricted-doc', cloudMatch: 'restricted' }),
    );
    // Local-only: filtered out of feishu view, but counted in local view.
    store.rows.set(
      'L1',
      makeDoc({ objToken: 'L1', wikiNodeToken: null, title: 'README', cloudMatch: 'unknown' }),
    );

    const feishu = svc.getTreeDetailed({ view: 'feishu' });
    expect(feishu.stats.total_nodes).toBe(3);
    expect(feishu.stats.cloud_match_distribution).toEqual({
      synced: 2,
      restricted: 1,
    });

    const local = svc.getTreeDetailed({ view: 'local' });
    expect(local.stats.total_nodes).toBe(4);
    expect(local.stats.cloud_match_distribution).toEqual({
      synced: 2,
      restricted: 1,
      unknown: 1,
    });
  });

  it('feishu view filters out placeholder nodes (empty title with wiki_node_token)', () => {
    // Placeholder rows come from change-detector.upsertDocumentSeen's
    // permission-restricted branch: they have a non-empty wiki_node_token
    // (so they pass the first filter) but title='' / local_path=''.
    // Without the empty-title filter they would render as blank rows in
    // NodeTreeView. This test pins the fix.
    store.rows.set(
      'GOOD',
      makeDoc({ objToken: 'GOOD', wikiNodeToken: 'W_GOOD', title: 'real doc' }),
    );
    store.rows.set(
      'PH1',
      makeDoc({
        objToken: 'PH1',
        wikiNodeToken: 'W_PH1',
        title: '',
        status: 'placeholder',
        cloudMatch: 'restricted',
      }),
    );
    store.rows.set(
      'PH2',
      makeDoc({
        objToken: 'PH2',
        wikiNodeToken: 'W_PH2',
        title: '   ',
        status: 'placeholder',
        cloudMatch: 'restricted',
      }),
    );

    const feishu = svc.getTreeDetailed({ view: 'feishu' });

    // P2 Gate 2: placeholders remain visible with diagnostic titles.
    expect(feishu.nodes.map((n) => n.obj_token).sort()).toEqual(['GOOD', 'PH1', 'PH2']);
    expect(feishu.stats.total_nodes).toBe(3);
    const placeholders = feishu.nodes.filter((n) => n.obj_token.startsWith('PH'));
    expect(placeholders.every((n) => n.title.includes('权限受限') || n.title.length > 0)).toBe(true);

    // Local view keeps ALL rows (placeholder rows have local_path=''
    // and are naturally skipped by LocalDirTreeView's splitPath, so
    // keeping them here is correct and does not produce blank UI rows).
    const local = svc.getTreeDetailed({ view: 'local' });
    expect(local.nodes.map((n) => n.obj_token).sort()).toEqual(['GOOD', 'PH1', 'PH2']);
  });

  it('watched_root_url is projected from DocumentRecord.watchedRootUrl', () => {
    store.rows.set(
      'W1',
      makeDoc({
        objToken: 'W1',
        wikiNodeToken: 'WN1',
        title: 'w1',
        watchedRootUrl: ROOT_A,
      }),
    );

    const env = svc.getTreeDetailed({ view: 'feishu' });
    expect(env.nodes[0].watched_root_url).toBe(ROOT_A);
  });

  it('legacy getTree() still returns MappingNode[] (not envelope)', () => {
    store.rows.set(
      'A',
      makeDoc({ objToken: 'A', wikiNodeToken: 'WA', title: 'a' }),
    );
    const nodes = svc.getTree();
    expect(Array.isArray(nodes)).toBe(true);
    // Each node carries the new watched_root_url field
    expect(nodes[0]).toHaveProperty('watched_root_url');
  });

  it('default option (no view) falls back to feishu view', () => {
    store.rows.set(
      'CLOUD1',
      makeDoc({ objToken: 'CLOUD1', wikiNodeToken: 'WNT_1', title: 'cloud1' }),
    );
    store.rows.set(
      'LOCAL1',
      makeDoc({ objToken: 'LOCAL1', wikiNodeToken: null, title: 'README' }),
    );

    // Call without options — should default to feishu
    const env = (svc as any).getTreeDetailed() as any;
    expect(env.view).toBe('feishu');
    expect(env.nodes.map((n: any) => n.obj_token)).toEqual(['CLOUD1']);
  });

  it('excludes custom-folder archive docs from feishu view and legacy getTree', () => {
    // An archived doc still carries a non-empty wiki_node_token (reindex
    // writes the header-parsed token back; the custom_folder_id backfill
    // deliberately keeps it). custom_folder_id must gate it out of the
    // structure tree — the 自定义归档 section renders it instead.
    store.rows.set(
      'ARCHIVE',
      makeDoc({
        objToken: 'ARCHIVE',
        wikiNodeToken: 'WNT_ARCHIVE',
        title: 'archived doc',
        customFolderId: 'folder-1',
      }),
    );
    store.rows.set(
      'TREE',
      makeDoc({ objToken: 'TREE', wikiNodeToken: 'WNT_TREE', title: 'tree doc' }),
    );

    const feishu = svc.getTreeDetailed({ view: 'feishu' });
    expect(feishu.nodes.map((n) => n.obj_token)).toEqual(['TREE']);

    // Local view keeps every live row.
    const local = svc.getTreeDetailed({ view: 'local', includeOrphans: false });
    expect(local.nodes.map((n) => n.obj_token).sort()).toEqual(['ARCHIVE', 'TREE']);

    const legacy = svc.getTree();
    expect(legacy.map((n) => n.obj_token)).toEqual(['TREE']);
  });
});

describe('MappingService.updateSortOrder', () => {
  let store: MockLocalMapStore;
  let snap: MockSnapshotService;
  let svc: MappingService;

  beforeEach(() => {
    store = new MockLocalMapStore();
    const detector = new MockChangeDetector();
    snap = new MockSnapshotService();
    svc = new MappingService(detector as any, store as any, snap as any);
  });

  it('AC1/AC2: sibling reorder assigns 0..N and refreshes snapshot', () => {
    // Three siblings under PARENT_A.
    store.rows.set(
      'A1',
      makeDoc({ objToken: 'A1', parentNodeToken: 'PARENT_A' }),
    );
    store.rows.set(
      'A2',
      makeDoc({ objToken: 'A2', parentNodeToken: 'PARENT_A' }),
    );
    store.rows.set(
      'A3',
      makeDoc({ objToken: 'A3', parentNodeToken: 'PARENT_A' }),
    );

    const res = svc.updateSortOrder({
      parent_node_token: 'PARENT_A',
      ordered_obj_tokens: ['A3', 'A1', 'A2'],
    });

    expect(res.updated).toBe(3);
    expect(res.refreshed_index).toBe(true);
    // setSortOrder called exactly once with full ordering.
    expect(store.setSortOrderCalls).toHaveLength(1);
    expect(store.setSortOrderCalls[0]).toEqual({
      parent: 'PARENT_A',
      ordered: ['A3', 'A1', 'A2'],
    });
    // Each row's localSortOrder reflects array index.
    expect(store.rows.get('A3')!.localSortOrder).toBe(0);
    expect(store.rows.get('A1')!.localSortOrder).toBe(1);
    expect(store.rows.get('A2')!.localSortOrder).toBe(2);
    // Snapshot refresh invoked exactly once.
    expect(snap.refreshCalls).toBe(1);
  });

  it('rejects cross-parent tokens (backend second-line defense)', () => {
    store.rows.set(
      'A1',
      makeDoc({ objToken: 'A1', parentNodeToken: 'PARENT_A' }),
    );
    store.rows.set(
      'B1',
      makeDoc({ objToken: 'B1', parentNodeToken: 'PARENT_B' }),
    );

    expect(() =>
      svc.updateSortOrder({
        parent_node_token: 'PARENT_A',
        ordered_obj_tokens: ['A1', 'B1'],
      }),
    ).toThrow(CrossParentReorderError);

    // setSortOrder must NOT have been called (atomicity).
    expect(store.setSortOrderCalls).toHaveLength(0);
    // Snapshot must NOT have been refreshed on failure.
    expect(snap.refreshCalls).toBe(0);
  });

  it('CrossParentReorderError carries offending tokens', () => {
    store.rows.set(
      'GOOD',
      makeDoc({ objToken: 'GOOD', parentNodeToken: 'P' }),
    );
    store.rows.set(
      'BAD',
      makeDoc({ objToken: 'BAD', parentNodeToken: 'OTHER' }),
    );

    try {
      svc.updateSortOrder({
        parent_node_token: 'P',
        ordered_obj_tokens: ['GOOD', 'BAD'],
      });
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CrossParentReorderError);
      expect((e as CrossParentReorderError).mismatches).toEqual(['BAD']);
    }
  });

  it('rejects unknown tokens as cross-parent mismatch', () => {
    // Token not in store at all → counted as mismatch.
    expect(() =>
      svc.updateSortOrder({
        parent_node_token: 'P',
        ordered_obj_tokens: ['GHOST'],
      }),
    ).toThrow(CrossParentReorderError);
  });

  it('empty reorder is a no-op but still refreshes snapshot', () => {
    const res = svc.updateSortOrder({
      parent_node_token: 'P',
      ordered_obj_tokens: [],
    });
    expect(res.updated).toBe(0);
    expect(res.refreshed_index).toBe(true);
    // setSortOrder NOT called for empty input.
    expect(store.setSortOrderCalls).toHaveLength(0);
    // Snapshot still refreshed (cheap; keeps consistency).
    expect(snap.refreshCalls).toBe(1);
  });

  it('rejects non-array ordered_obj_tokens', () => {
    expect(() =>
      svc.updateSortOrder({
        parent_node_token: 'P',
        ordered_obj_tokens: 'not-an-array' as any,
      }),
    ).toThrow(MappingValidationError);
  });

  it('supports top-level reorder (parent_node_token=null)', () => {
    store.rows.set(
      'TOP1',
      makeDoc({ objToken: 'TOP1', parentNodeToken: null }),
    );
    store.rows.set(
      'TOP2',
      makeDoc({ objToken: 'TOP2', parentNodeToken: null }),
    );

    const res = svc.updateSortOrder({
      parent_node_token: null,
      ordered_obj_tokens: ['TOP2', 'TOP1'],
    });

    expect(res.updated).toBe(2);
    expect(store.rows.get('TOP2')!.localSortOrder).toBe(0);
    expect(store.rows.get('TOP1')!.localSortOrder).toBe(1);
  });
});
