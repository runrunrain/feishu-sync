/**
 * SnapshotService unit tests (P2-T6 algorithm layer).
 *
 * Exercises:
 *   - generate(): snapshot structure conforms to 03 §2.4.1
 *   - orphan_files scanning (no-header files surfaced)
 *   - top_level_dirs aggregation
 *   - sortOrder preserved from documents (decision 5)
 *   - refreshSortOrder(): cheap path preserves orphan list from prior snapshot
 *   - atomic write via temp file + rename (verified by file presence)
 *
 * Uses fs mocks (tmpdir) so we don't touch the real knowledge base.
 * The LocalMapStore + ConfigManager are mocked in-memory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SnapshotService } from '../src/modules/snapshot-service.js';
import { IndexScanner } from '../src/modules/index-scanner.js';
import type { DocumentRecord } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockLocalMapStore {
  rows: DocumentRecord[] = [];
  getAllDocuments(): DocumentRecord[] {
    return this.rows;
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

class StubIndexScanner extends IndexScanner {
  constructor() {
    super({ localMapStore: {} as any, larkCliClient: {} as any, config: {} });
  }
  // We only use parseMetadata from IndexScanner; the real implementation
  // is already covered by index-scanner.test.ts. Inherit it as-is.
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

describe('SnapshotService.generate', () => {
  let tmpDir: string;
  let store: MockLocalMapStore;
  let configMgr: MockConfigManager;
  let svc: SnapshotService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    store = new MockLocalMapStore();
    configMgr = new MockConfigManager({
      knowledgeBaseRoot: tmpDir,
      watchedRootUrls: ['https://x.feishu.cn/wiki/root'],
    });
    svc = new SnapshotService(store as any, configMgr as any, new StubIndexScanner());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces a snapshot with the 03 §2.4.1 structure', () => {
    store.rows = [
      makeDoc({
        objToken: 'A',
        wikiNodeToken: 'WNT_A',
        title: 'a',
        localMdPath: path.join(tmpDir, '000-cat', 'a.md'),
        parentNodeToken: null,
        objEditTime: 1700000000,
        lastSyncedAt: '2026-06-18T00:00:00Z',
        lastSyncedModifyTime: '2026-06-15',
        localSortOrder: 2,
      }),
      makeDoc({
        objToken: 'B',
        wikiNodeToken: 'WNT_B',
        title: 'b',
        localMdPath: path.join(tmpDir, '000-cat', 'b.md'),
        parentNodeToken: 'WNT_A',
        localSortOrder: null,
      }),
    ];
    // Create the local files so top_level_dirs aggregation finds them.
    fs.mkdirSync(path.join(tmpDir, '000-cat'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '000-cat', 'a.md'), '<!-- obj_token: A -->');
    fs.writeFileSync(path.join(tmpDir, '000-cat', 'b.md'), '<!-- obj_token: B -->');

    const snap = svc.generate();

    expect(snap.version).toBe('1.0');
    expect(snap.knowledge_base_root).toBe(tmpDir);
    expect(snap.watched_root_urls).toEqual(['https://x.feishu.cn/wiki/root']);
    expect(snap.nodes).toHaveLength(2);
    expect(snap.nodes[0].obj_token).toBe('A');
    expect(snap.nodes[0].sortOrder).toBe(2);
    expect(snap.nodes[1].sortOrder).toBeNull();
    // A has child B (B.parent_node_token === 'WNT_A')
    expect(snap.nodes.find((n) => n.obj_token === 'A')!.has_child).toBe(true);
    expect(snap.nodes.find((n) => n.obj_token === 'B')!.has_child).toBe(false);
    // top_level_dirs counts both under 000-cat
    expect(snap.top_level_dirs).toEqual([{ dir: '000-cat', node_count: 2 }]);
  });

  it('surfaces orphan files (no obj_token header) in orphan_files', () => {
    // Mapped doc.
    store.rows = [
      makeDoc({
        objToken: 'KNOWN',
        localMdPath: path.join(tmpDir, 'mapped.md'),
      }),
    ];
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'mapped.md'), '<!-- obj_token: KNOWN -->');
    // Orphan: no header.
    fs.writeFileSync(path.join(tmpDir, 'orphan.md'), '# just a title, no header');

    const snap = svc.generate();

    const orphanPaths = snap.orphan_files.map((o) => o.path);
    expect(orphanPaths).toContain('orphan.md');
    expect(orphanPaths).not.toContain('mapped.md');
    // Reason tag matches 03 §2.4.1 spec wording.
    const orphan = snap.orphan_files.find((o) => o.path === 'orphan.md')!;
    expect(orphan.reason).toBe('no_obj_token_in_header');
  });

  it('skips README.md during orphan scan (auto-generated, no header by design)', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Knowledge Base Overview');
    const snap = svc.generate();
    expect(snap.orphan_files).toHaveLength(0);
  });

  it('writes _index.json atomically and can re-read it', () => {
    store.rows = [
      makeDoc({ objToken: 'X', localMdPath: path.join(tmpDir, 'x.md') }),
    ];
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'x.md'), '<!-- obj_token: X -->');

    svc.generate();

    const snapPath = path.join(tmpDir, '_index.json');
    expect(fs.existsSync(snapPath)).toBe(true);
    // No leftover temp files.
    const entries = fs.readdirSync(tmpDir);
    expect(entries.filter((e) => e.startsWith('_index.json.tmp'))).toHaveLength(0);

    const reread = svc.readExisting(tmpDir);
    expect(reread).not.toBeNull();
    expect(reread!.nodes[0].obj_token).toBe('X');
  });

  it('throws when knowledgeBaseRoot is not configured', () => {
    const badConfig = new MockConfigManager({});
    const badSvc = new SnapshotService(store as any, badConfig as any, new StubIndexScanner());
    expect(() => badSvc.generate()).toThrow(/knowledgeBaseRoot/);
  });
});

describe('SnapshotService.refreshSortOrder', () => {
  let tmpDir: string;
  let store: MockLocalMapStore;
  let configMgr: MockConfigManager;
  let svc: SnapshotService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-refresh-'));
    store = new MockLocalMapStore();
    configMgr = new MockConfigManager({ knowledgeBaseRoot: tmpDir });
    svc = new SnapshotService(store as any, configMgr as any, new StubIndexScanner());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves orphan_files from prior snapshot (no FS rescan)', () => {
    // Seed: an existing snapshot with an orphan entry.
    fs.mkdirSync(tmpDir, { recursive: true });
    const prior = {
      version: '1.0',
      generated_at: '2020-01-01T00:00:00Z',
      knowledge_base_root: tmpDir,
      watched_root_urls: ['https://x/root'],
      top_level_dirs: [{ dir: '000-cat', node_count: 1 }],
      nodes: [],
      orphan_files: [{ path: 'stale-orphan.md', reason: 'no_obj_token_in_header' }],
    };
    fs.writeFileSync(path.join(tmpDir, '_index.json'), JSON.stringify(prior));

    // refreshSortOrder should not touch FS for orphans.
    store.rows = [
      makeDoc({ objToken: 'NEW', localSortOrder: 0 }),
    ];
    const refreshed = svc.refreshSortOrder();

    expect(refreshed.orphan_files).toEqual([
      { path: 'stale-orphan.md', reason: 'no_obj_token_in_header' },
    ]);
    expect(refreshed.nodes).toHaveLength(1);
    expect(refreshed.nodes[0].sortOrder).toBe(0);
    // generated_at must advance past the seed value.
    expect(refreshed.generated_at > '2020-01-01T00:00:00Z').toBe(true);
  });

  it('falls back to empty orphan_files when no prior snapshot', () => {
    store.rows = [makeDoc({ objToken: 'NEW' })];
    const refreshed = svc.refreshSortOrder();
    expect(refreshed.orphan_files).toEqual([]);
    expect(refreshed.nodes).toHaveLength(1);
  });
});
