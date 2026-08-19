/**
 * Custom-folder archive backend tests.
 *
 * Coverage:
 *   - LocalMapStore: custom_folders table + documents.custom_folder_id migration
 *   - Routes: create / rename / delete / duplicate-name / invalid-name
 *   - Add-docs: success (real atomic write) + parse_failed / already_exists /
 *     unsupported_type / fetch_failed / permission_denied
 *   - Orphan exclusion: custom-folder files are not flagged as orphans
 *
 * Uses a real LocalMapStore (mkdtemp SQLite) + temp knowledge base so the
 * atomic-commit pipeline is exercised end-to-end. The lark-cli client is
 * faked to avoid real network calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

import { LocalMapStore } from '../src/modules/local-map-store.js';
import { customFolderRoutes } from '../src/routes/custom-folders.js';
import { LarkCliError } from '../src/modules/lark-cli-client.js';
import { SnapshotService } from '../src/modules/snapshot-service.js';
import { IndexScanner } from '../src/modules/index-scanner.js';

// ---------------------------------------------------------------------------
// Temp isolation
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fake lark-cli client
// ---------------------------------------------------------------------------

interface FakeNodeInfo {
  node_token: string;
  obj_token: string;
  obj_type: string;
  title: string;
  space_id: string;
  obj_edit_time: number | null;
  has_child: boolean;
}

interface FakeLarkCliOptions {
  /** url/objToken → node info. */
  nodes: Record<string, FakeNodeInfo>;
  /** objToken → markdown body returned by fetchDocumentMarkdown. A string is
   * treated as the content; an object may also carry a `title` to exercise
   * the pure-cloud-doc title-from-fetch resolution. */
  docs?: Record<string, string | { content: string; title?: string }>;
  /** objTokens that should throw a permission error from getNode. */
  permissionDeniedUrls?: Set<string>;
  /** URLs whose getNode should throw a 131005-style "not in wiki" error,
   * simulating a pure cloud document outside any wiki space. */
  nodeGetFailUrls?: Set<string>;
  /** objTokens whose fetchDocumentMarkdown should throw. */
  fetchFailTokens?: Set<string>;
  /** objTokens whose fetch should throw permission. */
  fetchPermissionTokens?: Set<string>;
  /** objToken → sub-sheet list returned by getWorkbookInfo. */
  workbooks?: Record<string, Array<{
    sheet_id: string;
    sheet_name: string;
    row_count?: number;
    column_count?: number;
  }>>;
  /** sheetId → annotated CSV text returned by getSheetCsv. */
  sheetCsv?: Record<string, string>;
  /** sheetId whose csv-get should throw (mid-workbook failure injection). */
  sheetCsvFailIds?: Set<string>;
  /** objToken whose workbook-info should throw a permission error. */
  workbookPermissionTokens?: Set<string>;
}

function makeFakeLarkCli(options: FakeLarkCliOptions) {
  return {
    async getNode(url: string): Promise<FakeNodeInfo> {
      const token = url;
      if (options.nodeGetFailUrls?.has(token)) {
        throw new LarkCliError(
          '131005 document is not in wiki',
          'upstream',
          true,
          '131005',
        );
      }
      if (options.permissionDeniedUrls?.has(token)) {
        throw new LarkCliError('无权限访问该节点', 'permission', false);
      }
      const node = options.nodes[token];
      if (!node) {
        throw new LarkCliError('节点不存在', 'upstream', true);
      }
      return node;
    },
    async fetchDocumentMarkdown(objToken: string): Promise<any> {
      if (options.fetchPermissionTokens?.has(objToken)) {
        throw new LarkCliError('无权限访问该节点', 'permission', false);
      }
      if (options.fetchFailTokens?.has(objToken)) {
        throw new LarkCliError('lark-cli 执行失败：网络错误', 'upstream', true);
      }
      const entry = options.docs?.[objToken];
      const content =
        typeof entry === 'string'
          ? entry
          : entry && typeof entry.content === 'string'
            ? entry.content
            : `# ${objToken}\n\nbody`;
      const title =
        entry && typeof entry === 'object' ? entry.title : undefined;
      const data: any = {
        document: { content, url: `https://feishu.cn/wiki/${objToken}` },
      };
      if (title) data.title = title;
      return { ok: true, data };
    },
    async downloadMedia(token: string, outputPath: string): Promise<string> {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const target = `${outputPath}.png`;
      fs.writeFileSync(target, `fake-image-${token}`);
      return target;
    },
    async getWorkbookInfo(objToken: string): Promise<any> {
      if (options.workbookPermissionTokens?.has(objToken)) {
        throw new LarkCliError('无权限访问该表格', 'permission', false);
      }
      return { data: { sheets: options.workbooks?.[objToken] ?? [] } };
    },
    async getSheetCsv(input: { sheetId: string }): Promise<any> {
      if (options.sheetCsvFailIds?.has(input.sheetId)) {
        throw new LarkCliError('lark-cli 执行失败：网络错误', 'upstream', true);
      }
      return { data: { annotated_csv: options.sheetCsv?.[input.sheetId] ?? '' } };
    },
    async previewMedia(token: string, outputPath: string): Promise<string> {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const target = `${outputPath}.png`;
      fs.writeFileSync(target, `fake-preview-${token}`);
      return target;
    },
  };
}

// ---------------------------------------------------------------------------
// DI app builder
// ---------------------------------------------------------------------------

interface AppDeps {
  store: LocalMapStore;
  larkCli: any;
  knowledgeBaseRoot: string;
}

function buildApp(deps: AppDeps) {
  const app = new Hono();
  app.use('*', async (c: any, next: any) => {
    c.configManager = {
      getConfig: () => ({ knowledgeBaseRoot: deps.knowledgeBaseRoot }),
    };
    c.localMapStore = deps.store;
    c.larkCliClient = deps.larkCli;
    await next();
  });
  app.route('/', customFolderRoutes);
  return app;
}

function newStore(): { store: LocalMapStore; dir: string } {
  const dir = makeTempDir('feishu-cf-store-');
  const store = new LocalMapStore(path.join(dir, 'test.db'));
  store.initialize();
  return { store, dir };
}

// ---------------------------------------------------------------------------
// LocalMapStore schema tests
// ---------------------------------------------------------------------------

describe('LocalMapStore custom-folder schema', () => {
  it('creates custom_folders table and documents.custom_folder_id on a fresh DB', () => {
    const { store } = newStore();
    store.initialize(); // idempotent
    store.close();

    const { store: fresh } = newStore();
    // createCustomFolder + setDocumentCustomFolder exercise both structures.
    fresh.createCustomFolder({ id: 'f1', name: 'My Folder', localRelPath: '_custom/my-folder' });
    const folder = fresh.getCustomFolder('f1');
    expect(folder).not.toBeNull();
    expect(folder!.name).toBe('My Folder');
    expect(folder!.localRelPath).toBe('_custom/my-folder');

    fresh.setDocumentCustomFolder({
      objToken: 'objA',
      folderId: 'f1',
      wikiNodeToken: 'nodeA',
      objType: 'docx',
      title: 'Doc A',
      localMdPath: '/kb/_custom/my-folder/doc-a.md',
      localRelPath: '_custom/my-folder/doc-a.md',
      originalLink: 'https://feishu.cn/wiki/nodeA',
      objEditTime: 1700000000,
      spaceId: 'space1',
    });
    const doc = fresh.getDocumentByObjToken('objA');
    expect(doc).not.toBeNull();
    expect(doc!.customFolderId).toBe('f1');
    expect(doc!.watchedRootUrl).toBeNull();
    expect(doc!.syncState).toBe('synced');
    expect(doc!.cloudMatch).toBe('synced');
    fresh.close();
  });

  it('listCustomFolderDocs returns docs ordered by title', () => {
    const { store } = newStore();
    store.createCustomFolder({ id: 'f1', name: 'F', localRelPath: '_custom/f' });
    store.setDocumentCustomFolder({
      objToken: 'b', folderId: 'f1', wikiNodeToken: null, objType: 'docx',
      title: 'Bravo', localMdPath: '/x/b.md', localRelPath: '_custom/f/b.md',
      originalLink: null, objEditTime: null, spaceId: null,
    });
    store.setDocumentCustomFolder({
      objToken: 'a', folderId: 'f1', wikiNodeToken: null, objType: 'docx',
      title: 'Alpha', localMdPath: '/x/a.md', localRelPath: '_custom/f/a.md',
      originalLink: null, objEditTime: null, spaceId: null,
    });
    const docs = store.listCustomFolderDocs('f1');
    expect(docs.map((d: any) => d.objToken)).toEqual(['a', 'b']);
    store.close();
  });

  it('clearDocumentsCustomFolder nulls custom_folder_id without deleting rows', () => {
    const { store } = newStore();
    store.createCustomFolder({ id: 'f1', name: 'F', localRelPath: '_custom/f' });
    store.setDocumentCustomFolder({
      objToken: 'a', folderId: 'f1', wikiNodeToken: null, objType: 'docx',
      title: 'A', localMdPath: '/x/a.md', localRelPath: '_custom/f/a.md',
      originalLink: null, objEditTime: null, spaceId: null,
    });
    const cleared = store.clearDocumentsCustomFolder('f1');
    expect(cleared).toBe(1);
    const doc = store.getDocumentByObjToken('a');
    expect(doc).not.toBeNull();
    expect(doc!.customFolderId).toBeNull();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Route tests: folder CRUD
// ---------------------------------------------------------------------------

describe('custom-folder routes: CRUD', () => {
  let kbRoot: string;
  let store: LocalMapStore;

  beforeEach(() => {
    kbRoot = makeTempDir('feishu-cf-kb-');
    ({ store } = newStore());
  });

  function app() {
    return buildApp({
      store,
      larkCli: makeFakeLarkCli({ nodes: {} }),
      knowledgeBaseRoot: kbRoot,
    });
  }

  it('POST creates a folder and generates _custom/<sanitized> path', async () => {
    const res = await app().fetch(
      new Request('http://x/api/custom-folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '我的 文档/归档' }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.folder.name).toBe('我的 文档归档');
    expect(body.folder.localRelPath).toBe('_custom/我的 文档归档');
    expect(body.folder.id).toBeTruthy();
  });

  it('POST 400 invalid_name for empty / forbidden-only names', async () => {
    const empty = await app().fetch(
      new Request('http://x/api/custom-folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      }),
    );
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe('invalid_name');

    const forbidden = await app().fetch(
      new Request('http://x/api/custom-folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '/\\:*?"<>|' }),
      }),
    );
    expect(forbidden.status).toBe(400);
    expect((await forbidden.json()).error).toBe('invalid_name');
  });

  it('POST 409 duplicate_name for an existing name', async () => {
    await app().fetch(
      new Request('http://x/api/custom-folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'dup' }),
      }),
    );
    const res = await app().fetch(
      new Request('http://x/api/custom-folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'dup' }),
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('duplicate_name');
  });

  it('POST appends -2/-3 when the sanitized path collides (rename frees a name)', async () => {
    // 1. Create "Foo" → path _custom/Foo.
    const first = await app().fetch(new Request('http://x/api/custom-folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Foo' }),
    }));
    const firstId = (await first.json()).folder.id;
    // 2. Rename it to "Bar" — name changes, path stays _custom/Foo.
    await app().fetch(new Request(`http://x/api/custom-folders/${firstId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bar' }),
    }));
    // 3. Create "Foo" again — name is free, but path _custom/Foo is taken → -2.
    const second = await app().fetch(new Request('http://x/api/custom-folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Foo' }),
    }));
    expect(second.status).toBe(201);
    const body = await second.json();
    expect(body.folder.localRelPath).toBe('_custom/Foo-2');
  });

  it('PATCH renames a folder without changing localRelPath', async () => {
    const created = await app().fetch(new Request('http://x/api/custom-folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'old' }),
    }));
    const id = (await created.json()).folder.id;
    const res = await app().fetch(new Request(`http://x/api/custom-folders/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'new name' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.folder.name).toBe('new name');
    expect(body.folder.localRelPath).toBe('_custom/old');
  });

  it('PATCH 404 for unknown id', async () => {
    const res = await app().fetch(new Request('http://x/api/custom-folders/nope', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    }));
    expect(res.status).toBe(404);
  });

  it('DELETE unlinks docs and removes the folder', async () => {
    const created = await app().fetch(new Request('http://x/api/custom-folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'del' }),
    }));
    const id = (await created.json()).folder.id;
    // Seed a doc into the folder directly via the store.
    store.setDocumentCustomFolder({
      objToken: 'o1', folderId: id, wikiNodeToken: null, objType: 'docx',
      title: 'T', localMdPath: path.join(kbRoot, '_custom/del/t.md'),
      localRelPath: '_custom/del/t.md', originalLink: null, objEditTime: null, spaceId: null,
    });
    const res = await app().fetch(new Request(`http://x/api/custom-folders/${id}`, { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(store.getCustomFolder(id)).toBeNull();
    // Doc row kept but unlinked.
    const doc = store.getDocumentByObjToken('o1');
    expect(doc).not.toBeNull();
    expect(doc!.customFolderId).toBeNull();
  });

  it('GET lists folders with their docs', async () => {
    await app().fetch(new Request('http://x/api/custom-folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'F1' }),
    }));
    const res = await app().fetch(new Request('http://x/api/custom-folders'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.folders.length).toBe(1);
    expect(body.folders[0].name).toBe('F1');
    expect(Array.isArray(body.folders[0].docs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route tests: add docs
// ---------------------------------------------------------------------------

describe('custom-folder routes: add docs', () => {
  let kbRoot: string;
  let store: LocalMapStore;

  beforeEach(() => {
    kbRoot = makeTempDir('feishu-cf-kb-');
    ({ store } = newStore());
  });

  async function makeFolder(name: string): Promise<string> {
    const a = buildApp({
      store,
      larkCli: makeFakeLarkCli({ nodes: {} }),
      knowledgeBaseRoot: kbRoot,
    });
    const res = await a.fetch(new Request('http://x/api/custom-folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }));
    return (await res.json()).folder.id;
  }

  it('adds a docx successfully: writes file + documents row', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        'https://feishu.cn/wiki/nodeX': {
          node_token: 'nodeX', obj_token: 'objX', obj_type: 'docx',
          title: 'My Doc', space_id: 'sp', obj_edit_time: 1700000000, has_child: false,
        },
      },
      docs: { objX: '# My Doc\n\nhello world' },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['https://feishu.cn/wiki/nodeX'] }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].objToken).toBe('objX');
    expect(body.results[0].title).toBe('My Doc');

    // File landed in the KB.
    const expected = path.join(kbRoot, '_custom/Archive/My Doc.md');
    expect(fs.existsSync(expected)).toBe(true);
    const written = fs.readFileSync(expected, 'utf-8');
    expect(written).toContain('obj_token: "objX"');
    expect(written).toContain('hello world');

    // documents row contract.
    const doc = store.getDocumentByObjToken('objX');
    expect(doc).not.toBeNull();
    expect(doc!.customFolderId).toBe(folderId);
    expect(doc!.watchedRootUrl).toBeNull();
    expect(doc!.syncState).toBe('synced');
    expect(doc!.originalLink).toBe('https://feishu.cn/wiki/nodeX');
  });

  it('returns already_exists with structure-tree attribution', async () => {
    const folderId = await makeFolder('Archive');
    // Pre-seed a doc in the structure tree (no custom folder).
    store.upsertDocument({
      objToken: 'objExist', wikiNodeToken: 'nE', objType: 'docx', title: 'Existing',
      localMdPath: '/kb/exist.md', lastSyncedModifyTime: '', lastSyncedAt: '',
      status: 'synced', watchedRootId: 'root1',
    });
    const larkCli = makeFakeLarkCli({
      nodes: {
        u: { node_token: 'nE', obj_token: 'objExist', obj_type: 'docx',
          title: 'Existing', space_id: 's', obj_edit_time: 1, has_child: false },
      },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['u'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('already_exists');
    expect(body.results[0].error.existingLocation).toBe('已在同步结构树');
  });

  it('returns already_exists with folder-name attribution', async () => {
    const folderId = await makeFolder('Archive');
    // Pre-seed a doc already in this folder.
    store.setDocumentCustomFolder({
      objToken: 'objExist2', folderId, wikiNodeToken: 'nE2', objType: 'docx',
      title: 'Existing2', localMdPath: '/kb/_custom/Archive/x.md',
      localRelPath: '_custom/Archive/x.md', originalLink: 'u2', objEditTime: 1, spaceId: 's',
    });
    const larkCli = makeFakeLarkCli({
      nodes: {
        u2: { node_token: 'nE2', obj_token: 'objExist2', obj_type: 'docx',
          title: 'Existing2', space_id: 's', obj_edit_time: 1, has_child: false },
      },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['u2'] }),
    }));
    const body = await res.json();
    expect(body.results[0].error.code).toBe('already_exists');
    expect(body.results[0].error.existingLocation).toBe('Archive');
  });

  it('returns unsupported_type for slides (sheet is now supported)', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        u: { node_token: 'nS', obj_token: 'objS', obj_type: 'slides',
          title: 'Slides', space_id: 's', obj_edit_time: 1, has_child: false },
      },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['u'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('unsupported_type');
    expect(body.results[0].error.message).toContain('docx / sheet');
  });

  it('archives a wiki sheet: writes markdown + csv-data files + sheet mapping row', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        'https://qcn.feishu.cn/wiki/nodeSheet?sheet=7dRcsy': {
          node_token: 'nodeSheet', obj_token: 'objSheetWb', obj_type: 'sheet',
          title: '数值配置表', space_id: 'sp', obj_edit_time: 1787120268, has_child: true,
        },
      },
      workbooks: {
        objSheetWb: [
          { sheet_id: 's1', sheet_name: '总览', row_count: 2, column_count: 2 },
          { sheet_id: 's2', sheet_name: '附表', row_count: 2, column_count: 2 },
        ],
      },
      sheetCsv: {
        s1: '键,值\n版本,v1\n',
        s2: 'a,b\n1,2\n',
      },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['https://qcn.feishu.cn/wiki/nodeSheet?sheet=7dRcsy'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].objType).toBe('sheet');
    expect(body.results[0].title).toBe('数值配置表');

    const md = fs.readFileSync(path.join(kbRoot, '_custom/Archive/数值配置表.md'), 'utf-8');
    expect(md).toContain('obj_type: "sheet"');
    expect(md).toContain('## 子表: 总览');
    expect(md).toContain('## 子表: 附表');
    expect(md).toContain('[CSV 原始数据](数值配置表.csv-data/总览.csv)');
    expect(md).toContain('[CSV 原始数据](数值配置表.csv-data/附表.csv)');
    const csv1 = fs.readFileSync(
      path.join(kbRoot, '_custom/Archive/数值配置表.csv-data/总览.csv'), 'utf-8');
    expect(csv1).toBe('键,值\n版本,v1\n');
    expect(fs.existsSync(path.join(kbRoot, '_custom/Archive/数值配置表.csv-data/附表.csv'))).toBe(
      true,
    );

    const row = store.getDocumentByObjToken('objSheetWb');
    expect(row?.objType).toBe('sheet');
    expect(row?.customFolderId).toBe(folderId);
    expect(row?.wikiNodeToken).toBeNull();
  });

  it('a mid-workbook sheet export failure leaves no partial archive (fetch_failed, no files)', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        u: { node_token: 'nWb', obj_token: 'objWb2', obj_type: 'sheet',
          title: '批量表', space_id: 's', obj_edit_time: 1, has_child: false },
      },
      workbooks: {
        objWb2: [
          { sheet_id: 'ok1', sheet_name: '主表', row_count: 2, column_count: 2 },
          { sheet_id: 'bad2', sheet_name: '坏表', row_count: 2, column_count: 2 },
        ],
      },
      sheetCsv: { ok1: 'a,b\n1,2\n' },
      sheetCsvFailIds: new Set(['bad2']),
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['u'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('fetch_failed');
    expect(fs.existsSync(path.join(kbRoot, '_custom/Archive/批量表.md'))).toBe(false);
    expect(fs.existsSync(path.join(kbRoot, '_custom/Archive/批量表.csv-data'))).toBe(false);
    expect(store.getDocumentByObjToken('objWb2')).toBeNull();
  });

  it('returns permission_denied when workbook-info rejects with permission', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        u: { node_token: 'nWb', obj_token: 'objWb3', obj_type: 'sheet',
          title: '权限表', space_id: 's', obj_edit_time: 1, has_child: false },
      },
      workbookPermissionTokens: new Set(['objWb3']),
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['u'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('permission_denied');
  });

  it('returns permission_denied when getNode rejects with permission', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {},
      permissionDeniedUrls: new Set(['locked']),
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['locked'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('permission_denied');
  });

  it('returns fetch_failed when getNode rejects with upstream error', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({ nodes: {} }); // unknown url → upstream error
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['unknown-url'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('fetch_failed');
  });

  it('returns parse_failed for empty link string', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({ nodes: {} });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: [''] }),
    }));
    const body = await res.json();
    expect(body.results[0].error.code).toBe('parse_failed');
  });

  it('returns permission_denied when docx fetch throws permission', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        u: { node_token: 'nP', obj_token: 'objP', obj_type: 'docx',
          title: 'Locked Doc', space_id: 's', obj_edit_time: 1, has_child: false },
      },
      fetchPermissionTokens: new Set(['objP']),
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['u'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('permission_denied');
  });

  it('rejects more than 20 links with too_many_links', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({ nodes: {} });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const links = Array.from({ length: 21 }, (_, i) => `link-${i}`);
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('too_many_links');
  });

  it('a single doc failure does not abort the rest of the batch', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        good: { node_token: 'nG', obj_token: 'objG', obj_type: 'docx',
          title: 'Good', space_id: 's', obj_edit_time: 1, has_child: false },
      },
      docs: { objG: 'body-good' },
      permissionDeniedUrls: new Set(['bad']),
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['bad', 'good'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('permission_denied');
    expect(body.results[1].ok).toBe(true);
    // Only the successful doc wrote a file.
    expect(fs.existsSync(path.join(kbRoot, '_custom/Archive/Good.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route tests: pure cloud-doc fallback (not in any wiki)
// ---------------------------------------------------------------------------

describe('custom-folder routes: pure cloud-doc fallback', () => {
  let kbRoot: string;
  let store: LocalMapStore;

  beforeEach(() => {
    kbRoot = makeTempDir('feishu-cf-kb-');
    ({ store } = newStore());
  });

  async function makeFolder(name: string): Promise<string> {
    const a = buildApp({
      store,
      larkCli: makeFakeLarkCli({ nodes: {} }),
      knowledgeBaseRoot: kbRoot,
    });
    const res = await a.fetch(new Request('http://x/api/custom-folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }));
    return (await res.json()).folder.id;
  }

  it('archives a pure docx URL (getNode 131005) via direct fetch', async () => {
    const folderId = await makeFolder('Archive');
    const objToken = 'objPureDoc';
    const url = `https://feishu.cn/docx/${objToken}`;
    const larkCli = makeFakeLarkCli({
      nodes: {},
      nodeGetFailUrls: new Set([url]),
      docs: { [objToken]: { content: '# Pure Doc\n\nhello', title: 'Pure Doc' } },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: [url] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].objToken).toBe(objToken);
    expect(body.results[0].title).toBe('Pure Doc');

    // File landed in the KB with the archive contract header.
    const expected = path.join(kbRoot, '_custom/Archive/Pure Doc.md');
    expect(fs.existsSync(expected)).toBe(true);
    const written = fs.readFileSync(expected, 'utf-8');
    expect(written).toContain(`obj_token: "${objToken}"`);
    expect(written).toContain('hello');

    // documents row: custom folder linked, watched-root NULL, original link kept.
    const doc = store.getDocumentByObjToken(objToken);
    expect(doc).not.toBeNull();
    expect(doc!.customFolderId).toBe(folderId);
    expect(doc!.watchedRootUrl).toBeNull();
    expect(doc!.syncState).toBe('synced');
    expect(doc!.originalLink).toBe(url);
  });

  it('derives a token-tail title when fetch omits a title field', async () => {
    const folderId = await makeFolder('Archive');
    const objToken = 'pureNoTitle0001'; // 15 chars → tail = last 12
    const url = `https://feishu.cn/docx/${objToken}`;
    const larkCli = makeFakeLarkCli({
      nodes: {},
      nodeGetFailUrls: new Set([url]),
      docs: { [objToken]: 'body without title field' },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: [url] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].title).toBe(objToken.slice(-12));
    expect(fs.existsSync(path.join(kbRoot, '_custom/Archive', `${objToken.slice(-12)}.md`))).toBe(true);
  });

  it('archives a pure sheets URL (getNode 131005) via workbook pipeline, token-tail title', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {},
      nodeGetFailUrls: new Set(['https://feishu.cn/sheets/objSheetPure']),
      workbooks: {
        objSheetPure: [{ sheet_id: 's1', sheet_name: '主表', row_count: 2, column_count: 2 }],
      },
      sheetCsv: { s1: 'a,b\n1,2\n' },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['https://feishu.cn/sheets/objSheetPure'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].objType).toBe('sheet');
    const row = store.getDocumentByObjToken('objSheetPure');
    expect(row?.objType).toBe('sheet');
    expect(row?.customFolderId).toBe(folderId);
    const mdPath = row!.localMdPath;
    expect(fs.existsSync(mdPath)).toBe(true);
    expect(fs.readFileSync(mdPath, 'utf-8')).toContain('## 子表: 主表');
  });

  it('returns unsupported_type for a pure slides URL', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {},
      nodeGetFailUrls: new Set([
        'https://feishu.cn/slides/objSlides',
      ]),
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        links: ['https://feishu.cn/slides/objSlides'],
      }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('unsupported_type');
    expect(body.results[0].objType).toBe('slides');
  });

  it('returns permission_denied when the pure-docx fetch rejects with permission', async () => {
    const folderId = await makeFolder('Archive');
    const objToken = 'objPureLocked';
    const url = `https://feishu.cn/docx/${objToken}`;
    const larkCli = makeFakeLarkCli({
      nodes: {},
      nodeGetFailUrls: new Set([url]),
      fetchPermissionTokens: new Set([objToken]),
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: [url] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].objToken).toBe(objToken);
    expect(body.results[0].error.code).toBe('permission_denied');
  });

  it('returns parse_failed for a cloud-doc URL whose token cannot be read', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {},
      nodeGetFailUrls: new Set(['https://feishu.cn/docx/']),
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['https://feishu.cn/docx/'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('parse_failed');
  });

  it('re-adding the same pure docx URL yields already_exists', async () => {
    const folderId = await makeFolder('Archive');
    const objToken = 'objPureDup';
    const url = `https://feishu.cn/docx/${objToken}`;
    const larkCli = makeFakeLarkCli({
      nodes: {},
      nodeGetFailUrls: new Set([url]),
      docs: { [objToken]: '# Dup\n\ncontent' },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const first = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: [url] }),
    }));
    expect((await first.json()).results[0].ok).toBe(true);
    const second = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: [url] }),
    }));
    const body = await second.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('already_exists');
    expect(body.results[0].error.existingLocation).toBe('Archive');
  });
});
// ---------------------------------------------------------------------------

describe('custom-folder orphan exclusion', () => {
  it('snapshot service does not flag custom-folder files as orphans', () => {
    const kbRoot = makeTempDir('feishu-cf-orphan-');
    const { store } = newStore();

    // Create a custom folder and a doc inside it (on disk + in DB).
    store.createCustomFolder({ id: 'f1', name: 'Notes', localRelPath: '_custom/notes' });
    const relPath = '_custom/notes/page.md';
    const absPath = path.join(kbRoot, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, '<!--\nfeishu_sync:\n  obj_token: "objNote"\n-->\n\n# Page\n');
    store.setDocumentCustomFolder({
      objToken: 'objNote', folderId: 'f1', wikiNodeToken: 'nN', objType: 'docx',
      title: 'Page', localMdPath: absPath, localRelPath: relPath,
      originalLink: 'https://feishu.cn/wiki/nN', objEditTime: 1, spaceId: 's',
    });

    // A genuine orphan (no header, no mapping).
    const orphanRel = 'stray.md';
    fs.writeFileSync(path.join(kbRoot, orphanRel), 'no header here');

    const indexScanner = new IndexScanner({
      localMapStore: store,
      larkCliClient: {},
      config: { knowledgeBaseRoot: kbRoot },
    });
    const configManager = { getConfig: () => ({ knowledgeBaseRoot: kbRoot, watchedRoots: [] }) } as any;
    const snap = new SnapshotService(store, configManager, indexScanner);
    const snapshot = snap.generate(kbRoot);

    const orphanPaths = snapshot.orphan_files.map((o: any) => o.path);
    expect(orphanPaths).toContain('stray.md');
    expect(orphanPaths).not.toContain('_custom/notes/page.md');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the custom-folder archive hardening (diting review).
// ---------------------------------------------------------------------------

describe('custom-folder archive hardening (diting review fixes)', () => {
  let kbRoot: string;
  let store: LocalMapStore;

  beforeEach(() => {
    kbRoot = makeTempDir('feishu-cf-fix-');
    ({ store } = newStore());
  });

  async function makeFolder(name: string): Promise<string> {
    const a = buildApp({
      store,
      larkCli: makeFakeLarkCli({ nodes: {} }),
      knowledgeBaseRoot: kbRoot,
    });
    const res = await a.fetch(new Request('http://x/api/custom-folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }));
    return (await res.json()).folder.id;
  }

  // Major #1: downloadMedia/previewMedia arg order — an image-bearing doc must
  // actually download its media into the KB, not into a wrong cwd location.
  it('downloads doc media into the KB images dir (arg order fixed)', async () => {
    const folderId = await makeFolder('Archive');
    const imageToken = 'imgToken0123456789ab'; // >=16 chars, valid token shape
    const larkCli = makeFakeLarkCli({
      nodes: {
        u: {
          node_token: 'nImg', obj_token: 'objImg', obj_type: 'docx',
          title: 'With Image', space_id: 's', obj_edit_time: 1, has_child: false,
        },
      },
      docs: {
        objImg: `# With Image\n\n<image token="${imageToken}" name="cover.png"/>`,
      },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['u'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(true);
    // The image must land under the doc's images dir inside the KB.
    const mediaDir = path.join(kbRoot, '_custom/Archive/images');
    const files = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : [];
    expect(files.length).toBe(1);
    expect(files[0]).toContain(imageToken);
    expect(files[0]).toContain('.png');
    // The markdown body must reference the local relative path, not the token.
    const md = fs.readFileSync(path.join(kbRoot, '_custom/Archive/With Image.md'), 'utf-8');
    expect(md).toContain('images/');
    expect(md).not.toContain(`<image token="${imageToken}`);
  });

  // Major #2: same-title docs must not overwrite one file.
  it('two same-title docs get distinct files (-2 suffix) and distinct DB rows', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        a: {
          node_token: 'nA', obj_token: 'objA', obj_type: 'docx',
          title: 'Same Title', space_id: 's', obj_edit_time: 1, has_child: false,
        },
        b: {
          node_token: 'nB', obj_token: 'objB', obj_type: 'docx',
          title: 'Same Title', space_id: 's', obj_edit_time: 1, has_child: false,
        },
      },
      docs: { objA: '# Same Title\n\nA body', objB: '# Same Title\n\nB body' },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['a', 'b'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(true);
    expect(body.results[1].ok).toBe(true);

    const first = path.join(kbRoot, '_custom/Archive/Same Title.md');
    const second = path.join(kbRoot, '_custom/Archive/Same Title-2.md');
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
    expect(fs.readFileSync(first, 'utf-8')).toContain('A body');
    expect(fs.readFileSync(second, 'utf-8')).toContain('B body');

    // Two distinct DB rows, each pointing at its own file.
    const docA = store.getDocumentByObjToken('objA')!;
    const docB = store.getDocumentByObjToken('objB')!;
    expect(docA.localRelPath).toBe('_custom/Archive/Same Title.md');
    expect(docB.localRelPath).toBe('_custom/Archive/Same Title-2.md');
    expect(docA.localRelPath).not.toBe(docB.localRelPath);
  });

  // Major #3: a DB write failure rolls back the committed file.
  it('rolls back the committed file when the DB write fails', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        u: {
          node_token: 'nRb', obj_token: 'objRb', obj_type: 'docx',
          title: 'Rollback Me', space_id: 's', obj_edit_time: 1, has_child: false,
        },
      },
      docs: { objRb: '# Rollback Me\n\nbody' },
    });
    // Proxy store whose setDocumentCustomFolder always throws.
    const failingStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'setDocumentCustomFolder') {
          return () => { throw new Error('DB write boom'); };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const app = buildApp({ store: failingStore as any, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['u'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('fetch_failed');
    expect(body.results[0].error.message).toContain('已回滚');
    // The committed markdown must have been removed.
    expect(fs.existsSync(path.join(kbRoot, '_custom/Archive/Rollback Me.md'))).toBe(false);
  });

  // Major #3 (isolation): an unexpected throw on one link does not abort the batch.
  it('a sync throw on one link still returns a result for the rest', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        bad: {
          node_token: 'nBad', obj_token: 'objBad', obj_type: 'docx',
          title: 'Bad', space_id: 's', obj_edit_time: 1, has_child: false,
        },
        good: {
          node_token: 'nGood', obj_token: 'objGood', obj_type: 'docx',
          title: 'Good', space_id: 's', obj_edit_time: 1, has_child: false,
        },
      },
      docs: { objGood: '# Good\n\nbody' },
      fetchFailTokens: new Set(['objBad']),
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['bad', 'good'] }),
    }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results.length).toBe(2);
    expect(body.results[0].ok).toBe(false);
    expect(body.results[1].ok).toBe(true);
  });

  // Major #4: a 131005 on a non-Feishu host must not trigger the fetch fallback.
  it('rejects fallback for a non-feishu host (host whitelist)', async () => {
    const folderId = await makeFolder('Archive');
    const url = 'https://evil.com/docx/objEvil';
    const larkCli = makeFakeLarkCli({
      nodes: {},
      nodeGetFailUrls: new Set([url]),
      docs: { objEvil: '# Evil\n\nshould-not-be-fetched' },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: [url] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('parse_failed');
    expect(body.results[0].error.message).toContain('host');
    // No file written, no DB row.
    expect(store.getDocumentByObjToken('objEvil')).toBeNull();
  });

  // Major #4: a non-131005 error (permission) on a cloud-doc URL must surface
  // verbatim and never reach the fetch fallback.
  it('does not fall back when getNode fails with a permission error', async () => {
    const folderId = await makeFolder('Archive');
    const url = 'https://feishu.cn/docx/objPermCloud';
    const larkCli = makeFakeLarkCli({
      nodes: {},
      permissionDeniedUrls: new Set([url]),
      docs: { objPermCloud: '# would-be-archived' },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: [url] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('permission_denied');
    // Fallback would have archived it; absence proves it never ran.
    expect(store.getDocumentByObjToken('objPermCloud')).toBeNull();
  });

  // Major #5: a wiki doc archived into a custom folder leaves the structure tree.
  it('nulls wiki_node_token so the archived wiki doc leaves the structure tree', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        u: {
          node_token: 'wikiNodeXYZ', obj_token: 'objWiki', obj_type: 'docx',
          title: 'Wiki Doc', space_id: 'sp', obj_edit_time: 1, has_child: false,
        },
      },
      docs: { objWiki: '# Wiki Doc\n\nbody' },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['u'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(true);
    const doc = store.getDocumentByObjToken('objWiki')!;
    expect(doc.customFolderId).toBe(folderId);
    // Structure-tree feishu-view filters wiki_node_token IS NOT NULL; nulling
    // it removes the doc from that view (it now lives only in the custom folder).
    expect(doc.wikiNodeToken).toBeNull();
    expect(doc.watchedRootUrl).toBeNull();
    expect(doc.watchedRootId).toBeNull();
    // Provenance is preserved via the original link.
    expect(doc.originalLink).toBe('u');
  });

  // Major #5: a doc already in the structure tree is rejected with a clear hint.
  it('rejects a wiki doc already present in the structure tree', async () => {
    const folderId = await makeFolder('Archive');
    store.upsertDocument({
      objToken: 'objInTree', wikiNodeToken: 'nTree', objType: 'docx',
      title: 'In Tree', localMdPath: '/kb/tree.md', lastSyncedModifyTime: '',
      lastSyncedAt: '', status: 'synced', watchedRootId: 'root1',
    });
    const larkCli = makeFakeLarkCli({
      nodes: {
        u: {
          node_token: 'nTree', obj_token: 'objInTree', obj_type: 'docx',
          title: 'In Tree', space_id: 's', obj_edit_time: 1, has_child: false,
        },
      },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['u'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('already_exists');
    expect(body.results[0].error.existingLocation).toBe('已在同步结构树');
  });

  // Minor #8: a generic (non-LarkCliError) write error is fetch_failed, not parse_failed.
  it('classifies a generic write error as fetch_failed, not parse_failed', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        u: {
          node_token: 'nW', obj_token: 'objW', obj_type: 'docx',
          title: 'Write Err', space_id: 's', obj_edit_time: 1, has_child: false,
        },
      },
      docs: { objW: '# Write Err\n\nbody' },
    });
    // Force the KB folder path to be unwritable by making _custom/Archive a file.
    fs.mkdirSync(path.join(kbRoot, '_custom'), { recursive: true });
    fs.writeFileSync(path.join(kbRoot, '_custom/Archive'), 'i am a file not a dir');
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['u'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    // A filesystem/commit failure must not be reported as a parse problem.
    expect(body.results[0].error.code).not.toBe('parse_failed');
  });

  // Minor #7: POST/PATCH responses include docs: [] for the frontend type.
  it('POST and PATCH responses include docs: []', async () => {
    const create = await buildApp({
      store, larkCli: makeFakeLarkCli({ nodes: {} }), knowledgeBaseRoot: kbRoot,
    }).fetch(new Request('http://x/api/custom-folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'WithDocs' }),
    }));
    const createBody = await create.json();
    expect(create.status).toBe(201);
    expect(Array.isArray(createBody.folder.docs)).toBe(true);
    expect(createBody.folder.docs).toEqual([]);

    const id = createBody.folder.id;
    const patch = await buildApp({
      store, larkCli: makeFakeLarkCli({ nodes: {} }), knowledgeBaseRoot: kbRoot,
    }).fetch(new Request(`http://x/api/custom-folders/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    }));
    const patchBody = await patch.json();
    expect(patch.status).toBe(200);
    expect(Array.isArray(patchBody.folder.docs)).toBe(true);
    expect(patchBody.folder.docs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round-2 hardening: concurrency window + shared-resource rollback.
// ---------------------------------------------------------------------------

describe('custom-folder archive hardening — round 2 (concurrency & rollback)', () => {
  let kbRoot: string;
  let store: LocalMapStore;

  beforeEach(() => {
    kbRoot = makeTempDir('feishu-cf-r2-');
    ({ store } = newStore());
  });

  async function makeFolder(name: string): Promise<string> {
    const a = buildApp({
      store,
      larkCli: makeFakeLarkCli({ nodes: {} }),
      knowledgeBaseRoot: kbRoot,
    });
    const res = await a.fetch(new Request('http://x/api/custom-folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }));
    return (await res.json()).folder.id;
  }

  /**
   * Wrap makeFakeLarkCli so getNode/fetchDocumentMarkdown yield on a macrotask
   * (setTimeout 0). This forces two concurrent archive requests to interleave
   * at the await boundaries between dup-check and DB write, so the
   * serialization guarantee is tested deterministically rather than relying on
   * microtask timing.
   */
  function makeDelayedFakeLarkCli(options: FakeLarkCliOptions) {
    const base = makeFakeLarkCli(options);
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    return {
      async getNode(url: string) {
        await tick();
        return base.getNode(url);
      },
      async fetchDocumentMarkdown(objToken: string) {
        await tick();
        return base.fetchDocumentMarkdown(objToken);
      },
      downloadMedia: base.downloadMedia.bind(base),
      previewMedia: base.previewMedia.bind(base),
    };
  }

  // (a) Serialization: concurrent quick-adds of the same obj_token must land
  // exactly one archive; the second sees the row written by the first and
  // returns already_exists. Without the module-level queue the two requests
  // would both pass the dup-check (the macrotask delays force the overlap) and
  // both report ok.
  it('serializes concurrent same-obj_token quick-adds (only one lands)', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeDelayedFakeLarkCli({
      nodes: {
        u: {
          node_token: 'nC', obj_token: 'objConcurrent', obj_type: 'docx',
          title: 'Concurrent', space_id: 's', obj_edit_time: 1, has_child: false,
        },
      },
      docs: { objConcurrent: '# Concurrent\n\nbody' },
    });
    const app = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const [r1, r2] = await Promise.all([
      app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ links: ['u'] }),
      })),
      app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ links: ['u'] }),
      })),
    ]);
    const b1 = await r1.json();
    const b2 = await r2.json();
    const oks = [b1.results[0], b2.results[0]].filter((r: any) => r.ok).length;
    const already = [b1.results[0], b2.results[0]].filter(
      (r: any) => r.error?.code === 'already_exists',
    ).length;
    expect(oks).toBe(1);
    expect(already).toBe(1);
    // Exactly one mapping row, and it is the archived contract.
    const doc = store.getDocumentByObjToken('objConcurrent')!;
    expect(doc.customFolderId).toBe(folderId);
  });

  // (b) Ownership guard (unit): setDocumentCustomFolder returns applied=false
  // and leaves the row untouched when the obj_token already exists as a
  // structure-tree member — the unconditional upsert must never null
  // watched_root_id / wiki_node_token.
  it('setDocumentCustomFolder refuses (applied=false) a structure-tree member', () => {
    store.createCustomFolder({ id: 'f1', name: 'F', localRelPath: '_custom/f' });
    // Seed a structure-tree doc: watched_root_id + wiki_node_token both set.
    store.upsertDocument({
      objToken: 'objTree', wikiNodeToken: 'nTree', objType: 'docx',
      title: 'Tree', localMdPath: '/kb/tree.md', lastSyncedModifyTime: '',
      lastSyncedAt: '', status: 'synced', watchedRootId: 'root1',
    });
    const before = store.getDocumentByObjToken('objTree')!;
    expect(before.watchedRootId).toBe('root1');
    expect(before.wikiNodeToken).toBe('nTree');

    const result = store.setDocumentCustomFolder({
      objToken: 'objTree', folderId: 'f1', wikiNodeToken: null, objType: 'docx',
      title: 'Tree', localMdPath: '/kb/_custom/f/tree.md',
      localRelPath: '_custom/f/tree.md', originalLink: null, objEditTime: null, spaceId: null,
    });
    expect(result.applied).toBe(false);
    // Row untouched: still a structure-tree member, NOT linked to the folder.
    const after = store.getDocumentByObjToken('objTree')!;
    expect(after.watchedRootId).toBe('root1');
    expect(after.wikiNodeToken).toBe('nTree');
    expect(after.customFolderId).toBeNull();
    store.close();
  });

  // (b) Ownership guard (integration race): the structure-sync engine inserts
  // the doc into the tree between the route's dup-check and its DB write. The
  // archive is refused (already_exists) and the just-committed files are rolled
  // back via the atomic-commit plan.
  it('race: doc enters structure tree mid-archive → already_exists + rollback', async () => {
    const folderId = await makeFolder('Archive');
    const larkCli = makeFakeLarkCli({
      nodes: {
        u: {
          node_token: 'nRace', obj_token: 'objRace', obj_type: 'docx',
          title: 'Race', space_id: 's', obj_edit_time: 1, has_child: false,
        },
      },
      docs: { objRace: '# Race\n\nbody' },
    });
    // Proxy that simulates the sync engine inserting a structure-tree row for
    // the obj_token just before the route's setDocumentCustomFolder runs.
    const racingStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'setDocumentCustomFolder') {
          return (input: any) => {
            target.upsertDocument({
              objToken: input.objToken, wikiNodeToken: 'nRace', objType: 'docx',
              title: input.title, localMdPath: '/kb/tree.md', lastSyncedModifyTime: '',
              lastSyncedAt: '', status: 'synced', watchedRootId: 'root1',
            });
            return target.setDocumentCustomFolder(input);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const app = buildApp({ store: racingStore as any, larkCli, knowledgeBaseRoot: kbRoot });
    const res = await app.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['u'] }),
    }));
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error.code).toBe('already_exists');
    expect(body.results[0].error.existingLocation).toBe('已在同步结构树');
    // The committed file must have been rolled back (create → deleted).
    expect(fs.existsSync(path.join(kbRoot, '_custom/Archive/Race.md'))).toBe(false);
    // The doc remains a structure-tree member (not archived, not folder-linked).
    const doc = store.getDocumentByObjToken('objRace')!;
    expect(doc.watchedRootId).toBe('root1');
    expect(doc.wikiNodeToken).toBe('nRace');
    expect(doc.customFolderId).toBeNull();
  });

  // (c) Snapshot rollback of shared media: when a DB write fails after the
  // commit overwrote a shared images/ file owned by another doc, the rollback
  // must RESTORE the prior bytes (rollbackAtomicPlan) rather than blind-delete
  // the file (which would destroy the version the other doc references).
  it('DB failure restores an overwritten shared media file to prior bytes', async () => {
    const folderId = await makeFolder('Archive');
    const sharedImageToken = 'imgShared01234567'; // >=16 chars
    // downloadMedia writes distinct content per call so the restore is observable.
    let mediaCallCount = 0;
    const base = makeFakeLarkCli({
      nodes: {
        a: {
          node_token: 'nA', obj_token: 'objA', obj_type: 'docx',
          title: 'Doc A', space_id: 's', obj_edit_time: 1, has_child: false,
        },
        b: {
          node_token: 'nB', obj_token: 'objB', obj_type: 'docx',
          title: 'Doc B', space_id: 's', obj_edit_time: 1, has_child: false,
        },
      },
      docs: {
        objA: `# Doc A\n\n<image token="${sharedImageToken}" name="a.png"/>`,
        objB: `# Doc B\n\n<image token="${sharedImageToken}" name="b.png"/>`,
      },
    });
    const larkCli = {
      ...base,
      async downloadMedia(token: string, outputPath: string) {
        mediaCallCount += 1;
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const target = `${outputPath}.png`;
        fs.writeFileSync(target, `image-call-${mediaCallCount}-${token}`);
        return target;
      },
    };
    const sharedPath = path.join(kbRoot, '_custom/Archive/images', `01-${sharedImageToken}.png`);

    // 1. Archive Doc A (with the shared image) successfully.
    const appA = buildApp({ store, larkCli, knowledgeBaseRoot: kbRoot });
    const resA = await appA.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['a'] }),
    }));
    expect((await resA.json()).results[0].ok).toBe(true);
    expect(fs.existsSync(sharedPath)).toBe(true);
    const docABytes = fs.readFileSync(sharedPath, 'utf-8');
    // Doc A's image is the first download call.
    expect(docABytes).toContain('image-call-1');

    // 2. Archive Doc B (same image token) but make its DB write fail.
    const failingForB = new Proxy(store, {
      get(target, prop) {
        if (prop === 'setDocumentCustomFolder') {
          return (input: any) => {
            if (input.objToken === 'objB') throw new Error('DB write boom');
            return target.setDocumentCustomFolder(input);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const appB = buildApp({ store: failingForB as any, larkCli, knowledgeBaseRoot: kbRoot });
    const resB = await appB.fetch(new Request(`http://x/api/custom-folders/${folderId}/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ links: ['b'] }),
    }));
    const bodyB = await resB.json();
    expect(bodyB.results[0].ok).toBe(false);
    expect(bodyB.results[0].error.code).toBe('fetch_failed');
    expect(bodyB.results[0].error.message).toContain('已回滚');

    // 3. The shared image file must still exist and hold Doc A's prior bytes —
    //    restored from the rollback snapshot, not blind-deleted nor overwritten.
    expect(fs.existsSync(sharedPath)).toBe(true);
    expect(fs.readFileSync(sharedPath, 'utf-8')).toBe(docABytes);
    // Doc B's markdown was a fresh create → removed by the rollback.
    expect(fs.existsSync(path.join(kbRoot, '_custom/Archive/Doc B.md'))).toBe(false);
    // Doc A's row is intact.
    expect(store.getDocumentByObjToken('objA')!.customFolderId).toBe(folderId);
    // Doc B was never recorded.
    expect(store.getDocumentByObjToken('objB')).toBeNull();
  });
});
