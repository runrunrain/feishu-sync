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
    parentNodeToken: null,
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
  cloudNodes: LarkCliNodeInfo[]
) => Promise<ReturnType<ChangeDetector['detectChanges']>>;

async function runCompare(
  store: MockLocalMapStore,
  cloudNodes: LarkCliNodeInfo[]
) {
  const detector = new ChangeDetector(
    new MockLarkCliClient() as any,
    store as any
  );
  const fn = (detector as unknown as { compareWithLocalRecords: Comparator })
    .compareWithLocalRecords;
  return await fn.call(detector, cloudNodes);
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
