/**
 * Custom-folder archive sync tracking tests.
 *
 * Covers the four implementation blocks for bringing quick-added custom
 * documents (custom_folder_id non-null, watched_root_url NULL) into the
 * detection → diff → sync pipeline:
 *
 *   1. ChangeDetector.detectCustomFolderChanges: modified detection,
 *      no-change skip, NaN defense, getNode failure does not mark deleted.
 *   2. MappingService.computeDiff / getStoredDiff: custom modified docs
 *      appear in the modified bucket.
 *   3. operation-manifest planDocument: custom docs bypass watchedRoot
 *      validation and reuse their existing _custom/ localMdPath.
 *
 * Strategy: in-memory mocks (no better-sqlite3 ABI dependency), mirroring
 * the change-detector.test.ts and mapping-service.test.ts patterns.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeDetector } from '../src/modules/change-detector.js';
import { MappingService } from '../src/modules/mapping-service.js';
import { createOperationManifest } from '../src/modules/operation-manifest.js';
import type {
  CloudNodeObservation,
  DocumentRecord,
  LarkCliNodeInfo,
  SyncState,
  ChangedDocument,
} from '../src/types/index.js';

// ===========================================================================
// Mock LocalMapStore
// ===========================================================================

class MockLocalMapStore {
  rows = new Map<string, DocumentRecord>();

  getDocumentByObjToken(objToken: string): DocumentRecord | null {
    return this.rows.get(objToken) ?? null;
  }

  getAllDocuments(): DocumentRecord[] {
    return Array.from(this.rows.values());
  }

  listAllCustomFolderDocs(): DocumentRecord[] {
    return Array.from(this.rows.values()).filter(
      (r) => r.customFolderId != null && r.watchedRootUrl == null && r.cloudDeleted !== 1,
    );
  }

  recordCloudObservation(
    input: CloudNodeObservation & { lastSeenAt: string },
  ): DocumentRecord {
    const existing = this.rows.get(input.objToken);
    const previousState = existing?.syncState ?? this.legacyState(existing);
    let nextState: SyncState;

    if (!existing) {
      nextState = input.observationStatus === 'restricted' ? 'restricted' : 'pending_added';
    } else if (input.observationStatus === 'restricted') {
      nextState = 'restricted';
    } else if (input.observationStatus === 'unavailable') {
      nextState = previousState;
    } else if (
      previousState === 'pending_added' ||
      previousState === 'pending_modified' ||
      previousState === 'error'
    ) {
      nextState = previousState;
    } else {
      const synced = existing.syncedObjEditTime ?? null;
      const hasLocalContent = existing.localMdPath.length > 0;
      if (
        previousState === 'restricted' ||
        previousState === 'missing_candidate' ||
        previousState === 'deleted_confirmed'
      ) {
        if (!hasLocalContent) nextState = 'pending_added';
        else if (
          synced == null ||
          input.observedObjEditTime == null ||
          input.observedObjEditTime > synced
        )
          nextState = 'pending_modified';
        else nextState = 'synced';
      } else if (
        synced == null ||
        (input.observedObjEditTime != null && input.observedObjEditTime > synced)
      ) {
        nextState = hasLocalContent ? 'pending_modified' : 'pending_added';
      } else {
        nextState = 'synced';
      }
    }

    const row: DocumentRecord = {
      objToken: input.objToken,
      wikiNodeToken: input.wikiNodeToken || existing?.wikiNodeToken || null,
      objType: input.objType,
      title: input.title || existing?.title || '',
      localMdPath: existing?.localMdPath ?? '',
      lastSyncedModifyTime: existing?.lastSyncedModifyTime ?? '',
      lastSyncedAt: existing?.lastSyncedAt ?? '',
      status: this.legacyStatus(nextState),
      parentNodeToken: input.parentNodeToken ?? existing?.parentNodeToken ?? null,
      spaceId: input.spaceId ?? existing?.spaceId ?? null,
      objEditTime: input.observedObjEditTime ?? existing?.objEditTime ?? null,
      observedObjEditTime:
        input.observedObjEditTime ?? existing?.observedObjEditTime ?? existing?.objEditTime ?? null,
      syncedObjEditTime: existing?.syncedObjEditTime ?? null,
      syncState: nextState,
      watchedRootId: input.watchedRootId || existing?.watchedRootId || null,
      watchedRootUrl: input.watchedRootUrl ?? existing?.watchedRootUrl ?? null,
      hasChild: input.hasChild,
      cloudDeleted: 0,
      lastSeenAt: input.lastSeenAt,
      localSortOrder: existing?.localSortOrder ?? null,
      missingCompleteCount: 0,
      cloudMatch: existing?.cloudMatch ?? 'unknown',
      originalLink: existing?.originalLink ?? null,
      localRelPath: existing?.localRelPath ?? null,
      lastSyncErrorCode: existing?.lastSyncErrorCode ?? null,
      customFolderId: existing?.customFolderId ?? null,
    };
    this.rows.set(input.objToken, row);
    return row;
  }

  recordCompleteTraversalMiss(): DocumentRecord | null {
    return null;
  }

  listMissingCandidates(): DocumentRecord[] {
    return [];
  }

  private legacyStatus(state: SyncState): DocumentRecord['status'] {
    if (state === 'synced') return 'synced';
    if (state === 'restricted') return 'placeholder';
    if (state === 'error') return 'error';
    return 'changed';
  }

  private legacyState(row?: DocumentRecord): SyncState {
    if (!row) return 'pending_added';
    if (row.cloudDeleted === 1) return 'missing_candidate';
    if (row.status === 'error') return 'error';
    if (row.status === 'placeholder')
      return row.cloudMatch === 'restricted' ? 'restricted' : 'pending_added';
    if (row.status === 'changed') return 'pending_modified';
    return 'synced';
  }
}

// ===========================================================================
// Mock LarkCliClient with configurable getNode
// ===========================================================================

class MockLarkCliClient {
  /** Map objToken → LarkCliNodeInfo that getNode should return. */
  nodeResponses = new Map<string, LarkCliNodeInfo>();
  /** Set of objTokens whose getNode should throw. */
  nodeErrors = new Set<string>();
  getNodeCalls: string[] = [];

  async getNode(reference: string): Promise<LarkCliNodeInfo> {
    this.getNodeCalls.push(reference);
    // Match by checking if the reference contains any known objToken or
    // wikiNodeToken. For simplicity, the test sets up responses keyed by
    // a substring match.
    for (const [key, info] of this.nodeResponses) {
      if (reference.includes(key)) return info;
    }
    for (const key of this.nodeErrors) {
      if (reference.includes(key)) throw new Error(`getNode failed for ${key}`);
    }
    throw new Error(`getNode: no mock response for ${reference}`);
  }

  async listWikiNodes(): Promise<any[]> {
    return [];
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function makeCustomDocDoc(overrides: Partial<DocumentRecord>): DocumentRecord {
  return {
    objToken: 'obj-custom-1',
    wikiNodeToken: 'wiki-custom-1',
    objType: 'docx',
    title: 'Custom Doc',
    localMdPath: '/kb/_custom/my-folder/custom-doc.md',
    lastSyncedModifyTime: '',
    lastSyncedAt: '2025-01-01T00:00:00.000Z',
    status: 'synced',
    syncedObjEditTime: 1700000000,
    observedObjEditTime: 1700000000,
    syncState: 'synced',
    watchedRootUrl: null,
    watchedRootId: null,
    customFolderId: 'folder-1',
    originalLink: 'https://test.feishu.cn/wiki/wiki-custom-1',
    localRelPath: '_custom/my-folder/custom-doc.md',
    spaceId: 'space-1',
    parentNodeToken: null,
    hasChild: false,
    cloudDeleted: 0,
    cloudMatch: 'synced',
    lastSeenAt: '2025-01-01T00:00:00.000Z',
    missingCompleteCount: 0,
    ...overrides,
  };
}

// ===========================================================================
// Block 1: detectCustomFolderChanges
// ===========================================================================

describe('ChangeDetector.detectCustomFolderChanges', () => {
  let store: MockLocalMapStore;
  let larkCli: MockLarkCliClient;
  let detector: ChangeDetector;

  beforeEach(() => {
    store = new MockLocalMapStore();
    larkCli = new MockLarkCliClient();
    detector = new ChangeDetector(larkCli as any, store as any);
  });

  it('detects modified when cloud edit time > synced baseline', async () => {
    store.rows.set(
      'obj-custom-1',
      makeCustomDocDoc({ syncedObjEditTime: 1700000000 }),
    );
    larkCli.nodeResponses.set('wiki-custom-1', {
      node_token: 'wiki-custom-1',
      obj_token: 'obj-custom-1',
      obj_type: 'docx',
      title: 'Custom Doc (updated)',
      space_id: 'space-1',
      obj_edit_time: 1700000100,
      has_child: false,
    });

    const result = await detector.detectCustomFolderChanges();

    expect(result.checked).toBe(1);
    expect(result.changed).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.changedDocuments).toHaveLength(1);
    expect(result.changedDocuments[0].objToken).toBe('obj-custom-1');
    expect(result.changedDocuments[0].changeType).toBe('modified');
    expect(result.changedDocuments[0].customFolderId).toBe('folder-1');

    // DB state should reflect pending_modified + new observed time.
    const updated = store.rows.get('obj-custom-1')!;
    expect(updated.syncState).toBe('pending_modified');
    expect(updated.observedObjEditTime).toBe(1700000100);
    // Synced baseline must NOT advance (only atomic commit does that).
    expect(updated.syncedObjEditTime).toBe(1700000000);
  });

  it('does not report modified when cloud edit time equals synced baseline', async () => {
    store.rows.set(
      'obj-custom-1',
      makeCustomDocDoc({ syncedObjEditTime: 1700000000 }),
    );
    larkCli.nodeResponses.set('wiki-custom-1', {
      node_token: 'wiki-custom-1',
      obj_token: 'obj-custom-1',
      obj_type: 'docx',
      title: 'Custom Doc',
      space_id: 'space-1',
      obj_edit_time: 1700000000,
      has_child: false,
    });

    const result = await detector.detectCustomFolderChanges();

    expect(result.checked).toBe(1);
    expect(result.changed).toBe(0);
    expect(result.changedDocuments).toHaveLength(0);
    expect(store.rows.get('obj-custom-1')!.syncState).toBe('synced');
  });

  it('NaN defense: null cloud obj_edit_time does not report modified', async () => {
    store.rows.set(
      'obj-custom-1',
      makeCustomDocDoc({ syncedObjEditTime: 1700000000 }),
    );
    larkCli.nodeResponses.set('wiki-custom-1', {
      node_token: 'wiki-custom-1',
      obj_token: 'obj-custom-1',
      obj_type: 'docx',
      title: 'Custom Doc',
      space_id: 'space-1',
      obj_edit_time: null, // permission-restricted or missing
      has_child: false,
    });

    const result = await detector.detectCustomFolderChanges();

    expect(result.changed).toBe(0);
    // observationStatus 'unavailable' preserves the previous state (synced).
    expect(store.rows.get('obj-custom-1')!.syncState).toBe('synced');
  });

  it('getNode failure does NOT mark deleted — counts as error and skips', async () => {
    store.rows.set(
      'obj-custom-1',
      makeCustomDocDoc({ syncedObjEditTime: 1700000000 }),
    );
    larkCli.nodeErrors.add('wiki-custom-1');

    const result = await detector.detectCustomFolderChanges();

    expect(result.checked).toBe(1);
    expect(result.changed).toBe(0);
    expect(result.errors).toBe(1);
    // The row must remain synced, NOT transitioned to deleted/missing.
    const row = store.rows.get('obj-custom-1')!;
    expect(row.syncState).toBe('synced');
    expect(row.cloudDeleted).toBe(0);
  });

  it('skips docs without originalLink or wikiNodeToken (cannot resolve identity)', async () => {
    store.rows.set(
      'obj-custom-1',
      makeCustomDocDoc({
        originalLink: null,
        wikiNodeToken: null,
      }),
    );

    const result = await detector.detectCustomFolderChanges();

    expect(result.checked).toBe(1);
    expect(result.changed).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.changedDocuments).toHaveLength(0);
  });

  it('returns empty result when there are no custom-folder docs', async () => {
    const result = await detector.detectCustomFolderChanges();
    expect(result.checked).toBe(0);
    expect(result.changed).toBe(0);
    expect(result.changedDocuments).toHaveLength(0);
  });

  it('handles multiple custom docs with mixed outcomes', async () => {
    store.rows.set(
      'obj-a',
      makeCustomDocDoc({
        objToken: 'obj-a',
        wikiNodeToken: 'wiki-a',
        title: 'Doc A',
        syncedObjEditTime: 1000,
        originalLink: 'https://test.feishu.cn/wiki/wiki-a',
      }),
    );
    store.rows.set(
      'obj-b',
      makeCustomDocDoc({
        objToken: 'obj-b',
        wikiNodeToken: 'wiki-b',
        title: 'Doc B',
        syncedObjEditTime: 2000,
        originalLink: 'https://test.feishu.cn/wiki/wiki-b',
      }),
    );
    larkCli.nodeResponses.set('wiki-a', {
      node_token: 'wiki-a',
      obj_token: 'obj-a',
      obj_type: 'docx',
      title: 'Doc A',
      space_id: 'space-1',
      obj_edit_time: 1001, // changed
      has_child: false,
    });
    larkCli.nodeResponses.set('wiki-b', {
      node_token: 'wiki-b',
      obj_token: 'obj-b',
      obj_type: 'docx',
      title: 'Doc B',
      space_id: 'space-1',
      obj_edit_time: 2000, // unchanged
      has_child: false,
    });

    const result = await detector.detectCustomFolderChanges();

    expect(result.checked).toBe(2);
    expect(result.changed).toBe(1);
    expect(result.changedDocuments[0].objToken).toBe('obj-a');
  });
});

// ===========================================================================
// Block 2: MappingService diff merge
// ===========================================================================

describe('MappingService diff includes custom-folder modified docs', () => {
  let store: MockLocalMapStore;

  beforeEach(() => {
    store = new MockLocalMapStore();
  });

  function makeService() {
    const stubDetector = {
      async detectChanges() {
        return {
          changed: false,
          changedDocuments: [],
          checkedAt: '2025-01-01T00:00:00.000Z',
          totalNodes: 1,
        };
      },
    };
    const stubSnapshot = { refreshSortOrder: () => {} };
    return new MappingService(
      stubDetector as any,
      store as any,
      stubSnapshot as any,
    );
  }

  it('getStoredDiff appends custom pending_modified to modified bucket', () => {
    store.rows.set(
      'obj-custom-1',
      makeCustomDocDoc({
        syncState: 'pending_modified',
        status: 'changed',
        observedObjEditTime: 1700000100,
      }),
    );

    const svc = makeService();
    const diff = svc.getStoredDiff('https://test.feishu.cn/wiki/root1');

    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].objToken).toBe('obj-custom-1');
    expect(diff.modified[0].customFolderId).toBe('folder-1');
    expect(diff.modified[0].changeType).toBe('modified');
  });

  it('getStoredDiff does NOT include custom synced docs', () => {
    store.rows.set(
      'obj-custom-1',
      makeCustomDocDoc({ syncState: 'synced', status: 'synced' }),
    );

    const svc = makeService();
    const diff = svc.getStoredDiff('https://test.feishu.cn/wiki/root1');

    expect(diff.modified).toHaveLength(0);
  });

  it('computeDiff appends custom pending_modified to modified bucket', async () => {
    store.rows.set(
      'obj-custom-1',
      makeCustomDocDoc({
        syncState: 'pending_modified',
        status: 'changed',
        observedObjEditTime: 1700000100,
      }),
    );

    const svc = makeService();
    const diff = await svc.computeDiff('https://test.feishu.cn/wiki/root1');

    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].objToken).toBe('obj-custom-1');
    expect(diff.modified[0].customFolderId).toBe('folder-1');
  });
});

// ===========================================================================
// Block 3: operation-manifest planDocument bypasses watchedRoot for custom
// ===========================================================================

describe('operation-manifest createOperationManifest with custom docs', () => {
  it('custom doc bypasses watchedRoot validation and reuses existing localMdPath', () => {
    const kbRoot = '/kb';
    const doc: ChangedDocument = {
      objToken: 'obj-custom-1',
      objType: 'docx',
      title: 'Custom Doc',
      changeType: 'modified',
      cloudModifiedTime: '2025-01-01T00:00:00.000Z',
      localSyncedTime: null,
      localMdPath: '/kb/_custom/my-folder/custom-doc.md',
      watchedRootId: null,
      customFolderId: 'folder-1',
      localRelPath: '_custom/my-folder/custom-doc.md',
    };

    // watchedRoots is non-empty; without customFolderId bypass, this doc
    // would be blocked as 'unknown_watched_root'.
    const watchedRoots = [
      {
        id: 'root-token-1',
        url: 'https://test.feishu.cn/wiki/root-token-1',
        localDir: 'root1',
        layoutProfile: 'directory-readme' as const,
        enabled: true,
      },
    ];

    const manifest = createOperationManifest({
      knowledgeBaseRoot: kbRoot,
      documents: [doc],
      mode: 'dry-run',
      watchedRoots,
    });

    expect(manifest.documents).toHaveLength(1);
    const planned = manifest.documents[0];
    // Must NOT be blocked.
    expect(planned.action).not.toBe('blocked');
    expect(planned.localMdPath).toContain('_custom/my-folder/custom-doc.md');
  });

  it('non-custom doc without watchedRootId is still blocked as unknown_watched_root', () => {
    const kbRoot = '/kb';
    const doc: ChangedDocument = {
      objToken: 'obj-regular-1',
      objType: 'docx',
      title: 'Regular Doc',
      changeType: 'modified',
      cloudModifiedTime: '2025-01-01T00:00:00.000Z',
      localSyncedTime: null,
      localMdPath: null,
      watchedRootId: null,
      customFolderId: null,
    };

    // With 2+ enabled roots and no watchedRootId on the doc, findWatchedRoot
    // returns null → the doc must be blocked (not silently placed under a
    // random root). A custom doc with the same shape but customFolderId set
    // bypasses this check.
    const watchedRoots = [
      {
        id: 'root-token-1',
        url: 'https://test.feishu.cn/wiki/root-token-1',
        localDir: 'root1',
        layoutProfile: 'directory-readme' as const,
        enabled: true,
      },
      {
        id: 'root-token-2',
        url: 'https://test.feishu.cn/wiki/root-token-2',
        localDir: 'root2',
        layoutProfile: 'directory-readme' as const,
        enabled: true,
      },
    ];

    const manifest = createOperationManifest({
      knowledgeBaseRoot: kbRoot,
      documents: [doc],
      mode: 'dry-run',
      watchedRoots,
    });

    expect(manifest.documents[0].action).toBe('blocked');
    expect(manifest.documents[0].reasonCode).toBe('unknown_watched_root');
  });
});
