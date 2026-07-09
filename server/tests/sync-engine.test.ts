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
import type { ChangedDocument, DocumentRecord } from '../src/types/index.js';

// ----- Structural types mirroring SyncEngine's private interfaces -------
// HeaderMeta and FetchedDocument are module-private in sync-engine.ts; we
// mirror their shapes here so the typed cast below stays compile-checked.
interface HeaderMetaLike {
  objToken: string;
  objType: 'docx' | 'sheet' | 'slides' | 'unknown';
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
  extractFeishuHost(): string | null;
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
  watchedRootUrls?: string[];
} = {}): { engine: SyncEngine; store: MockLocalMapStore } {
  const store = new MockLocalMapStore();
  const config = {
    watchedRootUrls:
      opts.watchedRootUrls ??
      // Real configured host for this deployment.
      ['https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb'],
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
    const { engine, store } = makeEngine({ watchedRootUrls: [] });
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
  it('returns the host of the first configured watchedRootUrl', () => {
    const { engine } = makeEngine({
      watchedRootUrls: [
        'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb',
      ],
    });
    expect(internals(engine).extractFeishuHost()).toBe(
      'qcnbafdrjx7n.feishu.cn',
    );
  });

  it('returns null when watchedRootUrls is empty', () => {
    const { engine } = makeEngine({ watchedRootUrls: [] });
    expect(internals(engine).extractFeishuHost()).toBeNull();
  });

  it('returns null when watchedRootUrls is not an array', () => {
    const { engine } = makeEngine();
    // Sabotage config to the non-array branch.
    (engine as any).config.watchedRootUrls = undefined;
    expect(internals(engine).extractFeishuHost()).toBeNull();
  });

  it('returns null when the first URL is an empty string', () => {
    const { engine } = makeEngine({ watchedRootUrls: [''] });
    expect(internals(engine).extractFeishuHost()).toBeNull();
  });

  it('returns null when the first URL is unparseable (does not throw)', () => {
    const { engine } = makeEngine({ watchedRootUrls: ['not-a-valid-url'] });
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
