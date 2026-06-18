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
}

class MockChangeDetector {
  lastRootUrl: string | null = null;
  nextResult: {
    changedDocuments: ChangedDocument[];
    totalNodes: number;
    checkedAt: string;
  } = { changedDocuments: [], totalNodes: 0, checkedAt: '' };

  async detectChanges(rootUrl: string) {
    this.lastRootUrl = rootUrl;
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

  generate(): any {
    this.generateCalls++;
    return { version: '1.0', generated_at: new Date().toISOString() };
  }

  refreshSortOrder(): any {
    this.refreshCalls++;
    return { version: '1.0', generated_at: new Date().toISOString() };
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
