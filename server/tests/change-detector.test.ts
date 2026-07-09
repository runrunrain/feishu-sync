/**
 * ChangeDetector three-state identification tests (P2-T1/T3 algorithm layer).
 *
 * Per diting P1 review §五, the testing strategy is three-layer:
 *   1. Algorithm layer (this file): vitest with an in-memory mock of
 *      LocalMapStore. No better-sqlite3 ABI dependency. Validates the
 *      pure comparison logic for added / modified / deleted.
 *   2. SQL layer (local_map_store_sql.py): already covers the v2 SQL
 *      semantics; P2 additions (restoreCloudDeleted, purgeCloudDeleted,
 *      listCloudDeleted) need Python-side additions (see end of file).
 *   3. Integration layer: deferred to P5 (Electron runtime, real
 *      better-sqlite3 ABI match).
 *
 * The mock LocalMapStore implements only the methods ChangeDetector
 * touches: getDocumentByObjToken / getAllDocuments / upsertDocumentSeen
 * / markCloudDeleted. State is kept in plain Maps so test cases are
 * deterministic and inspectable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeDetector } from '../src/modules/change-detector.js';
import type { LarkCliNodeInfo, DocumentRecord } from '../src/types/index.js';

// ----- In-memory mock LocalMapStore -------------------------------------

interface MockRow extends DocumentRecord {
  // No extra fields; DocumentRecord already covers cloudDeleted / etc.
}

class MockLocalMapStore {
  rows = new Map<string, MockRow>();
  seenCalls: any[] = [];
  markCalls: Array<{ objToken: string; timestamp: string }> = [];

  getDocumentByObjToken(objToken: string): DocumentRecord | null {
    return this.rows.get(objToken) ?? null;
  }

  getAllDocuments(): DocumentRecord[] {
    return Array.from(this.rows.values());
  }

  upsertDocumentSeen(input: {
    objToken: string;
    wikiNodeToken?: string | null;
    parentNodeToken?: string | null;
    spaceId?: string | null;
    objEditTime?: number | null;
    lastSeenAt: string;
  }): void {
    this.seenCalls.push(input);
    const existing = this.rows.get(input.objToken);
    if (existing) {
      // Mimic COALESCE: only refresh mapping fields, preserve
      // status/local_md_path/title.
      this.rows.set(input.objToken, {
        ...existing,
        wikiNodeToken: input.wikiNodeToken ?? existing.wikiNodeToken,
        parentNodeToken: input.parentNodeToken ?? existing.parentNodeToken,
        spaceId: input.spaceId ?? existing.spaceId,
        objEditTime: input.objEditTime ?? existing.objEditTime,
        lastSeenAt: input.lastSeenAt,
      });
    } else {
      // Mimic INSERT placeholder row.
      this.rows.set(input.objToken, {
        objToken: input.objToken,
        wikiNodeToken: input.wikiNodeToken ?? null,
        objType: 'unknown',
        title: '',
        localMdPath: '',
        lastSyncedModifyTime: '',
        lastSyncedAt: input.lastSeenAt,
        status: 'placeholder',
        parentNodeToken: input.parentNodeToken ?? null,
        spaceId: input.spaceId ?? null,
        objEditTime: input.objEditTime ?? null,
        cloudDeleted: 0,
        lastSeenAt: input.lastSeenAt,
        localSortOrder: null,
      });
    }
  }

  markCloudDeleted(objToken: string, timestamp: string): void {
    this.markCalls.push({ objToken, timestamp });
    const existing = this.rows.get(objToken);
    if (existing) {
      this.rows.set(objToken, {
        ...existing,
        cloudDeleted: 1,
        lastSeenAt: timestamp,
      });
    }
  }
}

// ----- Mock LarkCliClient (only methods ChangeDetector uses) -------------

class MockLarkCliClient {
  // getNode is used by detectChanges() to resolve the root; not used
  // by compareWithLocalRecords directly (traverseWikiSubtree is
  // bypassed by exercising compareWithLocalRecords via a private
  // cast). Provide a stub so constructor wiring doesn't fail.
  async getNode(_url: string): Promise<LarkCliNodeInfo> {
    throw new Error('MockLarkCliClient.getNode not used in algorithm tests');
  }
  async listWikiNodes(_opts: any): Promise<any[]> {
    throw new Error('MockLarkCliClient.listWikiNodes not used in algorithm tests');
  }
}

// ----- Helpers -----------------------------------------------------------

function makeCloud(
  overrides: Partial<LarkCliNodeInfo> & Pick<LarkCliNodeInfo, 'obj_token' | 'node_token'>
): LarkCliNodeInfo {
  return {
    obj_type: 'docx',
    title: 't-' + overrides.obj_token,
    space_id: 'space-1',
    obj_edit_time: 0,
    has_child: false,
    ...overrides,
  };
}

function makeLocal(
  overrides: Partial<DocumentRecord> & Pick<DocumentRecord, 'objToken'>
): DocumentRecord {
  return {
    wikiNodeToken: null,
    objType: 'docx',
    title: 't-' + overrides.objToken,
    localMdPath: '/path/' + overrides.objToken + '.md',
    lastSyncedModifyTime: '',
    lastSyncedAt: '2026-06-01T00:00:00Z',
    status: 'synced',
    // v0.2.0 detect-traverse-fix: default parent_node_token to 'rootA'
    // so seeded local rows are considered members of the default
    // subtree under test. Without this, Pass 2 (subtree-scoped deleted
    // detection) would treat every seeded row as out-of-subtree and
    // never report it as deleted.
    parentNodeToken: 'rootA',
    spaceId: 'space-1',
    objEditTime: 1000,
    cloudDeleted: 0,
    lastSeenAt: '2026-06-01T00:00:00Z',
    localSortOrder: null,
    ...overrides,
  };
}

// CompareWithLocalRecords is private; access via cast for unit tests.
type Comparator = (
  cloudNodes: LarkCliNodeInfo[],
  rootToken: string
) => Promise<ReturnType<ChangeDetector['detectChanges']>>;

async function runCompare(
  store: MockLocalMapStore,
  cloudNodes: LarkCliNodeInfo[],
  rootToken = 'rootA'
) {
  const detector = new ChangeDetector(
    new MockLarkCliClient() as any,
    store as any
  );
  const fn = (detector as unknown as { compareWithLocalRecords: Comparator })
    .compareWithLocalRecords;
  return await fn.call(detector, cloudNodes, rootToken);
}

// ----- Tests -------------------------------------------------------------

describe('ChangeDetector.compareWithLocalRecords (P2-T1 three-state)', () => {
  let store: MockLocalMapStore;
  beforeEach(() => {
    store = new MockLocalMapStore();
  });

  it('identifies a brand-new cloud node as added', async () => {
    const cloud = [makeCloud({ obj_token: 'A', node_token: 'nA' })];
    const out = await runCompare(store, cloud);
    expect(out).toHaveLength(1);
    expect(out[0].changeType).toBe('added');
    expect(out[0].objToken).toBe('A');
  });

  it('identifies a modified node when cloud time > local time', async () => {
    store.rows.set(
      'A',
      makeLocal({ objToken: 'A', objEditTime: 1000 })
    );
    const cloud = [
      makeCloud({ obj_token: 'A', node_token: 'nA', obj_edit_time: 2000 }),
    ];
    const out = await runCompare(store, cloud);
    expect(out).toHaveLength(1);
    expect(out[0].changeType).toBe('modified');
    expect(out[0].objToken).toBe('A');
  });

  it('does NOT report modified when cloud time equals local time', async () => {
    store.rows.set(
      'A',
      makeLocal({ objToken: 'A', objEditTime: 2000 })
    );
    const cloud = [
      makeCloud({ obj_token: 'A', node_token: 'nA', obj_edit_time: 2000 }),
    ];
    const out = await runCompare(store, cloud);
    expect(out).toHaveLength(0);
  });

  it('does NOT report modified when cloud time is older than local', async () => {
    store.rows.set(
      'A',
      makeLocal({ objToken: 'A', objEditTime: 3000 })
    );
    const cloud = [
      makeCloud({ obj_token: 'A', node_token: 'nA', obj_edit_time: 2000 }),
    ];
    const out = await runCompare(store, cloud);
    expect(out).toHaveLength(0);
  });

  it('treats NULL cloud obj_edit_time as "unknown" — no modified report', async () => {
    // Mirrors the 3 permission-restricted docs case (diting P1 §五).
    store.rows.set(
      'A',
      makeLocal({ objToken: 'A', objEditTime: 1000 })
    );
    const cloud = [
      // LarkCliNodeInfo declares obj_edit_time as number; we pass 0 to
      // represent "fetched but permission-restricted → falsy". The
      // compareWithLocalRecords uses `node.obj_edit_time || null` to
      // coerce 0 → null.
      makeCloud({ obj_token: 'A', node_token: 'nA', obj_edit_time: 0 }),
    ];
    const out = await runCompare(store, cloud);
    expect(out).toHaveLength(0);
  });

  it('treats NULL local obj_edit_time as "unknown" — no modified report', async () => {
    store.rows.set(
      'A',
      makeLocal({ objToken: 'A', objEditTime: null as unknown as number })
    );
    const cloud = [
      makeCloud({ obj_token: 'A', node_token: 'nA', obj_edit_time: 5000 }),
    ];
    const out = await runCompare(store, cloud);
    expect(out).toHaveLength(0);
  });

  it('identifies a deleted node when local exists but cloud does not surface it', async () => {
    store.rows.set(
      'A',
      makeLocal({ objToken: 'A', objEditTime: 1000, status: 'synced' })
    );
    // Cloud traversal returns nothing for A.
    const out = await runCompare(store, []);
    expect(out).toHaveLength(1);
    expect(out[0].changeType).toBe('deleted');
    expect(out[0].objToken).toBe('A');
    expect(store.markCalls).toEqual([
      { objToken: 'A', timestamp: expect.any(String) },
    ]);
  });

  it('does NOT report placeholder rows as deleted (B1 special-case)', async () => {
    store.rows.set(
      'A',
      makeLocal({ objToken: 'A', status: 'placeholder' })
    );
    const out = await runCompare(store, []);
    expect(out).toHaveLength(0);
    expect(store.markCalls).toHaveLength(0);
  });

  it('does NOT re-report already-soft-deleted rows on subsequent runs', async () => {
    store.rows.set(
      'A',
      makeLocal({ objToken: 'A', cloudDeleted: 1 })
    );
    const out = await runCompare(store, []);
    expect(out).toHaveLength(0);
  });

  it('persists mapping metadata via upsertDocumentSeen for every cloud node', async () => {
    const cloud = [
      makeCloud({
        obj_token: 'A',
        node_token: 'nA',
        obj_edit_time: 100,
        parent_node_token: 'parentA',
      }),
      makeCloud({
        obj_token: 'B',
        node_token: 'nB',
        obj_edit_time: 200,
        parent_node_token: 'parentB',
      }),
    ];
    await runCompare(store, cloud);
    expect(store.seenCalls).toHaveLength(2);
    expect(store.seenCalls[0]).toMatchObject({
      objToken: 'A',
      wikiNodeToken: 'nA',
      parentNodeToken: 'parentA',
      objEditTime: 100,
    });
    expect(store.seenCalls[1]).toMatchObject({
      objToken: 'B',
      parentNodeToken: 'parentB',
      objEditTime: 200,
    });
  });

  it('handles a mixed batch: added + modified + unchanged + deleted', async () => {
    // Seed: B synced at 1000 (will be modified), C synced (unchanged),
    // D synced (deleted — not in cloud).
    store.rows.set('B', makeLocal({ objToken: 'B', objEditTime: 1000 }));
    store.rows.set('C', makeLocal({ objToken: 'C', objEditTime: 5000 }));
    store.rows.set('D', makeLocal({ objToken: 'D', objEditTime: 100 }));

    const cloud = [
      makeCloud({ obj_token: 'A', node_token: 'nA' }), // added
      makeCloud({
        obj_token: 'B',
        node_token: 'nB',
        obj_edit_time: 2000,
      }), // modified
      makeCloud({
        obj_token: 'C',
        node_token: 'nC',
        obj_edit_time: 5000,
      }), // unchanged
    ];

    const out = await runCompare(store, cloud);
    expect(out.map((c) => c.changeType).sort()).toEqual([
      'added',
      'deleted',
      'modified',
    ]);
    const byType = new Map(out.map((c) => [c.changeType, c.objToken]));
    expect(byType.get('added')).toBe('A');
    expect(byType.get('modified')).toBe('B');
    expect(byType.get('deleted')).toBe('D');
  });

  // v0.2.0 detect-traverse-fix: regression test for the multi-watchedRoot
  // false-delete bug. Running detect on rootA must NOT flag rows belonging
  // to rootB (different subtree) as deleted, even when those rows are
  // absent from rootA's cloud traversal.
  it('does NOT flag rows belonging to a different watchedRoot as deleted (detect-traverse-fix)', async () => {
    // rootB-local row: wiki_node_token and parent_node_token both outside
    // rootA's traversal set.
    store.rows.set(
      'X',
      makeLocal({
        objToken: 'X',
        wikiNodeToken: 'nX-rootB',
        parentNodeToken: 'rootB',
        objEditTime: 1000,
        status: 'synced',
      })
    );
    // Local-only README (no wiki_node_token, parent not in any traversal).
    store.rows.set(
      'Y',
      makeLocal({
        objToken: 'Y',
        wikiNodeToken: null,
        parentNodeToken: null,
        objEditTime: 1000,
        status: 'synced',
      })
    );
    // rootA row that IS legitimately absent → should be flagged deleted.
    store.rows.set(
      'Z',
      makeLocal({
        objToken: 'Z',
        wikiNodeToken: 'nZ-rootA',
        parentNodeToken: 'rootA',
        objEditTime: 1000,
        status: 'synced',
      })
    );

    // Detect on rootA: cloud returns nothing (all rows absent).
    const out = await runCompare(store, [], 'rootA');

    // Only Z is in rootA's subtree (via parent_node_token='rootA'); X and Y
    // must NOT be reported as deleted.
    const deleted = out.filter((c) => c.changeType === 'deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0].objToken).toBe('Z');
    expect(store.markCalls).toEqual([
      { objToken: 'Z', timestamp: expect.any(String) },
    ]);
  });

  it('upsertDocumentSeen preserves status/local_md_path on existing rows', async () => {
    store.rows.set(
      'A',
      makeLocal({
        objToken: 'A',
        status: 'synced',
        localMdPath: '/keep/me.md',
        objEditTime: 1000,
        title: 'original-title',
      })
    );
    const cloud = [
      makeCloud({
        obj_token: 'A',
        node_token: 'nA',
        title: 'cloud-title',
        obj_edit_time: 1500,
      }),
    ];
    await runCompare(store, cloud);
    // Title and localMdPath must survive the seen refresh.
    const row = store.rows.get('A')!;
    expect(row.localMdPath).toBe('/keep/me.md');
    expect(row.status).toBe('synced');
    expect(row.title).toBe('original-title');
    expect(row.objEditTime).toBe(1500); // refreshed
  });
});

// ----- detectSheetSubChanges tests (P2-T4) -------------------------------

describe('ChangeDetector.detectSheetSubChanges (P2-T4)', () => {
  let store: MockLocalMapStore;

  beforeEach(() => {
    store = new MockLocalMapStore();
    // Extend mock with sheet_sheets map for sub-sheet change tests.
    (store as any).sheetSheets = new Map<string, any[]>();
    (store as any).getSheetSheets = function (sheetObjToken: string) {
      return this.sheetSheets.get(sheetObjToken) ?? [];
    };
  });

  function runSheet(
    sheetObjToken: string,
    cloudEditTime: number | null,
    cloudSheets: Array<{ sheet_id: string; title: string }>
  ) {
    const detector = new ChangeDetector(
      new MockLarkCliClient() as any,
      store as any
    );
    return detector.detectSheetSubChanges(sheetObjToken, cloudEditTime, cloudSheets);
  }

  it('reports added sub-sheets when cloud has new sheet_ids', async () => {
    (store as any).sheetSheets.set('WB', [
      { sheet_id: 's1', sheet_title: 'old' },
    ]);
    const out = await runSheet('WB', null, [
      { sheet_id: 's1', title: 'old' },
      { sheet_id: 's2', title: 'new' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sheetId: 's2',
      changeType: 'added',
      title: 'new',
    });
  });

  it('reports deleted sub-sheets when local has sheet_ids not in cloud', async () => {
    (store as any).sheetSheets.set('WB', [
      { sheet_id: 's1', sheet_title: 'old1' },
      { sheet_id: 's2', sheet_title: 'old2' },
    ]);
    const out = await runSheet('WB', null, [
      { sheet_id: 's1', title: 'old1' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sheetId: 's2',
      changeType: 'deleted',
      title: 'old2',
    });
  });

  it('reports may-be-modified for all sub-sheets when workbook obj_edit_time advanced', async () => {
    store.rows.set(
      'WB',
      makeLocal({ objToken: 'WB', objEditTime: 1000 })
    );
    (store as any).sheetSheets.set('WB', [
      { sheet_id: 's1', sheet_title: 't1' },
      { sheet_id: 's2', sheet_title: 't2' },
    ]);
    const out = await runSheet('WB', 5000, [
      { sheet_id: 's1', title: 't1' },
      { sheet_id: 's2', title: 't2' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.changeType === 'may-be-modified')).toBe(true);
  });

  it('does NOT report may-be-modified when workbook time has not advanced', async () => {
    store.rows.set(
      'WB',
      makeLocal({ objToken: 'WB', objEditTime: 5000 })
    );
    (store as any).sheetSheets.set('WB', [
      { sheet_id: 's1', sheet_title: 't1' },
    ]);
    const out = await runSheet('WB', 5000, [
      { sheet_id: 's1', title: 't1' },
    ]);
    expect(out).toHaveLength(0);
  });

  it('does NOT report may-be-modified when local workbook obj_edit_time is NULL', async () => {
    // Mirrors the permission-restricted-docs defense.
    store.rows.set(
      'WB',
      makeLocal({ objToken: 'WB', objEditTime: null as unknown as number })
    );
    (store as any).sheetSheets.set('WB', [
      { sheet_id: 's1', sheet_title: 't1' },
    ]);
    const out = await runSheet('WB', 5000, [
      { sheet_id: 's1', title: 't1' },
    ]);
    expect(out).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// v0.2.0 sync-state-timeout-fix: detect-result cache (QPS burst collapse)
//
// These tests pin the behavior of ChangeDetector.detectChanges's short-lived
// result cache, added to prevent the post-detect UI burst (useSyncStatus +
// ChangeListPanel + polling) from triggering 5 concurrent lark-cli detect
// calls that exceed the upstream QPS limit and 500-out the diff endpoint.
// ---------------------------------------------------------------------------

class TrackingLarkCliClient {
  // Counter exercises the cache: each uncached detect call should bump
  // getNode invocations exactly once.
  getNodeCalls = 0;
  listCalls = 0;
  async getNode(_url: string): Promise<LarkCliNodeInfo> {
    this.getNodeCalls++;
    return {
      obj_token: 'rootObj',
      node_token: 'rootA',
      obj_type: 'docx',
      title: 'root',
      space_id: 'space-1',
      obj_edit_time: 1000,
      has_child: false,
      parent_node_token: undefined,
    };
  }
  async listWikiNodes(_opts: any): Promise<any[]> {
    this.listCalls++;
    // No children: root is the only node. This keeps the test focused on
    // the cache (not three-state algorithm coverage, which is exercised
    // above).
    return [];
  }
}

describe('ChangeDetector.detectChanges result cache (sync-state-timeout-fix)', () => {
  it('serves a second call within TTL from cache (no extra lark-cli calls)', async () => {
    const lark = new TrackingLarkCliClient();
    const store = new MockLocalMapStore();
    const detector = new ChangeDetector(lark as any, store as any);

    const url = 'https://qcnbafdrjx7n.feishu.cn/wiki/rootA';
    const r1 = await detector.detectChanges(url);
    const firstCalls = lark.getNodeCalls;
    expect(firstCalls).toBeGreaterThanOrEqual(1);

    const r2 = await detector.detectChanges(url);
    // Same result reference (cache hit returns the stored object).
    expect(r2).toBe(r1);
    // No additional getNode calls were issued.
    expect(lark.getNodeCalls).toBe(firstCalls);
  });

  it('forceFresh=true bypasses the cache and re-invokes lark-cli', async () => {
    const lark = new TrackingLarkCliClient();
    const store = new MockLocalMapStore();
    const detector = new ChangeDetector(lark as any, store as any);

    const url = 'https://qcnbafdrjx7n.feishu.cn/wiki/rootA';
    await detector.detectChanges(url);
    const callsAfterFirst = lark.getNodeCalls;

    // bypassCooldown is required in tests because the production cooldown
    // would otherwise suppress the second traversal (see DETECT_COOLDOWN_MS
    // rationale). Production code paths do NOT set this flag.
    await detector.detectChanges(url, { forceFresh: true, bypassCooldown: true });
    expect(lark.getNodeCalls).toBeGreaterThan(callsAfterFirst);
  });

  it('forceFresh respects the per-root cooldown: a second detect within cooldown returns cached result (§问题2 fix)', async () => {
    const lark = new TrackingLarkCliClient();
    const store = new MockLocalMapStore();
    const detector = new ChangeDetector(lark as any, store as any);

    const url = 'https://qcnbafdrjx7n.feishu.cn/wiki/rootA';
    const r1 = await detector.detectChanges(url, { forceFresh: true });
    const callsAfterFirst = lark.getNodeCalls;

    // Second detect immediately after — must NOT re-traverse. This is the
    // behavior that prevents the user's double-click from blowing past the
    // lark-cli QPS budget ("第二次检测失败" root cause).
    const r2 = await detector.detectChanges(url, { forceFresh: true });
    expect(r2).toBe(r1);
    expect(lark.getNodeCalls).toBe(callsAfterFirst);
  });

  it('uses a different cache slot per rootUrl (no cross-root leakage)', async () => {
    const lark = new TrackingLarkCliClient();
    const store = new MockLocalMapStore();
    const detector = new ChangeDetector(lark as any, store as any);

    const urlA = 'https://qcnbafdrjx7n.feishu.cn/wiki/rootA';
    const urlB = 'https://qcnbafdrjx7n.feishu.cn/wiki/rootB';

    await detector.detectChanges(urlA);
    const callsAfterA = lark.getNodeCalls;

    // Different root: cache miss, must invoke lark-cli again.
    await detector.detectChanges(urlB);
    expect(lark.getNodeCalls).toBeGreaterThan(callsAfterA);
  });
});

// ---------------------------------------------------------------------------
// v0.2.0 change-detection-ttl: fingerprint short-circuit TTL (diagnosis §2.2
// 根因 A fix)
//
// Pins the behavior of the TTL bound added to traverseWikiSubtree's
// fingerprint short-circuit. Without the TTL, a node whose (title,
// obj_token) fingerprint matched the local row reused the local
// obj_edit_time indefinitely, so content-only edits (title unchanged)
// were silently missed. The TTL forces a periodic wiki +node-get refresh
// even on fingerprint hits.
//
// The mock client distinguishes root traversal from per-node node-get by
// the URL suffix, and records every getNode URL so tests can assert
// exactly which calls fired.
// ---------------------------------------------------------------------------

class TtlTrackingLarkCliClient {
  getNodeUrls: string[] = [];

  async getNode(url: string): Promise<LarkCliNodeInfo> {
    this.getNodeUrls.push(url);
    if (url.endsWith('/wiki/rootA')) {
      // Root of the subtree under test.
      return {
        node_token: 'rootA',
        obj_token: 'rootObj',
        obj_type: 'docx',
        title: 'root-title',
        space_id: 'space-1',
        obj_edit_time: 1000,
        has_child: true,
        parent_node_token: undefined,
      };
    }
    // fetchNodeDetail URL pattern: https://...feishu.cn/wiki/<nodeToken>.
    // Return a "cloud advanced" edit time so a fingerprint-miss / TTL-
    // expired refresh surfaces a modified event against the seeded local
    // row (obj_edit_time=1000).
    const token = url.substring(url.lastIndexOf('/') + 1);
    return {
      node_token: token,
      obj_token: 'obj-' + token,
      obj_type: 'docx',
      title: 'child-title',
      space_id: 'space-1',
      obj_edit_time: 5000,
      has_child: false,
    };
  }

  async listWikiNodes(_opts: any): Promise<any[]> {
    // Single child whose fingerprint (title+obj_token) matches the seeded
    // local row when the test sets title='child-title'.
    return [
      {
        node_token: 'childN1',
        obj_token: 'obj-childN1',
        obj_type: 'docx',
        title: 'child-title',
        has_child: false,
        parent_node_token: 'rootA',
        space_id: 'space-1',
      },
    ];
  }
}

const TTL_ROOT_URL = 'https://qcnbafdrjx7n.feishu.cn/wiki/rootA';
const TTL_CHILD_NODE_GET_URL =
  'https://qcnbafdrjx7n.feishu.cn/wiki/childN1';

describe('ChangeDetector fingerprint short-circuit TTL (change-detection-ttl, §2.2 根因 A fix)', () => {
  it('fingerprint hit + TTL fresh → reuses cached obj_edit_time, skips node-get', async () => {
    const lark = new TtlTrackingLarkCliClient();
    const store = new MockLocalMapStore();
    // Local row matches cloud fingerprint (title+obj_token) and carries a
    // stale obj_edit_time (1000 vs cloud's real 5000). Without the TTL
    // guard this is exactly the silent-miss scenario.
    store.rows.set(
      'obj-childN1',
      makeLocal({
        objToken: 'obj-childN1',
        wikiNodeToken: 'childN1',
        title: 'child-title',
        objEditTime: 1000,
        parentNodeToken: 'rootA',
      })
    );

    const detector = new ChangeDetector(lark as any, store as any);
    // Pretend the TTL was refreshed moments ago → short-circuit should fire.
    (detector as any).lastObjEditTimeRefreshAt.set('obj-childN1', Date.now());

    const result = await detector.detectChanges(TTL_ROOT_URL, {
      forceFresh: true,
      bypassCooldown: true,
    });

    // Only the root getNode call happened — no per-node node-get.
    expect(lark.getNodeUrls).toEqual([TTL_ROOT_URL]);
    // Because cloud time was reused as the stale local 1000, no modified
    // event fires for obj-childN1 (this is the cost of the optimization,
    // accepted within one TTL window).
    const modified = result.changedDocuments.filter(
      (c) => c.objToken === 'obj-childN1' && c.changeType === 'modified'
    );
    expect(modified).toHaveLength(0);
  });

  it('fingerprint hit + TTL expired → fires node-get and reports modified', async () => {
    const lark = new TtlTrackingLarkCliClient();
    const store = new MockLocalMapStore();
    store.rows.set(
      'obj-childN1',
      makeLocal({
        objToken: 'obj-childN1',
        wikiNodeToken: 'childN1',
        title: 'child-title',
        objEditTime: 1000, // local stale; cloud returns 5000
        parentNodeToken: 'rootA',
      })
    );

    const detector = new ChangeDetector(lark as any, store as any);
    // TTL expired 2h ago → fingerprint hit must NOT short-circuit.
    (detector as any).lastObjEditTimeRefreshAt.set(
      'obj-childN1',
      Date.now() - 2 * 60 * 60 * 1000
    );

    const result = await detector.detectChanges(TTL_ROOT_URL, {
      forceFresh: true,
      bypassCooldown: true,
    });

    // Root + one node-get for childN1.
    expect(lark.getNodeUrls).toEqual([TTL_ROOT_URL, TTL_CHILD_NODE_GET_URL]);
    // CloudTime 5000 > localTime 1000 → modified reported. This is the
    // core regression assertion: before the TTL fix this branch never
    // fired for content-only edits.
    const modified = result.changedDocuments.filter(
      (c) => c.objToken === 'obj-childN1' && c.changeType === 'modified'
    );
    expect(modified).toHaveLength(1);
  });

  it('fingerprint miss (title changed) → fires node-get regardless of TTL freshness', async () => {
    const lark = new TtlTrackingLarkCliClient();
    const store = new MockLocalMapStore();
    // Local title differs from cloud's 'child-title' → fingerprint miss.
    store.rows.set(
      'obj-childN1',
      makeLocal({
        objToken: 'obj-childN1',
        wikiNodeToken: 'childN1',
        title: 'OLD-title',
        objEditTime: 1000,
        parentNodeToken: 'rootA',
      })
    );

    const detector = new ChangeDetector(lark as any, store as any);
    // Even with a fresh TTL, fingerprint miss must trigger node-get.
    (detector as any).lastObjEditTimeRefreshAt.set('obj-childN1', Date.now());

    await detector.detectChanges(TTL_ROOT_URL, {
      forceFresh: true,
      bypassCooldown: true,
    });

    expect(lark.getNodeUrls).toEqual([TTL_ROOT_URL, TTL_CHILD_NODE_GET_URL]);
  });

  it('process-restart semantics: empty tracker → first detect fires node-get (bounded burst)', async () => {
    const lark = new TtlTrackingLarkCliClient();
    const store = new MockLocalMapStore();
    store.rows.set(
      'obj-childN1',
      makeLocal({
        objToken: 'obj-childN1',
        wikiNodeToken: 'childN1',
        title: 'child-title',
        objEditTime: 1000,
        parentNodeToken: 'rootA',
      })
    );

    const detector = new ChangeDetector(lark as any, store as any);
    // Do NOT pre-seed lastObjEditTimeRefreshAt — simulates a fresh boot.

    await detector.detectChanges(TTL_ROOT_URL, {
      forceFresh: true,
      bypassCooldown: true,
    });

    // Empty tracker ⇒ lastRefresh=0 ⇒ ttlExpired=true ⇒ node-get fires.
    // This pins the documented "first detect after restart is a full
    // refresh" behavior (acceptable QPS burst — see OBJ_EDIT_TIME_REFRESH_TTL_MS
    // header comment for the rationale).
    expect(lark.getNodeUrls).toEqual([TTL_ROOT_URL, TTL_CHILD_NODE_GET_URL]);
  });

  it('refresh attempt is recorded even when node-get fails, preventing retry storms', async () => {
    // A failing node-get must still stamp lastObjEditTimeRefreshAt so the
    // next poll within the same TTL window doesn't re-attempt (which would
    // multiply QPS without unblocking the failure).
    const failingLark = new (class extends TtlTrackingLarkCliClient {
      async getNode(url: string): Promise<LarkCliNodeInfo> {
        this.getNodeUrls.push(url);
        if (url.endsWith('/wiki/rootA')) {
          return {
            node_token: 'rootA',
            obj_token: 'rootObj',
            obj_type: 'docx',
            title: 'root-title',
            space_id: 'space-1',
            obj_edit_time: 1000,
            has_child: true,
            parent_node_token: undefined,
          };
        }
        // Per-node node-get always fails (e.g. permission revoked).
        throw new Error('无权限访问该节点');
      }
    })();
    const store = new MockLocalMapStore();
    store.rows.set(
      'obj-childN1',
      makeLocal({
        objToken: 'obj-childN1',
        wikiNodeToken: 'childN1',
        title: 'child-title',
        objEditTime: 1000,
        parentNodeToken: 'rootA',
      })
    );

    const detector = new ChangeDetector(failingLark as any, store as any);

    // First detect: TTL expired (empty tracker) → attempt node-get → fails.
    await detector.detectChanges(TTL_ROOT_URL, {
      forceFresh: true,
      bypassCooldown: true,
    });
    expect(failingLark.getNodeUrls).toEqual([TTL_ROOT_URL, TTL_CHILD_NODE_GET_URL]);
    // Failure still recorded → next call within TTL must NOT re-attempt.
    failingLark.getNodeUrls = [];

    await detector.detectChanges(TTL_ROOT_URL, {
      forceFresh: true,
      bypassCooldown: true,
    });
    expect(failingLark.getNodeUrls).toEqual([TTL_ROOT_URL]);
  });
});
