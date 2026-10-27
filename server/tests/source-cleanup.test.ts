import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import { IndexScanner } from '../src/modules/index-scanner.js';
import { SnapshotService } from '../src/modules/snapshot-service.js';
import { MappingService } from '../src/modules/mapping-service.js';
import { reconcileLocalIndex } from '../src/modules/local-index-reconcile.js';
import { cleanupSources } from '../src/kb/source-cleanup.js';
import { kbRoutes } from '../src/routes/kb.js';
import type { DocumentRecord } from '../src/types/index.js';

const fixtures: Array<{ root: string; store: LocalMapStore }> = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { f.store.close(); fs.rmSync(f.root, { recursive: true, force: true }); } });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-cleanup-'));
  const raw = path.join(root, 'raw'); fs.mkdirSync(path.join(raw, '章节'), { recursive: true });
  const store = new LocalMapStore(path.join(root, 'db.sqlite')); store.initialize(); fixtures.push({ root, store });
  const config = new ConfigManager(path.join(root, 'config.json')); await config.load();
  await config.updateConfig({ knowledgeBaseRoot: raw, standardKb: { outputRoot: path.join(root, 'standard') } } as never);
  const docs: DocumentRecord[] = ['a', 'b', 'sheet'].map((token) => ({ objToken: token, title: token, wikiNodeToken: `wiki-${token}`, parentNodeToken: token === 'b' ? 'wiki-a' : null,
    objType: token === 'sheet' ? 'sheet' : 'docx', localRelPath: `章节/${token}.md`, localMdPath: path.join(raw, `章节/${token}.md`), lastSyncedAt: '2026-10-01T00:00:00Z', lastSyncedModifyTime: '100', status: 'synced' }));
  for (const doc of docs) { fs.writeFileSync(doc.localMdPath!, `<!--\nfeishu_sync:\n  obj_token: ${doc.objToken}\n  obj_type: ${doc.objType}\n-->\n# 当前规则\n这是完整正文。`); store.upsertDocument(doc); }
  const csv = path.join(raw, '章节', 'sheet.csv-data', '页.csv'); fs.mkdirSync(path.dirname(csv)); fs.writeFileSync(csv, '规则,数值\n费用,10');
  store.upsertSheetSheet({ sheetObjToken: 'sheet', sheetId: 'tab', sheetTitle: '页', localCsvPath: csv, status: 'synced' });
  const snapshot = new SnapshotService(store, config, { larkCliClient: {}, config: config.getConfig() }); snapshot.generate();
  let running = false;
  const app = new Hono(); app.route('/', kbRoutes({ localMapStore: store, configManager: config, buildService: { activeBuild: () => running ? {} : null } as never,
    documentsProvider: () => { reconcileLocalIndex(store, raw, () => snapshot.generate()); return store.getAllDocuments(); }, sheetCsvPaths: (token) => store.getSheetSheets(token).map((s) => s.local_csv_path) }));
  const call = async (url: string, body?: unknown) => { const response = await app.request(url, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() as any }; };
  return { root, raw, store, docs, csv, config, snapshot, call, running: () => { running = true; } };
}
const sources = (docs: DocumentRecord[]) => docs.map(({ objToken, localRelPath }) => ({ objToken, relPath: localRelPath! }));

describe('磁盘删除与本地索引校正', () => {
  it('文件夹手动删除后，读取树即可清理文档、表格子索引和目录映射并刷新快照', async () => {
    const f = await fixture(); f.store.upsertLocalDir({ localPath: '章节', title: '章节' });
    fs.rmSync(path.join(f.raw, '章节'), { recursive: true });
    const mapping = new MappingService({} as never, f.store, f.snapshot, f.config);
    const tree = mapping.getTreeDetailed({ view: 'local' });
    expect(tree.nodes).toEqual([]); expect(f.store.getAllDocuments()).toEqual([]);
    expect(f.store.getSheetSheets('sheet')).toEqual([]); expect(f.store.getAllLocalDirs()).toEqual([]);
    expect(f.snapshot.readExisting(f.raw)?.nodes).toEqual([]);
    expect((await f.call('/api/kb/sources/tree')).data.total).toBe(0);
    expect(f.store.pruneMissingLocalDocs(f.raw).pruned).toBe(0);
  });
  it('兼容仅有旧绝对路径的记录；保留未落盘云端身份、回收站与外库记录', async () => {
    const f = await fixture();
    const legacy = { ...f.docs[0], objToken: 'legacy', localMdPath: path.join(f.raw, '旧文档.md'), localRelPath: null };
    f.store.upsertDocument(legacy);
    f.store.upsertDocument({ ...f.docs[0], objToken: 'pending', localRelPath: '待下载.md', localMdPath: path.join(f.raw, '待下载.md'), status: 'placeholder', lastSyncedAt: '', syncState: 'pending_added' });
    f.store.upsertDocument({ ...f.docs[0], objToken: 'trash', cloudDeleted: 1, localRelPath: '已回收.md', localMdPath: path.join(f.raw, '已回收.md') });
    f.store.upsertDocument({ ...f.docs[0], objToken: 'other', localRelPath: '别库.md', localMdPath: path.join(f.root, '另一知识库', '别库.md') });
    const stats = f.store.pruneMissingLocalDocs(f.raw); expect(stats.prunedTokens).toEqual(['legacy']);
    for (const token of ['pending', 'trash', 'other']) expect(f.store.getDocumentByObjToken(token)).toBeTruthy();
    expect(f.store.pruneMissingLocalDocs(path.join(f.root, '离线库')).pruned).toBe(0);
  });
  it('清理历史遗留的孤立表格索引；权限错误不能成为整库删除证据', async () => {
    const f = await fixture(); f.store.deleteDocumentByToken('sheet');
    (f.store as any).db.pragma('foreign_keys = OFF'); // 复现旧库在未启用FK时留下的孤立行。
    f.store.upsertSheetSheet({ sheetObjToken: 'gone', sheetId: 'tab', sheetTitle: '孤立', localCsvPath: f.csv, status: 'synced' });
    expect(f.store.pruneMissingLocalDocs(f.raw).prunedSheets).toBe(1);
    const original = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((target: unknown, ...args: unknown[]) => {
      if (String(target).endsWith('a.md')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return (original as (...args: any[]) => any)(target, ...args);
    }) as typeof fs.statSync);
    expect(f.store.pruneMissingLocalDocs(f.raw).pruned).toBe(0);
  });
  it('子目录扫描不按错误的相对根清除其他目录或新建的文档', async () => {
    const f = await fixture(); f.store.upsertLocalDir({ localPath: '章节' });
    const scanner = new IndexScanner({ localMapStore: f.store, larkCliClient: {}, config: f.config.getConfig() });
    await scanner.scanKnowledgeBase(path.join(f.raw, '章节'));
    expect(f.store.getAllDocuments()).toHaveLength(3); expect(f.store.getAllLocalDirs()).toHaveLength(1);
  });
});

describe('工具内指定源清理', () => {
  it('清单确认后批量回收md/表格CSV，并清除索引；未选文档字节与索引保持', async () => {
    const f = await fixture(); const before = fs.readFileSync(f.docs[1].localMdPath!, 'utf8');
    const response = await f.call('/api/kb/sources/cleanup', { root: f.raw, sources: sources([f.docs[0], f.docs[2]]), confirm: 'CLEANUP' });
    expect(response.status).toBe(200); expect(response.data).toMatchObject({ cleaned: 2, movedFiles: 3 });
    expect(fs.existsSync(f.docs[0].localMdPath!)).toBe(false); expect(fs.existsSync(f.csv)).toBe(false);
    expect(f.store.getSheetSheets('sheet')).toEqual([]); expect(f.store.getAllDocuments().map((d) => d.objToken)).toEqual(['b']);
    expect(fs.readFileSync(f.docs[1].localMdPath!, 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(response.data.trashDir, 'files', '章节/sheet.csv-data/页.csv'), 'utf8')).toContain('费用,10');
    expect(JSON.parse(fs.readFileSync(path.join(response.data.trashDir, 'cleanup.json'), 'utf8')).documents).toHaveLength(2);
    expect(f.snapshot.readExisting(f.raw)?.nodes.map((n) => n.obj_token)).toEqual(['b']);
    expect((await f.call('/api/kb/sources/tree')).data.total).toBe(1);
  });
  it('无确认、库切换、过期路径和构建中均整批拒绝', async () => {
    const f = await fixture(); const body = { root: f.raw, sources: sources(f.docs), confirm: 'CLEANUP' };
    expect((await f.call('/api/kb/sources/cleanup', { ...body, confirm: '' })).status).toBe(400);
    expect((await f.call('/api/kb/sources/cleanup', { ...body, root: 'old' })).status).toBe(409);
    expect((await f.call('/api/kb/sources/cleanup', { ...body, sources: [{ objToken: 'a', relPath: '旧路径.md' }] })).status).toBe(409);
    f.running(); expect((await f.call('/api/kb/sources/cleanup', body)).status).toBe(409);
    expect(f.store.getAllDocuments()).toHaveLength(3); expect(fs.existsSync(f.docs[0].localMdPath!)).toBe(true);
  });
  it('重复正文路径和共用CSV映射不能误伤未选中的源', async () => {
    const f = await fixture();
    f.store.upsertDocument({ ...f.docs[0], objToken: 'duplicate' });
    expect(() => cleanupSources(f.store, f.raw, sources([f.docs[0]]))).toThrow('共用');
    expect(fs.existsSync(f.docs[0].localMdPath!)).toBe(true);
    f.store.upsertSheetSheet({ sheetObjToken: 'a', sheetId: 'shared', sheetTitle: '共享', localCsvPath: f.csv, status: 'synced' });
    // a按工作簿保存，模拟历史CSV重复映射。
    f.store.upsertDocument({ ...f.docs[0], objType: 'sheet' });
    expect(() => cleanupSources(f.store, f.raw, sources([f.docs[2]]))).toThrow('共用');
    expect(fs.existsSync(f.csv)).toBe(true);
  });
  it('移动失败/数据库失败回滚文件和索引，不误报清理成功', async () => {
    const f = await fixture(); const original = fs.renameSync; let moves = 0;
    const fault = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (++moves === 2) throw new Error('fixture rename failure'); return original(from, to); });
    expect(() => cleanupSources(f.store, f.raw, sources(f.docs))).toThrow('fixture rename failure'); fault.mockRestore();
    expect(f.store.getAllDocuments()).toHaveLength(3); for (const doc of f.docs) expect(fs.existsSync(doc.localMdPath!)).toBe(true);
    vi.spyOn(f.store, 'deleteDocumentsByTokens').mockImplementation(() => { throw new Error('fixture db failure'); });
    expect(() => cleanupSources(f.store, f.raw, sources(f.docs))).toThrow('fixture db failure');
    expect(f.store.getAllDocuments()).toHaveLength(3); for (const doc of f.docs) expect(fs.existsSync(doc.localMdPath!)).toBe(true);
    expect(fs.existsSync(f.csv)).toBe(true);
  });
  it('已缺失的CSV不阻止回收主文档；逃逸链接不能移动库外文件', async () => {
    const f = await fixture(); fs.rmSync(path.dirname(f.csv), { recursive: true });
    expect(cleanupSources(f.store, f.raw, sources([f.docs[2]])).cleaned).toBe(1);
    const outside = path.join(f.root, '库外.md'); fs.writeFileSync(outside, '保留'); fs.unlinkSync(f.docs[0].localMdPath!); fs.symlinkSync(outside, f.docs[0].localMdPath!);
    expect(() => cleanupSources(f.store, f.raw, sources([f.docs[0]]))).toThrow();
    expect(fs.readFileSync(outside, 'utf8')).toBe('保留'); expect(f.store.getDocumentByObjToken('a')).toBeTruthy();
  });
});
