/**
 * Unit tests for SyncEngine header-generation core logic.
 *
 * Backfills the project-level coverage gap flagged by diting's review
 * (Major-1): the sheet-header fix (resolveHeaderMeta) and the
 * generateHtmlHeader YAML upgrade previously had only ephemeral script
 * verification (luban's 22 assertions + diting's 25 assertions), never
 * persisted as project tests. This file persists that coverage.
 *
 * Strategy (mirrors change-detector.test.ts algorithm-layer approach):
 *   - In-memory MockLocalMapStore (no better-sqlite3 ABI dependency).
 *   - Private methods (generateHtmlHeader / resolveHeaderMeta /
 *     extractFeishuHost / yamlScalar / writeLocalMarkdown) are exercised
 *     via a typed cast — the same pattern change-detector.test.ts uses
 *     for compareWithLocalRecords.
 *   - Round-trip compatibility verified against the REAL
 *     IndexScanner.parseMetadata (public API) to prove the generated
 *     header round-trips through the parser that consumes it.
 *
 * Covers diting Major-1 acceptance criteria:
 *   (a) docx path: 7-field YAML + syntax
 *   (b) sheet path: original_link NON-EMPTY + obj_type=sheet (core fix)
 *   (c) boundary: no host + no wikiNodeToken -> original_link omitted,
 *       obj_token still present (no de-indexing)
 *   (d) generated header parsed by IndexScanner.parseMetadata (round trip)
 *   (e) writeLocalMarkdown signature accepts HeaderMeta
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { IndexScanner } from '../src/modules/index-scanner.js';
import { ChangeDetector } from '../src/modules/change-detector.js';
import type { ChangedDocument, DocumentRecord } from '../src/types/index.js';

// ----- Structural types mirroring SyncEngine's private interfaces -------
// HeaderMeta and FetchedDocument are module-private in sync-engine.ts; we
// mirror their shapes here so the typed cast below stays compile-checked.
interface HeaderMetaLike {
  objToken: string;
  objType: 'docx' | 'sheet' | 'slides' | 'bitable' | 'unknown';
  wikiNodeToken: string | null;
  spaceId: string | null;
  originalLink: string | null;
  fetchDate: string;
  lastSyncedModifyTime: string;
}

interface FetchedLike {
  content: string;
  images: unknown[];
  attachments: unknown[];
  sheets: unknown[];
  url: string;
  obj_token: string;
}

// Typed view over the private methods we exercise. Keeps test call sites
// compile-checked against the real signatures.
type SyncEngineInternals = {
  generateHtmlHeader(meta: HeaderMetaLike): string;
  resolveHeaderMeta(doc: ChangedDocument, fetched: FetchedLike): HeaderMetaLike;
  extractFeishuHost(watchedRootId?: string | null, watchedRootUrl?: string | null): string | null;
  yamlScalar(value: string): string;
  writeLocalMarkdown(
    localMdPath: string,
    content: string,
    meta: HeaderMetaLike,
  ): Promise<void>;
};

// ----- In-memory mock LocalMapStore ------------------------------------
// resolveHeaderMeta only touches getDocumentByObjToken; we keep the mock
// surface minimal and state in a plain Map so cases stay inspectable.
class MockLocalMapStore {
  records = new Map<string, DocumentRecord>();
  getDocumentByObjToken(objToken: string): DocumentRecord | null {
    return this.records.get(objToken) ?? null;
  }
}

// ----- Test data factories ---------------------------------------------

function makeDoc(overrides: Partial<ChangedDocument> = {}): ChangedDocument {
  return {
    objToken: 'doxcnTest789',
    objType: 'docx',
    title: '测试文档',
    changeType: 'added',
    cloudModifiedTime: '2026-07-08T10:00:00.000Z',
    localSyncedTime: null,
    localMdPath: null,
    ...overrides,
  };
}

function makeFetched(overrides: Partial<FetchedLike> = {}): FetchedLike {
  return {
    content: '',
    images: [],
    attachments: [],
    sheets: [],
    url: '',
    obj_token: 'doxcnTest789',
    ...overrides,
  };
}

function makeRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    objToken: 'doxcnTest789',
    wikiNodeToken: 'wikicnTest123',
    objType: 'docx',
    title: '测试文档',
    localMdPath: '/tmp/test.md',
    lastSyncedModifyTime: '2026-07-08T10:00:00.000Z',
    lastSyncedAt: '2026-07-08T09:00:00.000Z',
    status: 'synced',
    spaceId: 'spaceTest456',
    originalLink: null,
    ...overrides,
  };
}

function makeEngine(opts: {
  watchedRoots?: Array<{
    id: string;
    url: string;
    localDir: string;
    layoutProfile: 'directory-readme' | 'mirror-title-file';
    enabled: boolean;
  }>;
  legacyWatchedRootUrls?: string[];
} = {}): { engine: SyncEngine; store: MockLocalMapStore } {
  const store = new MockLocalMapStore();
  const config = {
    watchedRoots: opts.watchedRoots ?? [{
      id: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
      url: 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb',
      localDir: '策划 - Designer',
      layoutProfile: 'mirror-title-file' as const,
      enabled: true,
    }],
    watchedRootUrls: opts.legacyWatchedRootUrls ?? [],
    knowledgeBaseRoot: os.tmpdir(),
  };
  const engine = new SyncEngine({
    localMapStore: store,
    config,
  } as any);
  return { engine, store };
}

function internals(engine: SyncEngine): SyncEngineInternals {
  return engine as unknown as SyncEngineInternals;
}

// Reusable IndexScanner for round-trip cases. parseMetadata needs no
// live dependencies for pure header parsing (larkCliClient only used by
// the getNode fallback, which these cases do not trigger).
const scanner = new IndexScanner({
  localMapStore: {},
  larkCliClient: {},
  config: {},
} as any);

// =========================================================================
// generateHtmlHeader — YAML-in-comment header generation
// =========================================================================
describe('SyncEngine.generateHtmlHeader — YAML-in-comment header', () => {
  it('docx: emits all 7 fields with correct YAML syntax and HTML comment wrap', () => {
    const { engine } = makeEngine();
    const meta: HeaderMetaLike = {
      objToken: 'doxcnTest789',
      objType: 'docx',
      wikiNodeToken: 'wikicnTest123',
      spaceId: 'spaceTest456',
      originalLink: 'https://qcnbafdrjx7n.feishu.cn/wiki/wikicnTest123',
      fetchDate: '2026-07-08T09:21:54.911Z',
      lastSyncedModifyTime: '2026-07-08T10:00:00.000Z',
    };
    const header = internals(engine).generateHtmlHeader(meta);

    // HTML comment envelope
    expect(header.startsWith('<!--\n')).toBe(true);
    expect(header).toMatch(/\n-->\n\n$/);
    // feishu_sync YAML block marker
    expect(header).toContain('feishu_sync:');

    // All 7 fields, double-quoted YAML scalars
    expect(header).toContain('  obj_token: "doxcnTest789"');
    expect(header).toContain('  wiki_node_token: "wikicnTest123"');
    expect(header).toContain('  space_id: "spaceTest456"');
    expect(header).toContain('  obj_type: "docx"');
    expect(header).toContain(
      '  original_link: "https://qcnbafdrjx7n.feishu.cn/wiki/wikicnTest123"',
    );
    expect(header).toContain('  fetch_date: "2026-07-08T09:21:54.911Z"');
    expect(header).toContain(
      '  last_synced_modify_time: "2026-07-08T10:00:00.000Z"',
    );
  });

  it('docx: every emitted value is wrapped in double quotes', () => {
    const { engine } = makeEngine();
    const header = internals(engine).generateHtmlHeader({
      objToken: 'doxcnTest789',
      objType: 'docx',
      wikiNodeToken: 'wikicnTest123',
      spaceId: 'spaceTest456',
      originalLink: 'https://qcnbafdrjx7n.feishu.cn/wiki/wikicnTest123',
      fetchDate: '2026-07-08T09:21:54.911Z',
      lastSyncedModifyTime: '2026-07-08T10:00:00.000Z',
    });
    // Every `key: value` line under feishu_sync: must have a double-quoted value.
    const kvLines = header
      .split('\n')
      .filter((l) => /^\s+[a-z_]+:\s/.test(l));
    expect(kvLines.length).toBe(7);
    for (const line of kvLines) {
      expect(line).toMatch(/:\s*"[^"]*"$/);
    }
  });

  it('sheet (CORE FIX): emits obj_type=sheet and NON-EMPTY original_link', () => {
    const { engine } = makeEngine();
    const header = internals(engine).generateHtmlHeader({
      objToken: 'sheetcnTest321',
      objType: 'sheet',
      wikiNodeToken: 'wikicnTest123',
      spaceId: 'spaceTest456',
      originalLink: 'https://qcnbafdrjx7n.feishu.cn/wiki/wikicnTest123',
      fetchDate: '2026-07-08T09:21:54.912Z',
      lastSyncedModifyTime: '2026-07-08T11:00:00.000Z',
    });

    // Core fix point #1: obj_type is sheet (was previously absent ->
    // IndexScanner defaulted to docx).
    expect(header).toContain('  obj_type: "sheet"');
    // Core fix point #2: original_link is present and NON-EMPTY.
    expect(header).toMatch(/  original_link: "https:\/\/[^"]+"/);

    // Regression guards: the legacy Chinese-key defects must NOT reappear.
    expect(header).not.toContain('节点: unknown');
    expect(header).not.toMatch(/原始链接:\s*\n/);
    expect(header).not.toContain('节点:');
    expect(header).not.toContain('原始链接:');
  });

  it('boundary: obj_type=unknown omits the obj_type line (parser falls back to docx)', () => {
    const { engine } = makeEngine();
    const header = internals(engine).generateHtmlHeader({
      objToken: 'unknownTok',
      objType: 'unknown',
      wikiNodeToken: 'nodeTok',
      spaceId: 'spaceTok',
      originalLink: 'https://qcnbafdrjx7n.feishu.cn/wiki/nodeTok',
      fetchDate: '2026-07-08T09:00:00.000Z',
      lastSyncedModifyTime: '2026-07-08T10:00:00.000Z',
    });
    expect(header).not.toContain('obj_type');
    // obj_token must still be present so the file stays indexable.
    expect(header).toContain('  obj_token: "unknownTok"');
  });

  it('boundary: nullable fields (wiki_node_token/space_id/original_link) are omitted when null, never written as empty strings', () => {
    const { engine } = makeEngine();
    const header = internals(engine).generateHtmlHeader({
      objToken: 'orphanToken',
      objType: 'docx',
      wikiNodeToken: null,
      spaceId: null,
      originalLink: null,
      fetchDate: '2026-07-08T09:00:00.000Z',
      lastSyncedModifyTime: '',
    });
    expect(header).not.toContain('wiki_node_token');
    expect(header).not.toContain('space_id');
    expect(header).not.toContain('original_link');
    // Empty lastSyncedModifyTime is omitted too.
    expect(header).not.toContain('last_synced_modify_time');
    // Always-present fields survive.
    expect(header).toContain('  obj_token: "orphanToken"');
    expect(header).toContain('  fetch_date: "2026-07-08T09:00:00.000Z"');
  });

  it('slides: emits obj_type=slides (recognized concrete type)', () => {
    const { engine } = makeEngine();
    const header = internals(engine).generateHtmlHeader({
      objToken: 'slidesTok',
      objType: 'slides',
      wikiNodeToken: null,
      spaceId: null,
      originalLink: null,
      fetchDate: '2026-07-08T09:00:00.000Z',
      lastSyncedModifyTime: '',
    });
    expect(header).toContain('  obj_type: "slides"');
  });
});

// =========================================================================
// resolveHeaderMeta — SQLite + host field completion
// =========================================================================
describe('SyncEngine.resolveHeaderMeta — field sourcing (no fabrication)', () => {
  it('original_link precedence (1): fetched.url wins over SQLite.original_link', () => {
    const doc = makeDoc();
    const fetched = makeFetched({
      url: 'https://qcnbafdrjx7n.feishu.cn/wiki/fetchedNodeUrl',
      obj_token: doc.objToken,
    });
    const record = makeRecord({
      objToken: doc.objToken,
      originalLink: 'https://qcnbafdrjx7n.feishu.cn/wiki/sqliteNodeUrl',
    });
    const { engine, store } = makeEngine();
    store.records.set(doc.objToken, record);

    const meta = internals(engine).resolveHeaderMeta(doc, fetched);
    expect(meta.originalLink).toBe(
      'https://qcnbafdrjx7n.feishu.cn/wiki/fetchedNodeUrl',
    );
  });

  it('original_link precedence (2): SQLite.original_link used when fetched.url empty (modified docx)', () => {
    const doc = makeDoc();
    const fetched = makeFetched({ url: '', obj_token: doc.objToken });
    const record = makeRecord({
      objToken: doc.objToken,
      originalLink: 'https://qcnbafdrjx7n.feishu.cn/wiki/sqliteNodeUrl',
    });
    const { engine, store } = makeEngine();
    store.records.set(doc.objToken, record);

    const meta = internals(engine).resolveHeaderMeta(doc, fetched);
    expect(meta.originalLink).toBe(
      'https://qcnbafdrjx7n.feishu.cn/wiki/sqliteNodeUrl',
    );
  });

  it('original_link precedence (3): constructed from wiki_node_token + host when both url and SQLite empty (SHEET FIX PATH)', () => {
    // This is the core sheet-path scenario: fetched.url='' (sheet content
    // is synthesized from CSV) and SQLite.original_link empty, but the
    // wiki_node_token persisted by ChangeDetector.upsertDocumentSeen is
    // available, so we construct the link from the configured host.
    const doc = makeDoc({ objToken: 'sheetcnTest321', objType: 'sheet' });
    const fetched = makeFetched({ url: '', obj_token: doc.objToken });
    const record = makeRecord({
      objToken: doc.objToken,
      objType: 'sheet',
      wikiNodeToken: 'wikicnTest123',
      spaceId: 'spaceTest456',
      originalLink: null,
    });
    const { engine, store } = makeEngine();
    store.records.set(doc.objToken, record);

    const meta = internals(engine).resolveHeaderMeta(doc, fetched);
    expect(meta.originalLink).toBe(
      'https://qcnbafdrjx7n.feishu.cn/wiki/wikicnTest123',
    );
    expect(meta.wikiNodeToken).toBe('wikicnTest123');
    expect(meta.spaceId).toBe('spaceTest456');
  });

  it('original_link precedence (4): all sources unavailable -> null (not fabricated)', () => {
    const doc = makeDoc({ objToken: 'orphanTok' });
    const fetched = makeFetched({ url: '', obj_token: doc.objToken });
    // No SQLite record at all.
    const { engine } = makeEngine();

    const meta = internals(engine).resolveHeaderMeta(doc, fetched);
    expect(meta.originalLink).toBeNull();
    expect(meta.wikiNodeToken).toBeNull();
    expect(meta.spaceId).toBeNull();
    // objToken still carries through (never lost).
    expect(meta.objToken).toBe('orphanTok');
  });

  it('original_link precedence (5): wiki_node_token present but no configured host -> null', () => {
    const doc = makeDoc({ objToken: 'sheetTok', objType: 'sheet' });
    const fetched = makeFetched({ url: '', obj_token: doc.objToken });
    const record = makeRecord({
      objToken: doc.objToken,
      wikiNodeToken: 'nodeTok',
      originalLink: null,
    });
    const { engine, store } = makeEngine({ watchedRoots: [] });
    store.records.set(doc.objToken, record);

    const meta = internals(engine).resolveHeaderMeta(doc, fetched);
    expect(meta.originalLink).toBeNull();
    // wikiNodeToken still sourced from SQLite for the other header fields.
    expect(meta.wikiNodeToken).toBe('nodeTok');
  });

  it('wiki_node_token / space_id are sourced from SQLite getDocumentByObjToken', () => {
    const doc = makeDoc();
    const fetched = makeFetched({ obj_token: doc.objToken });
    const record = makeRecord({
      objToken: doc.objToken,
      wikiNodeToken: 'wikiFromSqlite',
      spaceId: 'spaceFromSqlite',
    });
    const { engine, store } = makeEngine();
    store.records.set(doc.objToken, record);

    const meta = internals(engine).resolveHeaderMeta(doc, fetched);
    expect(meta.wikiNodeToken).toBe('wikiFromSqlite');
    expect(meta.spaceId).toBe('spaceFromSqlite');
  });

  it('passes through objToken/objType/lastSyncedModifyTime from ChangedDocument and stamps fetchDate', () => {
    const doc = makeDoc({
      objToken: 'tokX',
      objType: 'sheet',
      cloudModifiedTime: '2026-07-08T11:30:00.000Z',
    });
    const fetched = makeFetched({ obj_token: doc.objToken });
    const { engine, store } = makeEngine();
    store.records.set(doc.objToken, makeRecord({ objToken: doc.objToken }));

    const meta = internals(engine).resolveHeaderMeta(doc, fetched);
    expect(meta.objToken).toBe('tokX');
    expect(meta.objType).toBe('sheet');
    expect(meta.lastSyncedModifyTime).toBe('2026-07-08T11:30:00.000Z');
    // fetchDate is the current wall clock; assert ISO8601 shape only.
    expect(meta.fetchDate).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});

// =========================================================================
// extractFeishuHost — host derivation from config
// =========================================================================
describe('SyncEngine.extractFeishuHost — config host derivation', () => {
  it('selects the host belonging to the document watchedRootId', () => {
    const { engine } = makeEngine({
      watchedRoots: [
        {
          id: 'root-a',
          url: 'https://tenant-a.feishu.cn/wiki/root-a',
          localDir: 'A',
          layoutProfile: 'directory-readme',
          enabled: true,
        },
        {
          id: 'root-b',
          url: 'https://tenant-b.feishu.cn/wiki/root-b',
          localDir: 'B',
          layoutProfile: 'directory-readme',
          enabled: true,
        },
      ],
    });
    expect(internals(engine).extractFeishuHost('root-b')).toBe('tenant-b.feishu.cn');
  });

  it('falls back to the first enabled root only when no document owner is known', () => {
    const { engine } = makeEngine();
    expect(internals(engine).extractFeishuHost()).toBe('qcnbafdrjx7n.feishu.cn');
  });

  it('returns null when no structured root or legacy fallback is configured', () => {
    const { engine } = makeEngine({ watchedRoots: [] });
    expect(internals(engine).extractFeishuHost()).toBeNull();
  });

  it('returns null when all structured roots are disabled', () => {
    const { engine } = makeEngine({
      watchedRoots: [{
        id: 'root-a',
        url: 'https://tenant-a.feishu.cn/wiki/root-a',
        localDir: 'A',
        layoutProfile: 'directory-readme',
        enabled: false,
      }],
    });
    expect(internals(engine).extractFeishuHost()).toBeNull();
  });

  it('returns null when the selected URL is unparseable (does not throw)', () => {
    const { engine } = makeEngine({
      watchedRoots: [{
        id: 'root-a',
        url: 'not-a-valid-url',
        localDir: 'A',
        layoutProfile: 'directory-readme',
        enabled: true,
      }],
    });
    expect(internals(engine).extractFeishuHost()).toBeNull();
  });
});

// =========================================================================
// yamlScalar — double-quote wrapping
// =========================================================================
describe('SyncEngine.yamlScalar — YAML scalar wrapping', () => {
  it('wraps a plain value in double quotes', () => {
    const { engine } = makeEngine();
    expect(internals(engine).yamlScalar('hello')).toBe('"hello"');
  });

  it('wraps an empty string as ""', () => {
    const { engine } = makeEngine();
    expect(internals(engine).yamlScalar('')).toBe('""');
  });

  it('wraps values containing URL path/query characters verbatim (no escape needed)', () => {
    // Feishu tokens / URLs / ISO8601 never contain double quotes, so the
    // wrap is round-trip safe through extractYamlFields' quote-stripping
    // regex without any escape sequence.
    const { engine } = makeEngine();
    expect(internals(engine).yamlScalar('https://x.feishu.cn/wiki/AbC_123?a=1&b=2'))
      .toBe('"https://x.feishu.cn/wiki/AbC_123?a=1&b=2"');
    expect(internals(engine).yamlScalar('2026-07-08T10:00:00.000Z'))
      .toBe('"2026-07-08T10:00:00.000Z"');
  });
});

// =========================================================================
// writeLocalMarkdown — HeaderMeta signature contract
// =========================================================================
describe('SyncEngine.writeLocalMarkdown — HeaderMeta third-param contract', () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-engine-test-'));
  }

  it('writes header (from meta) + content; header precedes body', async () => {
    const dir = tmpDir();
    try {
      const { engine } = makeEngine();
      const mdPath = path.join(dir, 'doc.md');
      const meta: HeaderMetaLike = {
        objToken: 'doxcnTest789',
        objType: 'docx',
        wikiNodeToken: 'wikicnTest123',
        spaceId: 'spaceTest456',
        originalLink: 'https://qcnbafdrjx7n.feishu.cn/wiki/wikicnTest123',
        fetchDate: '2026-07-08T09:21:54.911Z',
        lastSyncedModifyTime: '2026-07-08T10:00:00.000Z',
      };
      await internals(engine).writeLocalMarkdown(mdPath, '# Body\n', meta);

      const written = fs.readFileSync(mdPath, 'utf-8');
      expect(written).toContain('feishu_sync:');
      expect(written).toContain('  obj_token: "doxcnTest789"');
      expect(written).toContain('# Body');
      // Header must come before the body.
      expect(written.indexOf('feishu_sync:')).toBeLessThan(
        written.indexOf('# Body'),
      );
      // Trailing structure: header block ends with '-->' then blank line.
      expect(written).toMatch(/-->\n\n# Body/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backs up an existing file to .bak before overwriting', async () => {
    const dir = tmpDir();
    try {
      const { engine } = makeEngine();
      const mdPath = path.join(dir, 'doc.md');
      fs.writeFileSync(mdPath, 'OLD CONTENT', 'utf-8');

      const meta: HeaderMetaLike = {
        objToken: 'tokBak',
        objType: 'docx',
        wikiNodeToken: null,
        spaceId: null,
        originalLink: null,
        fetchDate: '2026-07-08T09:00:00.000Z',
        lastSyncedModifyTime: '',
      };
      await internals(engine).writeLocalMarkdown(mdPath, 'NEW BODY', meta);

      const bak = fs.readFileSync(`${mdPath}.bak`, 'utf-8');
      expect(bak).toBe('OLD CONTENT');
      const fresh = fs.readFileSync(mdPath, 'utf-8');
      expect(fresh).toContain('NEW BODY');
      expect(fresh).not.toContain('OLD CONTENT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the parent directory when it does not exist', async () => {
    const dir = tmpDir();
    try {
      const { engine } = makeEngine();
      const nested = path.join(dir, 'nested', 'sub', 'doc.md');
      const meta: HeaderMetaLike = {
        objToken: 'tokNested',
        objType: 'docx',
        wikiNodeToken: null,
        spaceId: null,
        originalLink: null,
        fetchDate: '2026-07-08T09:00:00.000Z',
        lastSyncedModifyTime: '',
      };
      await internals(engine).writeLocalMarkdown(nested, 'body', meta);
      expect(fs.existsSync(nested)).toBe(true);
      expect(fs.readFileSync(nested, 'utf-8')).toContain('  obj_token: "tokNested"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// Round-trip compatibility — generateHtmlHeader output parsed by the real
// IndexScanner.parseMetadata (the consumer of this header in production).
// Aligns with luban's 22 assertions + diting's 25 assertions.
// =========================================================================
describe('SyncEngine.generateHtmlHeader <-> IndexScanner.parseMetadata round trip', () => {
  it('docx: 7-field header round-trips with header_format=yaml_html', () => {
    const { engine } = makeEngine();
    const header = internals(engine).generateHtmlHeader({
      objToken: 'doxcnTest789',
      objType: 'docx',
      wikiNodeToken: 'wikicnTest123',
      spaceId: 'spaceTest456',
      originalLink: 'https://qcnbafdrjx7n.feishu.cn/wiki/wikicnTest123',
      fetchDate: '2026-07-08T09:21:54.911Z',
      lastSyncedModifyTime: '2026-07-08T10:00:00.000Z',
    });
    const md = `${header}# Real content below\n`;

    const meta = scanner.parseMetadata(md);
    expect(meta).not.toBeNull();
    expect(meta!.header_format).toBe('yaml_html');
    expect(meta!.obj_token).toBe('doxcnTest789');
    expect(meta!.wiki_node_token).toBe('wikicnTest123');
    expect(meta!.space_id).toBe('spaceTest456');
    expect(meta!.obj_type).toBe('docx');
    expect(meta!.original_link).toBe(
      'https://qcnbafdrjx7n.feishu.cn/wiki/wikicnTest123',
    );
    expect(meta!.fetch_date).toBe('2026-07-08T09:21:54.911Z');
    expect(meta!.last_synced_modify_time).toBe('2026-07-08T10:00:00.000Z');
  });

  it('sheet (CORE FIX): header round-trips with obj_type=sheet and NON-EMPTY original_link', () => {
    const { engine } = makeEngine();
    // Mirrors the sheet-path meta produced by resolveHeaderMeta when
    // fetched.url='' and original_link is constructed from wiki_node_token.
    const header = internals(engine).generateHtmlHeader({
      objToken: 'sheetcnTest321',
      objType: 'sheet',
      wikiNodeToken: 'wikicnTest123',
      spaceId: 'spaceTest456',
      originalLink: 'https://qcnbafdrjx7n.feishu.cn/wiki/wikicnTest123',
      fetchDate: '2026-07-08T09:21:54.912Z',
      lastSyncedModifyTime: '2026-07-08T11:00:00.000Z',
    });
    const md = `${header}# Sheet title\n`;

    const meta = scanner.parseMetadata(md);
    expect(meta).not.toBeNull();
    expect(meta!.header_format).toBe('yaml_html');
    // Core fix: obj_type=sheet (previously defaulted to docx because the
    // legacy header carried no obj_type field at all).
    expect(meta!.obj_type).toBe('sheet');
    expect(meta!.obj_token).toBe('sheetcnTest321');
    // Core fix: original_link is non-empty.
    expect(meta!.original_link).toBeTruthy();
    expect(meta!.original_link).not.toBe('');
    expect(meta!.original_link).toBe(
      'https://qcnbafdrjx7n.feishu.cn/wiki/wikicnTest123',
    );
    expect(meta!.wiki_node_token).toBe('wikicnTest123');
  });

  it('sheet: emitted header has NO legacy `节点: unknown` and NO empty `原始链接:` line', () => {
    const { engine } = makeEngine();
    const header = internals(engine).generateHtmlHeader({
      objToken: 'sheetcnTest321',
      objType: 'sheet',
      wikiNodeToken: 'wikicnTest123',
      spaceId: 'spaceTest456',
      originalLink: 'https://qcnbafdrjx7n.feishu.cn/wiki/wikicnTest123',
      fetchDate: '2026-07-08T09:21:54.912Z',
      lastSyncedModifyTime: '2026-07-08T11:00:00.000Z',
    });
    // Regression guards for the exact legacy defects the fix addresses.
    expect(header).not.toContain('节点: unknown');
    expect(header).not.toContain('节点:');
    // No empty `原始链接:` line (legacy produced `原始链接:` followed by
    // nothing because fetched.url was '').
    expect(header).not.toMatch(/原始链接:\s*\n/);
    expect(header).not.toContain('原始链接:');
  });

  it('boundary: no host + no wiki_node_token -> original_link omitted, obj_token keeps file indexable', () => {
    const { engine } = makeEngine();
    const header = internals(engine).generateHtmlHeader({
      objToken: 'orphanToken',
      objType: 'unknown',
      wikiNodeToken: null,
      spaceId: null,
      originalLink: null,
      fetchDate: '2026-07-08T09:00:00.000Z',
      lastSyncedModifyTime: '',
    });
    const md = `${header}# Orphan body\n`;

    const meta = scanner.parseMetadata(md);
    expect(meta).not.toBeNull();
    // obj_token present -> IndexScanner.indexFile indexes it (no de-hook).
    expect(meta!.obj_token).toBe('orphanToken');
    // original_link is not fabricated.
    expect(meta!.original_link).toBeUndefined();
    // obj_type omitted -> IndexScanner.indexFile falls back to 'docx'.
    expect(meta!.obj_type).toBeUndefined();
  });

  it('full write->read loop: writeLocalMarkdown output is parseable by IndexScanner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-engine-loop-'));
    try {
      const { engine } = makeEngine();
      const mdPath = path.join(dir, 'loop.md');
      const meta: HeaderMetaLike = {
        objToken: 'loopTok',
        objType: 'sheet',
        wikiNodeToken: 'loopNode',
        spaceId: 'loopSpace',
        originalLink: 'https://qcnbafdrjx7n.feishu.cn/wiki/loopNode',
        fetchDate: '2026-07-08T09:00:00.000Z',
        lastSyncedModifyTime: '2026-07-08T10:00:00.000Z',
      };
      // Exercise the real write path (generateHtmlHeader + fs write) then
      // re-read via the real parser, proving the on-disk format is valid.
      await internals(engine).writeLocalMarkdown(mdPath, 'sheet body\n', meta);
      const onDisk = fs.readFileSync(mdPath, 'utf-8');
      const parsed = scanner.parseMetadata(onDisk);
      expect(parsed).not.toBeNull();
      expect(parsed!.header_format).toBe('yaml_html');
      expect(parsed!.obj_type).toBe('sheet');
      expect(parsed!.obj_token).toBe('loopTok');
      expect(parsed!.original_link).toBe(
        'https://qcnbafdrjx7n.feishu.cn/wiki/loopNode',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// bitable (多维表格) 分型接入 — 2026-10 完整同步
//
// 覆盖验收项：
//   (a) generateHtmlHeader emits obj_type: bitable（具体类型不再折叠）
//   (b) header round-trips through the REAL IndexScanner.parseMetadata
//   (c) syncDocuments(bitable) 不调 docs+fetch（mock 里 fetchDocumentMarkdown
//       一旦被调用即抛错），走 BitableExporter 确定性导出，md/CSV/base-meta/
//       附件全部原子提交，DB 基线推进
//   (d) ChangeDetector.normalizeObjType 放行 bitable
// =========================================================================
describe('SyncEngine — bitable pipeline', () => {
  it('generateHtmlHeader: emits obj_type: bitable and round-trips via IndexScanner.parseMetadata', () => {
    const { engine } = makeEngine();
    const header = internals(engine).generateHtmlHeader({
      objToken: 'bas3cnRoundTrip',
      objType: 'bitable',
      wikiNodeToken: 'wikicnTest123',
      spaceId: 'spaceTest456',
      originalLink: 'https://qcnbafdrjx7n.feishu.cn/wiki/wikicnTest123',
      fetchDate: '2026-10-08T09:00:00.000Z',
      lastSyncedModifyTime: '2026-10-08T10:00:00.000Z',
    });
    expect(header).toContain('  obj_type: "bitable"');

    const md = `${header}# 多维表格正文\n`;
    const meta = scanner.parseMetadata(md);
    expect(meta).not.toBeNull();
    expect(meta!.header_format).toBe('yaml_html');
    // round-trip：写出的 bitable 必须被扫描器读回 bitable（索引不降级）
    expect(meta!.obj_type).toBe('bitable');
    expect(meta!.obj_token).toBe('bas3cnRoundTrip');
  });

  it('syncDocuments(bitable): skips docs+fetch, exports deterministically, commits md+csv+meta+attachment, advances baseline', async () => {
    const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-bitable-kb-'));
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-bitable-ops-'));
    try {
      const store = new BitablePipelineStore();
      // fetchDocumentMarkdown 被调用即炸：bitable 绝不能走 docs+fetch
      // （历史 3380002 教训）。
      const larkCliClient = new BitableMockClient();
      const engine = new SyncEngine({
        larkCliClient,
        localMapStore: store,
        config: {
          knowledgeBaseRoot: kbRoot,
          operationManifestDir: opDir,
          watchedRoots: [],
          watchedRootUrls: [],
        },
      } as any);

      const doc: ChangedDocument = {
        objToken: 'bas3cnPipeline1',
        objType: 'bitable',
        title: '多维表格测试',
        changeType: 'added',
        cloudModifiedTime: '2026-10-08T10:00:00.000Z',
        localSyncedTime: null,
        localMdPath: path.join(kbRoot, '多维表格测试.md'),
        observedObjEditTime: 1759946400,
      };

      const result = await engine.syncDocuments([doc], {
        enableLLM: false,
        fullSync: false,
        apply: true,
        confirmation: 'APPLY',
      });

      expect(result.success).toBe(true);
      expect(result.failedDocuments.length).toBe(0);
      expect(result.syncedDocuments.length).toBe(1);
      // 附件计数来自 exporter（1 成功 / 1 失败软降级）
      expect(result.syncedDocuments[0].attachmentsCount).toBe(1);

      // docs+fetch 从未被调用（mock 内部 throw 会炸掉整个 sync）
      expect(larkCliClient.fetchDocumentMarkdownCalls).toBe(0);

      // md 落盘：header obj_type=bitable + 数据表章节 + CSV 链接
      const mdPath = path.join(kbRoot, '多维表格测试.md');
      expect(fs.existsSync(mdPath)).toBe(true);
      const md = fs.readFileSync(mdPath, 'utf-8');
      expect(md).toContain('obj_type: "bitable"');
      expect(md).toContain('## 数据表: 主数据表');
      expect(md).toContain('[CSV 原始数据](多维表格测试.csv-data/主数据表.csv)');

      // round-trip：落盘 header 被 IndexScanner 读回 bitable
      const parsed = scanner.parseMetadata(md);
      expect(parsed!.obj_type).toBe('bitable');
      expect(parsed!.obj_token).toBe('bas3cnPipeline1');

      // CSV 与 base 元数据随 md 原子提交
      const csvPath = path.join(kbRoot, '多维表格测试.csv-data', '主数据表.csv');
      expect(fs.existsSync(csvPath)).toBe(true);
      expect(fs.readFileSync(csvPath, 'utf-8')).toContain('recBT1');
      const metaPath = path.join(kbRoot, '多维表格测试.base-meta', 'dashboards.json');
      expect(fs.existsSync(metaPath)).toBe(true);

      // 附件提交到 attachments/
      const attPath = path.join(kbRoot, 'attachments', '01-说明图.png');
      expect(fs.existsSync(attPath)).toBe(true);

      // DB 基线推进
      expect(store.upserted[0].objType).toBe('bitable');
      expect(store.markSyncedCalls.length).toBe(1);
      expect(store.markSyncedCalls[0].objToken).toBe('bas3cnPipeline1');
      expect(store.markSyncedCalls[0].syncedObjEditTime).toBe(1759946400);
    } finally {
      fs.rmSync(kbRoot, { recursive: true, force: true });
      fs.rmSync(opDir, { recursive: true, force: true });
    }
  });

  it('ChangeDetector.normalizeObjType passes bitable through (no unknown collapse)', () => {
    const detector = new ChangeDetector({} as any, {} as any);
    const normalize = (detector as unknown as {
      normalizeObjType(raw: string): string;
    }).normalizeObjType.bind(detector);
    expect(normalize('bitable')).toBe('bitable');
    expect(normalize('docx')).toBe('docx');
    expect(normalize('sheet')).toBe('sheet');
    expect(normalize('slides')).toBe('slides');
    // mindnote / file / 其他仍折叠 unknown（不支持导出的类型保持原行为）
    expect(normalize('mindnote')).toBe('unknown');
    expect(normalize('file')).toBe('unknown');
  });
});

/** syncDocuments 全链路所需的最小 LocalMapStore 替身。 */
class BitablePipelineStore extends MockLocalMapStore {
  upserted: Array<Record<string, unknown>> = [];
  markSyncedCalls: Array<Record<string, unknown>> = [];
  upsertDocument(record: DocumentRecord): void {
    this.upserted.push({ ...record });
  }
  markDocumentSynced(input: Record<string, unknown>): void {
    this.markSyncedCalls.push({ ...input });
  }
  logSync(): void {
    /* syncDocuments 收尾日志，无需落盘 */
  }
}

/**
 * bitable 全链路 mock：只实现 base 面；fetchDocumentMarkdown 一旦被调用
 * 立即抛错并计数——它是「绝不能被调用」的哨兵。
 */
class BitableMockClient {
  fetchDocumentMarkdownCalls = 0;

  async fetchDocumentMarkdown(): Promise<never> {
    this.fetchDocumentMarkdownCalls += 1;
    throw new Error('bitable 绝不能走 docs+fetch（3380002）');
  }

  async listBaseTables() {
    return { data: { items: [{ table_id: 'tblBT', name: '主数据表' }], has_more: false } };
  }

  async listBaseFields() {
    return {
      data: {
        items: [
          { field_id: 'fld_bt1', field_name: '名称', type: 'text', is_primary: true },
          { field_id: 'fld_bt2', field_name: '附件', type: 'attachment' },
        ],
        has_more: false,
      },
    };
  }

  async listBaseViews() {
    return { data: { views: [{ view_id: 'viwBT', view_name: '全部', view_type: 'grid' }], has_more: false } };
  }

  async listBaseRecords() {
    return {
      data: {
        items: [
          {
            record_id: 'recBT1',
            fields: {
              名称: [{ type: 'text', text: '配置项 A' }],
              附件: [{ file_token: 'btftok1', name: '说明图.png' }],
            },
          },
        ],
        has_more: false,
      },
    };
  }

  async downloadBaseAttachment(options: { fileToken: string; outputDir: string }) {
    const target = path.join(options.outputDir, '说明图.png');
    fs.writeFileSync(target, 'bitable-attachment-bytes', 'utf-8');
    return { ok: true, data: { saved_path: target } };
  }

  async listBaseDashboards() {
    return { data: { items: [{ id: 'dash1' }] } };
  }

  async listBaseWorkflows() {
    return { data: { items: [] } };
  }

  async listBaseForms() {
    return { data: { items: [] } };
  }
}

// =========================================================================
// docx 内嵌 <sheet> 标签展开 — 按标签 sheetId 过滤（2026-09-10 实测修复）
//
// 事故背景：同一 workbook 的多个子表在同一 docx 里各占一个 <sheet> 标签，
// 旧逻辑对每个标签导出整个 workbook 全部子表：28 标签 × 30 子表 →
// md 里 840 个「## 子表:」段（23KB→333KB）+ 28 个 csv-data 目录 × 30 份
// CSV。回归断言：每标签只导 sheet_id 匹配的那一个子表；匹配不到回退全量。
// =========================================================================

/** docx 内嵌 sheet 展开全链路 mock：workbook 3 子表，仅 2 个被标签引用。 */
class InlineSheetMockClient {
  workbookCalls: string[] = [];
  csvCalls: Array<{ token: string; sheetId: string }> = [];

  async fetchDocumentMarkdown() {
    return {
      data: {
        document: {
          content:
            '# 部队初始化\n\n' +
            '<sheet sheet-id="aaaaaa" token="sswbkInline1"></sheet>\n\n' +
            '<sheet sheet-id="bbbbbb" token="sswbkInline1"></sheet>\n\n' +
            '## 结尾\n',
        },
      },
    };
  }

  async getWorkbookInfo(token: string) {
    this.workbookCalls.push(token);
    return {
      data: {
        sheets: [
          { sheet_id: 'aaaaaa', sheet_name: '阵型表', row_count: 2, column_count: 2 },
          { sheet_id: 'bbbbbb', sheet_name: '装备表', row_count: 2, column_count: 2 },
          { sheet_id: 'cccccc', sheet_name: '未引用表', row_count: 2, column_count: 2 },
        ],
      },
    };
  }

  async getSheetCsv(options: { spreadsheetToken: string; sheetId: string }) {
    this.csvCalls.push({ token: options.spreadsheetToken, sheetId: options.sheetId });
    return { data: { annotated_csv: `text,val\nrow-${options.sheetId},1\n` } };
  }

  async getSheetFloatImages() {
    return { data: {} };
  }
}

describe('SyncEngine — docx inline <sheet> tag expansion (per-tag sheetId filter)', () => {
  it('expands each tag to ONLY its referenced sub-sheet (no full-workbook fan-out)', async () => {
    const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-inline-kb-'));
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-inline-ops-'));
    try {
      const store = new BitablePipelineStore();
      const larkCliClient = new InlineSheetMockClient();
      const engine = new SyncEngine({
        larkCliClient,
        localMapStore: store,
        config: {
          knowledgeBaseRoot: kbRoot,
          operationManifestDir: opDir,
          watchedRoots: [],
          watchedRootUrls: [],
        },
      } as any);

      const doc: ChangedDocument = {
        objToken: 'docxInline1',
        objType: 'docx',
        title: '部队初始化思路',
        changeType: 'modified',
        cloudModifiedTime: '2026-09-10T10:00:00.000Z',
        localSyncedTime: '2026-09-09T10:00:00.000Z',
        localMdPath: path.join(kbRoot, '部队初始化思路.md'),
        observedObjEditTime: 1789000000,
      };

      const result = await engine.syncDocuments([doc], {
        enableLLM: false,
        fullSync: false,
        apply: true,
        confirmation: 'APPLY',
      });

      expect(result.success).toBe(true);
      expect(result.failedDocuments.length).toBe(0);

      const mdPath = path.join(kbRoot, '部队初始化思路.md');
      const md = fs.readFileSync(mdPath, 'utf-8');

      // 2 个标签 → 恰好 2 段「## 子表:」（旧逻辑：2 标签 × 3 子表 = 6 段）
      expect((md.match(/^## 子表: /gm) || []).length).toBe(2);
      // 未引用的子表绝不出现
      expect(md).not.toContain('未引用表');

      // csv-get 只打引用过的 2 个 sheet_id，各一次
      expect(larkCliClient.csvCalls.map((call) => call.sheetId).sort()).toEqual([
        'aaaaaa',
        'bbbbbb',
      ]);

      // 每个 csv-data 目录只含 1 份 CSV（docname_<sheetId> 命名约定不变）
      const csvDirs = fs.readdirSync(kbRoot).filter((name) => name.includes('.csv-data'));
      expect(csvDirs.sort()).toEqual([
        '部队初始化思路_aaaaaa.csv-data',
        '部队初始化思路_bbbbbb.csv-data',
      ]);
      for (const dir of csvDirs) {
        const files = fs.readdirSync(path.join(kbRoot, dir));
        expect(files.length).toBe(1);
      }
    } finally {
      fs.rmSync(kbRoot, { recursive: true, force: true });
      fs.rmSync(opDir, { recursive: true, force: true });
    }
  });

  it('falls back to full-workbook export when sheet-id is empty or unmatched', async () => {
    const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-inline-fb-'));
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-inline-fb-ops-'));
    try {
      const store = new BitablePipelineStore();
      const client = new InlineSheetMockClient();
      // 覆写正文：一个空 sheet-id 标签 + 一个指向已删除子表的标签
      client.fetchDocumentMarkdown = async () => ({
        data: {
          document: {
            content:
              '# 回退场景\n\n' +
              '<sheet sheet-id="" token="sswbkInline1"></sheet>\n\n' +
              '<sheet sheet-id="zzzzzz" token="sswbkInline1"></sheet>\n',
          },
        },
      });
      const engine = new SyncEngine({
        larkCliClient: client,
        localMapStore: store,
        config: {
          knowledgeBaseRoot: kbRoot,
          operationManifestDir: opDir,
          watchedRoots: [],
          watchedRootUrls: [],
        },
      } as any);

      const doc: ChangedDocument = {
        objToken: 'docxInlineFallback',
        objType: 'docx',
        title: '回退场景',
        changeType: 'added',
        cloudModifiedTime: '2026-09-10T10:00:00.000Z',
        localSyncedTime: null,
        localMdPath: path.join(kbRoot, '回退场景.md'),
        observedObjEditTime: 1789000000,
      };

      const result = await engine.syncDocuments([doc], {
        enableLLM: false,
        fullSync: false,
        apply: true,
        confirmation: 'APPLY',
      });
      expect(result.success).toBe(true);

      const md = fs.readFileSync(path.join(kbRoot, '回退场景.md'), 'utf-8');
      // 每个回退标签各导出全部 3 子表：2 × 3 = 6 段
      expect((md.match(/^## 子表: /gm) || []).length).toBe(6);
      expect(md).toContain('未引用表');
    } finally {
      fs.rmSync(kbRoot, { recursive: true, force: true });
      fs.rmSync(opDir, { recursive: true, force: true });
    }
  });
});
