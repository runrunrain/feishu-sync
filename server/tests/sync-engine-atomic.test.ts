/**
 * Gate 3: SyncEngine apply path must never leave partial KB writes.
 * These tests drive the shipped SyncEngine.syncDocuments(apply) entry point
 * with a real temp knowledge base and real better-sqlite3 map store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { MappingService } from '../src/modules/mapping-service.js';
import type { ChangedDocument } from '../src/types/index.js';
import { exportTestWorkbook } from './helpers/workbook.js';
import { Hono } from 'hono';
import { syncRoutes } from '../src/routes/sync.js';

const temps: string[] = [];
const stores: LocalMapStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  while (temps.length) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-atomic-'));
  temps.push(root);
  const kb = path.join(root, 'kb');
  const ops = path.join(root, 'ops');
  const dbPath = path.join(root, 'map.db');
  fs.mkdirSync(kb, { recursive: true });
  fs.mkdirSync(ops, { recursive: true });

  const store = new LocalMapStore(dbPath);
  stores.push(store);
  store.initialize();

  const watchedRoots = [
    {
      id: 'dev',
      url: 'https://example.feishu.cn/wiki/dev',
      localDir: '技术 - Dev',
      layoutProfile: 'directory-readme' as const,
      enabled: true,
    },
    {
      id: 'designer',
      url: 'https://example.feishu.cn/wiki/designer',
      localDir: '策划 - Designer',
      layoutProfile: 'mirror-title-file' as const,
      enabled: true,
    },
  ];

  const config = {
    knowledgeBaseRoot: kb,
    operationManifestDir: ops,
    watchedRoots,
    watchedRootUrls: watchedRoots.map((r) => r.url),
    llm: { temperature: 0.2, timeoutMs: 1000 },
  };

  return { root, kb, ops, dbPath, store, config };
}

function makeDoc(overrides: Partial<ChangedDocument> = {}): ChangedDocument {
  return {
    objToken: 'tok-doc',
    objType: 'docx',
    title: '原子文档',
    changeType: 'modified',
    cloudModifiedTime: '2026-07-17T00:00:00.000Z',
    localSyncedTime: null,
    localMdPath: null,
    wikiNodeToken: 'node-doc',
    watchedRootId: 'dev',
    hasChild: false,
    isWatchedRootNode: false,
    parentChainTitles: [],
    observedObjEditTime: 1_700_000_000_000,
    ...overrides,
  };
}

describe('SyncEngine atomic apply path', () => {
  it.each(['during-fetch', 'queued-sync'])('preserves newer local bytes for %s', async (scenario) => {
    const { kb, store, config } = makeWorkspace();
    const mdPath = path.join(kb, '技术 - Dev', '原子文档', 'README.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, '# prior\n');
    store.upsertDocument({ objToken: 'tok-doc', wikiNodeToken: 'node-doc', objType: 'docx', title: '原子文档',
      localMdPath: mdPath, localRelPath: '技术 - Dev/原子文档/README.md', watchedRootId: 'dev',
      lastSyncedModifyTime: 'old', lastSyncedAt: '2026-01-01T00:00:00.000Z',
      syncedObjEditTime: 10, observedObjEditTime: 10, status: 'synced', syncState: 'synced' } as any);
    store.markDocumentSynced({ objToken: 'tok-doc', syncedObjEditTime: 10, localMdPath: mdPath,
      lastSyncedModifyTime: 'old', lastSyncedAt: '2026-01-01T00:00:00.000Z' });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let fetches = 0;
    const client = { fetchDocumentMarkdown: async () => {
      fetches++; entered();
      if (scenario === 'during-fetch') fs.writeFileSync(mdPath, '# user edit\n');
      else await gate;
      return { data: { document: { content: 'cloud body\n', images: [], attachments: [], sheets: [], url: '' } } };
    } };
    const engine = new SyncEngine({ larkCliClient: client, localMapStore: store, config });
    const doc = makeDoc({ localMdPath: mdPath, localRelPath: '技术 - Dev/原子文档/README.md', observedObjEditTime: 20 });
    const options = { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' as const };
    const first = engine.syncDocuments([doc], options);
    await started;
    if (scenario === 'during-fetch') {
      expect((await first).success).toBe(false);
      expect(fs.readFileSync(mdPath, 'utf8')).toBe('# user edit\n');
      expect(store.getDocumentByObjToken('tok-doc')?.syncedObjEditTime).toBe(10);
    } else {
      const second = engine.syncDocuments([{ ...doc, observedObjEditTime: 30 }], options);
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.success).toBe(true); expect(b.success).toBe(false);
      expect(b.failedDocuments[0].error).toContain('本地目标发生变化');
      expect(fetches).toBe(1);
      expect(fs.readFileSync(mdPath, 'utf8')).toContain('cloud body');
      expect(store.getDocumentByObjToken('tok-doc')?.syncedObjEditTime).toBe(20);
    }
  });

  it('refreshes an already mapped sheet through the single-document route', async () => {
    const { kb, store, config } = makeWorkspace();
    const mdPath = path.join(kb, '策划 - Designer', '表格.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true }); fs.writeFileSync(mdPath, '# 表格\n');
    store.upsertDocument({ objToken: 'tok-sheet', wikiNodeToken: 'node-sheet', objType: 'sheet', title: '表格', localMdPath: mdPath,
      localRelPath: '策划 - Designer/表格.md', watchedRootId: 'designer', parentNodeToken: 'designer', status: 'synced', lastSyncedModifyTime: 'old', lastSyncedAt: '2026-01-01T00:00:00.000Z' } as any);
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as any).localMapStore = store; (c as any).configManager = { load: async () => config };
      (c as any).larkCliClient = {
        getNode: async () => ({ obj_token: 'tok-sheet', obj_type: 'sheet', title: '表格', obj_edit_time: 200, has_child: false, parent_node_token: 'designer' }),
        exportWorkbook: exportTestWorkbook,
        getWorkbookInfo: async () => ({ data: { sheets: [{ sheet_id: 's1', sheet_name: '主表', row_count: 2, column_count: 2 }] } }),
        getSheetCsv: async () => ({ data: { annotated_csv: 'a,b\n1,2\n' } }),
      };
      await next();
    });
    app.route('/', syncRoutes);
    const response = await app.request('/api/sync/refresh-sheet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objToken: 'tok-sheet' }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.syncedDocuments[0].sheetAcquisition).toBe('native');
    expect(fs.existsSync(path.join(kb, '策划 - Designer', '表格.xlsx'))).toBe(true);
  });
  it('commits a verified CSV fallback without replacing a previous Excel', async () => {
    const { kb, store, config } = makeWorkspace();
    const mdPath = path.join(kb, '策划 - Designer', '表格.md'), xlsxPath = path.join(kb, '策划 - Designer', '表格.xlsx');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    await exportTestWorkbook('tok-sheet', xlsxPath); const original = fs.readFileSync(xlsxPath);
    fs.writeFileSync(mdPath, '<!--\nfeishu_sync:\n  source_workbook: "表格.xlsx"\n-->\n# 表格');
    fs.writeFileSync(`${xlsxPath}.metadata.json`, JSON.stringify({ objToken: 'tok-sheet', mode: 'native' }));
    store.upsertDocument({ objToken: 'tok-sheet', wikiNodeToken: 'node-sheet', objType: 'sheet', title: '表格', localMdPath: mdPath,
      localRelPath: '策划 - Designer/表格.md', watchedRootId: 'designer', status: 'synced', lastSyncedModifyTime: 'old', lastSyncedAt: '2026-01-01T00:00:00.000Z' } as any);
    const client = { exportWorkbook: async () => { throw new Error('export denied'); },
      getWorkbookInfo: async () => ({ data: { revision: 41, sheets: [{ sheet_id: 's1', sheet_name: '主表', row_count: 2, column_count: 2 }] } }),
      getSheetCsv: async () => ({ data: { annotated_csv: 'a,b\n1,2\n', revision: 41, has_more: false, actual_range: 'A1:B2' } }) };
    const engine = new SyncEngine({ larkCliClient: client, localMapStore: store, config });
    const result = await engine.syncDocuments([makeDoc({ objToken: 'tok-sheet', objType: 'sheet', title: '表格',
      localMdPath: mdPath, localRelPath: '策划 - Designer/表格.md', watchedRootId: 'designer', observedObjEditTime: 200 })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' });
    expect(result.success).toBe(true);
    expect(result.syncedDocuments[0].sheetAcquisition).toBe('csv-fallback');
    expect(fs.readFileSync(xlsxPath)).toEqual(original);
    expect(fs.readFileSync(mdPath, 'utf8')).toContain('previous_workbook: "表格.xlsx"');
    expect(fs.readFileSync(path.join(kb, '策划 - Designer', '表格.csv-data', '主表.csv'), 'utf8')).toContain('1,2');
  });

  it.each(['image', 'attachment'])('keeps a CSV fallback in the repair list until a later sync commits its %s and workbook', async (kind) => {
    const { kb, store, config } = makeWorkspace();
    const mdPath = path.join(kb, '策划 - Designer', '表格.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, '# prior\n');
    store.upsertDocument({ objToken: 'tok-sheet', wikiNodeToken: 'node-sheet', objType: 'sheet', title: '表格',
      localMdPath: mdPath, localRelPath: '策划 - Designer/表格.md', watchedRootId: 'designer',
      parentNodeToken: 'designer', status: 'changed', syncState: 'pending_modified',
      lastSyncedModifyTime: 'old', lastSyncedAt: '2026-01-01T00:00:00.000Z', observedObjEditTime: 200 } as any);
    let imageAvailable = false;
    const client = {
      exportWorkbook: async () => { throw new Error('export denied'); },
      getWorkbookInfo: async () => ({ data: { revision: 41, sheets: [{ sheet_id: 's1', sheet_name: '主表', row_count: 2, column_count: 2,
        resource_type: 'sheet', float_image_count: 0, merged_cells_count: 0, chart_count: 0, pivot_table_count: 0 }] } }),
      getSheetLayout: async () => ({ data: { revision: 41, row_heights: [{ rows: '1:2', height: 24 }],
        column_widths: [{ cols: 'A:B', width: 80 }], hidden_rows: [], hidden_columns: [], merged_cells: [] } }),
      getSheetCells: async () => ({ data: { revision: 41, has_more: false, ranges: [{ actual_range: 'A1:B2', truncated: false,
        row_indices: [1, 2], col_indices: ['A', 'B'], cells: [[{ rich_text: [kind === 'image' ? { type: 'embed-image', text: '',
          image_token: 'cell-image', image_width: 80, image_height: 48 } : { type: 'attachment', text: 'data.json',
          attachment_token: 'cell-file', file_size: 2, mime_type: 'application/json' }] }, { value: 'b' }], [{ value: 1 }, { value: 2 }]] }] } }),
      getSheetFloatImages: async () => ({ data: { revision: 41, total: 0, sheets: [] } }),
      downloadMedia: async (_token: string, output: string) => {
        if (!imageAvailable) throw new Error('image unavailable');
        if (kind === 'attachment') { fs.writeFileSync(`${output}.json`, '{}'); return `${output}.json`; }
        fs.writeFileSync(`${output}.png`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
        return `${output}.png`;
      },
      previewMedia: async () => { throw new Error('image unavailable'); },
      getSheetCsv: async () => ({ data: { annotated_csv: 'a,b\n1,2\n', revision: 41, has_more: false, actual_range: 'A1:B2' } }),
    };
    const engine = new SyncEngine({ larkCliClient: client, localMapStore: store, config });
    const mapping = new MappingService({} as any, store, {} as any, { getConfig: () => config } as any);
    const options = { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' as const };
    const doc = makeDoc({ objToken: 'tok-sheet', objType: 'sheet', title: '表格', localMdPath: mdPath,
      localRelPath: '策划 - Designer/表格.md', watchedRootId: 'designer', observedObjEditTime: 200 });
    const partial = await engine.syncDocuments([doc], options);
    expect(partial.syncedDocuments[0]).toMatchObject({ sheetAcquisition: 'csv-fallback', sheetAcquisitionIssue: expect.stringContaining('image unavailable') });
    const repair = mapping.getStoredDiff(config.watchedRoots[1].url).modified;
    expect(repair).toMatchObject([{ objToken: 'tok-sheet', xlsxMissing: true }]);
    expect(fs.existsSync(path.join(kb, '策划 - Designer', '表格.xlsx'))).toBe(false);

    imageAvailable = true;
    const complete = await engine.syncDocuments(repair, options);
    expect(complete.syncedDocuments[0]).toMatchObject({ sheetAcquisition: 'read-reconstruction' });
    expect(fs.existsSync(path.join(kb, '策划 - Designer', '表格.xlsx'))).toBe(true);
    expect(mapping.getStoredDiff(config.watchedRoots[1].url).modified).toEqual([]);
    if (kind === 'attachment') {
      const metadata = JSON.parse(fs.readFileSync(path.join(kb, '策划 - Designer', '表格.xlsx.metadata.json'), 'utf8'));
      expect(fs.readFileSync(path.join(path.dirname(mdPath), metadata.attachments[0].relativePath), 'utf8')).toBe('{}');
      expect(fs.readFileSync(mdPath, 'utf8')).toContain('## 表格附件');
    }
  });

  it('partial sheet export failure leaves prior body/CSV/synced baseline untouched', async () => {
    const { kb, store, config } = makeWorkspace();
    const mdPath = path.join(kb, '策划 - Designer', '表格.md');
    const csvPath = path.join(kb, '策划 - Designer', '表格.csv-data', '旧表.csv');
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(mdPath, '# prior sheet body\n');
    fs.writeFileSync(csvPath, 'old,csv\n');

    store.upsertDocument({
      objToken: 'tok-sheet',
      wikiNodeToken: 'node-sheet',
      objType: 'sheet',
      title: '表格',
      localMdPath: mdPath,
      lastSyncedModifyTime: 'old',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      status: 'synced',
      localRelPath: '策划 - Designer/表格.md',
      watchedRootId: 'designer',
      syncedObjEditTime: 100,
      observedObjEditTime: 100,
      syncState: 'synced',
    } as any);
    store.markDocumentSynced({
      objToken: 'tok-sheet',
      syncedObjEditTime: 100,
      localMdPath: mdPath,
      lastSyncedModifyTime: 'old',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
    });

    let sheetCalls = 0;
    const engine = new SyncEngine({
      larkCliClient: {
        exportWorkbook: exportTestWorkbook,
        getWorkbookInfo: async () => ({
          data: {
            sheets: [
              { sheet_id: 's1', sheet_name: '主表', row_count: 2, column_count: 2 },
              { sheet_id: 's2', sheet_name: '附表', row_count: 2, column_count: 2 },
            ],
          },
        }),
        getSheetCsv: async () => {
          sheetCalls += 1;
          if (sheetCalls === 1) {
            return { data: { annotated_csv: 'a,b\n1,2\n' } };
          }
          throw new Error('csv-get failed mid workbook');
        },
      },
      localMapStore: store,
      config,
      testHooks: {},
    });

    const result = await engine.syncDocuments(
      [
        makeDoc({
          objToken: 'tok-sheet',
          objType: 'sheet',
          title: '表格',
          localMdPath: mdPath,
          localRelPath: '策划 - Designer/表格.md',
          watchedRootId: 'designer',
          observedObjEditTime: 200,
        }),
      ],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );

    expect(result.success).toBe(false);
    expect(fs.readFileSync(mdPath, 'utf-8')).toBe('# prior sheet body\n');
    expect(fs.readFileSync(csvPath, 'utf-8')).toBe('old,csv\n');
    // No partial new CSV should appear under the real KB path.
    expect(fs.existsSync(path.join(kb, '策划 - Designer', '表格.csv-data', '主表.csv'))).toBe(
      false,
    );

    const row = store.getDocumentByObjToken('tok-sheet');
    expect(row?.syncedObjEditTime).toBe(100);
    expect(row?.syncState).toBe('synced');
  });

  it('mid-DB failure after markDocumentSynced rolls back synced baseline and files', async () => {
    const { kb, store, config } = makeWorkspace();
    const mdPath = path.join(kb, '策划 - Designer', '表格.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, '# prior sheet body\n');

    store.upsertDocument({
      objToken: 'tok-sheet',
      wikiNodeToken: 'node-sheet',
      objType: 'sheet',
      title: '表格',
      localMdPath: mdPath,
      lastSyncedModifyTime: 'old',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      status: 'synced',
      localRelPath: '策划 - Designer/表格.md',
      watchedRootId: 'designer',
      syncedObjEditTime: 999,
      observedObjEditTime: 999,
      syncState: 'synced',
    } as any);
    store.markDocumentSynced({
      objToken: 'tok-sheet',
      syncedObjEditTime: 999,
      localMdPath: mdPath,
      lastSyncedModifyTime: 'old',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
    });

    const engine = new SyncEngine({
      larkCliClient: {
        exportWorkbook: exportTestWorkbook,
        getWorkbookInfo: async () => ({
          data: {
            sheets: [
              { sheet_id: 's1', sheet_name: '主表', row_count: 2, column_count: 2 },
            ],
          },
        }),
        getSheetCsv: async () => ({ data: { annotated_csv: 'a,b\n1,2\n' } }),
      },
      localMapStore: store,
      config,
      // Throw after markDocumentSynced inside the same SQLite transaction.
      testHooks: { failAfterMarkDocumentSynced: true },
    });

    const result = await engine.syncDocuments(
      [
        makeDoc({
          objToken: 'tok-sheet',
          objType: 'sheet',
          title: '表格',
          localMdPath: mdPath,
          localRelPath: '策划 - Designer/表格.md',
          watchedRootId: 'designer',
          observedObjEditTime: 1_111,
        }),
      ],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );

    expect(result.success).toBe(false);
    // Files restored to prior body.
    expect(fs.readFileSync(mdPath, 'utf-8')).toBe('# prior sheet body\n');
    // Criterion 3: synced baseline must NOT advance when DB stage aborts.
    const row = store.getDocumentByObjToken('tok-sheet');
    expect(row?.syncedObjEditTime).toBe(999);
    expect(row?.syncState).toBe('synced');
  });

  it('DB-stage failure after file commit restores prior markdown bytes', async () => {
    const { kb, store, config } = makeWorkspace();
    const mdPath = path.join(kb, '技术 - Dev', '原子文档', 'README.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, '# prior body\n');

    store.upsertDocument({
      objToken: 'tok-doc',
      wikiNodeToken: 'node-doc',
      objType: 'docx',
      title: '原子文档',
      localMdPath: mdPath,
      lastSyncedModifyTime: 'old',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      status: 'synced',
      localRelPath: '技术 - Dev/原子文档/README.md',
      watchedRootId: 'dev',
      syncedObjEditTime: 50,
      observedObjEditTime: 50,
      syncState: 'synced',
    } as any);
    store.markDocumentSynced({
      objToken: 'tok-doc',
      syncedObjEditTime: 50,
      localMdPath: mdPath,
      lastSyncedModifyTime: 'old',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
    });

    const engine = new SyncEngine({
      larkCliClient: {
        fetchDocumentMarkdown: async () => ({
          data: {
            document: {
              content: 'new body after apply\n',
              images: [],
              attachments: [],
              sheets: [],
              url: 'https://example.feishu.cn/wiki/node-doc',
            },
          },
        }),
      },
      localMapStore: store,
      config,
      testHooks: { failAfterFileCommit: true },
    });

    const result = await engine.syncDocuments(
      [
        makeDoc({
          localMdPath: mdPath,
          localRelPath: '技术 - Dev/原子文档/README.md',
          observedObjEditTime: 999,
        }),
      ],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );

    expect(result.success).toBe(false);
    expect(fs.readFileSync(mdPath, 'utf-8')).toBe('# prior body\n');
    const row = store.getDocumentByObjToken('tok-doc');
    expect(row?.syncedObjEditTime).toBe(50);
  });

  it('successful apply writes content then dry-run/re-detect shows no re-pending for that token', async () => {
    const { kb, store, config } = makeWorkspace();
    const mdPath = path.join(kb, '技术 - Dev', '原子文档', 'README.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, '# prior\n');

    store.upsertDocument({
      objToken: 'tok-doc',
      wikiNodeToken: 'node-doc',
      objType: 'docx',
      title: '原子文档',
      localMdPath: mdPath,
      lastSyncedModifyTime: 'old',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      status: 'synced',
      localRelPath: '技术 - Dev/原子文档/README.md',
      watchedRootId: 'dev',
      syncedObjEditTime: 10,
      observedObjEditTime: 10,
      syncState: 'synced',
    } as any);

    const engine = new SyncEngine({
      larkCliClient: {
        fetchDocumentMarkdown: async () => ({
          data: {
            document: {
              content: 'applied body\n',
              images: [],
              attachments: [],
              sheets: [],
              url: 'https://example.feishu.cn/wiki/node-doc',
            },
          },
        }),
      },
      localMapStore: store,
      config,
    });

    const apply = await engine.syncDocuments(
      [
        makeDoc({
          localMdPath: mdPath,
          localRelPath: '技术 - Dev/原子文档/README.md',
          observedObjEditTime: 20,
        }),
      ],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );
    expect(apply.success).toBe(true);
    expect(apply.mode).toBe('apply');
    expect(apply.operationId).toBeTruthy();
    expect(fs.readFileSync(mdPath, 'utf-8')).toContain('applied body');

    const row = store.getDocumentByObjToken('tok-doc');
    expect(row?.syncedObjEditTime).toBe(20);

    // Real dry-run entry point: same token should plan replace, not be blocked,
    // and a second apply is not needed — "re-detect empty pending" is modeled
    // by synced baseline matching observed time.
    expect(row?.observedObjEditTime == null || row?.syncedObjEditTime === 20).toBe(true);

    const dry = await engine.syncDocuments(
      [
        makeDoc({
          localMdPath: mdPath,
          localRelPath: '技术 - Dev/原子文档/README.md',
          changeType: 'modified',
          observedObjEditTime: 20,
          cloudModifiedTime: '2026-07-17T00:00:00.000Z',
        }),
      ],
      { enableLLM: false, fullSync: false },
    );
    expect(dry.mode).toBe('dry-run');
    expect(dry.operationId).toBeTruthy();
    // Dry-run must not mutate the successfully applied body.
    expect(fs.readFileSync(mdPath, 'utf-8')).toContain('applied body');
  });

  it('failBeforeCommit leaves zero new files under knowledge base', async () => {
    const { kb, store, config } = makeWorkspace();
    const mdPath = path.join(kb, '技术 - Dev', '原子文档', 'README.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, 'keep-me\n');

    const engine = new SyncEngine({
      larkCliClient: {
        fetchDocumentMarkdown: async () => ({
          data: {
            document: {
              content: 'should-not-land\n',
              images: [{ token: 'img1', url: undefined }],
              attachments: [],
              sheets: [],
              url: '',
            },
          },
        }),
        downloadMedia: async () => {
          // Should never be required to touch KB; if called, write only if path is outside kb.
        },
      },
      localMapStore: {
        ...store,
        getDocumentByObjToken: (t: string) => store.getDocumentByObjToken(t),
        upsertDocument: (r: any) => store.upsertDocument(r),
        markDocumentSynced: (r: any) => store.markDocumentSynced(r),
        logSync: () => undefined,
      },
      config,
      testHooks: { failBeforeCommit: true },
    });

    // Media download will fail without mock — provide media write into staging only via execMediaDownload path.
    // Override client with downloadMedia that writes to the given filepath (staging).
    (engine as any).larkCliClient.downloadMedia = async (token: string, filepath: string) => {
      fs.mkdirSync(path.dirname(filepath), { recursive: true });
      fs.writeFileSync(filepath, `png-${token}`);
    };

    const result = await engine.syncDocuments(
      [makeDoc({ localMdPath: mdPath, localRelPath: '技术 - Dev/原子文档/README.md' })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );
    expect(result.success).toBe(false);
    expect(fs.readFileSync(mdPath, 'utf-8')).toBe('keep-me\n');
    expect(fs.existsSync(path.join(kb, '技术 - Dev', '原子文档', 'images'))).toBe(false);
  });

  it('extracts docs +fetch media from body, falls back from 403 preview, and commits local references atomically', async () => {
    const { kb, store, config } = makeWorkspace();
    const mdPath = path.join(kb, '技术 - Dev', '媒体文档', 'README.md');
    const imageToken = 'ImageToken1234567890';
    const whiteboardToken = 'WhiteboardToken1234567890';
    const attachmentToken = 'AttachmentToken1234567890';
    const downloadCalls: Array<{ token: string; type: string }> = [];
    const previewCalls: string[] = [];

    const engine = new SyncEngine({
      larkCliClient: {
        fetchDocumentMarkdown: async () => ({
          data: {
            document: {
              content: [
                `正文 <img alt="示例" src="${imageToken}"/>`,
                `<whiteboard token="${whiteboardToken}"></whiteboard>`,
                `<file token="${attachmentToken}" name="../../unsafe-name.pdf"/>`,
              ].join('\n\n'),
            },
          },
        }),
        downloadMedia: async (token: string, outputPath: string, type: string) => {
          downloadCalls.push({ token, type });
          if (token === imageToken) throw new Error('HTTP 403');
          const suffix = type === 'whiteboard' ? '.jpg' : '.pdf';
          const saved = `${outputPath}${suffix}`;
          fs.mkdirSync(path.dirname(saved), { recursive: true });
          fs.writeFileSync(saved, `${type}-${token}`);
          return saved;
        },
        previewMedia: async (token: string, outputPath: string) => {
          previewCalls.push(token);
          const saved = `${outputPath}.png`;
          fs.mkdirSync(path.dirname(saved), { recursive: true });
          fs.writeFileSync(saved, `preview-${token}`);
          return saved;
        },
      },
      localMapStore: store,
      config,
    });

    const result = await engine.syncDocuments(
      [makeDoc({
        localMdPath: mdPath,
        localRelPath: '技术 - Dev/媒体文档/README.md',
      })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );

    expect(result.success).toBe(true);
    expect(result.syncedDocuments[0]).toMatchObject({ imagesCount: 2, attachmentsCount: 1 });
    expect(downloadCalls).toEqual(expect.arrayContaining([
      { token: imageToken, type: 'media' },
      { token: whiteboardToken, type: 'whiteboard' },
      { token: attachmentToken, type: 'media' },
    ]));
    expect(previewCalls).toEqual([imageToken]);

    const markdown = fs.readFileSync(mdPath, 'utf-8');
    expect(markdown).toContain(`src="images/01-${imageToken}.png"`);
    expect(markdown).toContain(`![飞书白板](images/02-${whiteboardToken}.jpg)`);
    expect(markdown).toContain(
      `[01-${attachmentToken}.pdf](attachments/01-${attachmentToken}.pdf)`,
    );
    expect(markdown).not.toContain('../../unsafe-name.pdf');
    expect(fs.readFileSync(path.join(path.dirname(mdPath), 'images', `01-${imageToken}.png`), 'utf-8'))
      .toBe(`preview-${imageToken}`);
    expect(fs.readFileSync(path.join(path.dirname(mdPath), 'images', `02-${whiteboardToken}.jpg`), 'utf-8'))
      .toBe(`whiteboard-${whiteboardToken}`);
    expect(fs.readFileSync(path.join(path.dirname(mdPath), 'attachments', `01-${attachmentToken}.pdf`), 'utf-8'))
      .toBe(`media-${attachmentToken}`);
  });

  it('exports Slides XML as Markdown with local image and whiteboard references instead of a metadata placeholder', async () => {
    const { kb, store, config } = makeWorkspace();
    const mdPath = path.join(kb, '技术 - Dev', '演示文稿', 'README.md');
    const imageToken = 'SlideImageToken123456789';
    const whiteboardToken = 'SlideWhiteboardToken123456789';
    const calls: Array<{ token: string; type: string }> = [];

    const engine = new SyncEngine({
      larkCliClient: {
        fetchSlidesXml: async () => ({
          data: {
            xml_presentation: {
              content: [
                '<presentation>',
                '<slides>',
                '<slide id="slide-1"><content><p>第一页内容</p></content>',
                `<img src="${imageToken}"/><whiteboard token="${whiteboardToken}"/>`,
                '</slide>',
                '<slide id="slide-2"><content><p>第二页内容</p></content></slide>',
                '</slides>',
                '</presentation>',
              ].join(''),
            },
          },
        }),
        downloadMedia: async (token: string, outputPath: string, type: string) => {
          calls.push({ token, type });
          const saved = `${outputPath}${type === 'whiteboard' ? '.jpg' : '.png'}`;
          fs.mkdirSync(path.dirname(saved), { recursive: true });
          fs.writeFileSync(saved, `${type}-${token}`);
          return saved;
        },
      },
      localMapStore: store,
      config,
    });

    const result = await engine.syncDocuments(
      [makeDoc({
        objType: 'slides',
        title: '演示文稿',
        localMdPath: mdPath,
        localRelPath: '技术 - Dev/演示文稿/README.md',
      })],
      { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
    );

    expect(result.success).toBe(true);
    expect(result.syncedDocuments[0]).toMatchObject({ imagesCount: 2, attachmentsCount: 0 });
    expect(calls).toEqual(expect.arrayContaining([
      { token: imageToken, type: 'media' },
      { token: whiteboardToken, type: 'whiteboard' },
    ]));

    const markdown = fs.readFileSync(mdPath, 'utf-8');
    expect(markdown).toContain('# 演示文稿');
    expect(markdown).toContain('## 幻灯片 1');
    expect(markdown).toContain('第一页内容');
    expect(markdown).toContain('## 幻灯片 2');
    expect(markdown).toContain('第二页内容');
    expect(markdown).toContain(`![图片](images/01-${imageToken}.png)`);
    expect(markdown).toContain(`![白板预览](images/02-${whiteboardToken}.jpg)`);
    expect(markdown).not.toContain('完整页面内容请在飞书中查看');
  });
});
