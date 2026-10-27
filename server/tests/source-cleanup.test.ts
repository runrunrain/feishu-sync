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
import { trashRoutes } from '../src/routes/trash.js';
import { syncRoutes } from '../src/routes/sync.js';
import { ChangeDetector } from '../src/modules/change-detector.js';
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
  const app = new Hono(); app.use('*', async (c, next) => { (c as any).configManager = config; (c as any).localMapStore = store; (c as any).larkCliClient = {}; (c as any).kbBuildService = { activeBuild: () => running ? {} : null }; await next(); }); app.route('/', trashRoutes); app.route('/', syncRoutes); app.route('/', kbRoutes({ localMapStore: store, configManager: config, buildService: { activeBuild: () => running ? {} : null } as never,
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


describe('侧栏删除、有效父级待同步和屏蔽名单', () => {
  async function managedFixture() {
    const f = await fixture();
    const watched = { id: 'ContextRoot12345', url: 'https://tenant.feishu.cn/wiki/ContextRoot12345', localDir: '章节', layoutProfile: 'mirror-title-file', enabled: true };
    await f.config.updateConfig({ watchedRoots: [watched] } as never);
    f.store.upsertDocument({ ...f.docs[0], wikiNodeToken: watched.id });
    f.store.upsertDocument({ ...f.docs[1], parentNodeToken: watched.id });
    f.store.upsertDocument({ ...f.docs[2], parentNodeToken: watched.id });
    return { ...f, watched };
  }
  it('删除文件后保留有效父链并立即进入cached diff；重复观测与重建索引不能洗掉待同步', async () => {
    const f = await managedFixture(); const beforeParent = fs.readFileSync(f.docs[0].localMdPath!, 'utf8');
    const response = await f.call('/api/trash/manual-delete', { obj_token: 'b' });
    expect(response.status).toBe(200); expect(response.data).toMatchObject({ pending_sync: true, blocked: false, file_moved_to_trash: true });
    expect(f.store.getDocumentByObjToken('b')).toMatchObject({ parentNodeToken: 'ContextRoot12345', wikiNodeToken: 'wiki-b', syncState: 'pending_added', localMdPath: '', localRelPath: null, syncedObjEditTime: null, lastSyncedAt: '' });
    const mapping = new MappingService({} as never, f.store, f.snapshot, f.config);
    expect(mapping.getStoredDiff(f.watched.url).added.map((d) => d.objToken)).toContain('b');
    f.store.recordCloudObservation({ objToken: 'b', wikiNodeToken: 'wiki-b', parentNodeToken: 'ContextRoot12345', title: 'b', objType: 'docx', watchedRootId: f.watched.id, watchedRootUrl: f.watched.url, observationStatus: 'available', observedObjEditTime: 100, hasChild: false, lastSeenAt: new Date().toISOString() });
    await new IndexScanner({ localMapStore: f.store, larkCliClient: {}, config: f.config.getConfig() }).scanKnowledgeBase(f.raw);
    expect(f.store.getDocumentByObjToken('b')?.syncState).toBe('pending_added');
    expect(fs.readFileSync(f.docs[0].localMdPath!, 'utf8')).toBe(beforeParent);
    expect(mapping.getTreeDetailed().nodes.find((n) => n.obj_token === 'b')).toMatchObject({ sync_state: 'pending_added', sync_blocked: false });
  });
  it('上级失效、未纳管或循环时清除节点；可选择仅删索引而保留文件', async () => {
    const f = await managedFixture();
    await f.config.updateConfig({ watchedRoots: [{ ...f.watched, enabled: false }] } as never);
    expect((await f.call('/api/trash/manual-delete', { obj_token: 'b', delete_local_files: false })).data.pending_sync).toBe(false);
    expect(f.store.getDocumentByObjToken('b')).toBeNull(); expect(fs.existsSync(f.docs[1].localMdPath!)).toBe(true);
    f.store.upsertDocument({ ...f.docs[1], parentNodeToken: f.watched.id });
    await f.config.updateConfig({ watchedRoots: [f.watched] } as never);
    f.store.markCloudDeleted('a', new Date().toISOString());
    expect((await f.call('/api/trash/manual-delete', { obj_token: 'b' })).data.pending_sync).toBe(false);
    expect(f.store.getDocumentByObjToken('b')).toBeNull();
  });
  it('删除提交失败回滚本地文件，不留下屏蔽或已完成状态', async () => {
    const f = await managedFixture();
    vi.spyOn(f.store, 'clearLocalDocument').mockImplementation(() => { throw new Error('fixture metadata failure'); });
    expect((await f.call('/api/trash/manual-delete', { obj_token: 'b', block: true })).status).toBe(500);
    expect(fs.existsSync(f.docs[1].localMdPath!)).toBe(true); expect(f.store.getDocumentByObjToken('b')?.localMdPath).toBe(f.docs[1].localMdPath);
    expect(f.store.listSyncBlockedSources(f.raw)).toEqual([]);
  });
  it('屏蔽过滤当前差异/新检测/已缓存结果，阻止旧同步请求，多选移出后恢复且按原始库隔离', async () => {
    const f = await managedFixture();
    const detector = new ChangeDetector({} as never, f.store, { knowledgeBaseRoot: f.raw, mediaGap: { enabled: false } });
    const cloud = f.store.getAllDocuments().map((doc) => ({ objToken: doc.objToken, wikiNodeToken: doc.wikiNodeToken!, objType: doc.objType, title: doc.title, parentNodeToken: doc.parentNodeToken, watchedRootId: f.watched.id, watchedRootUrl: f.watched.url, observationStatus: 'available', observedObjEditTime: 100, hasChild: doc.objToken === 'a' }));
    const query = vi.spyOn(detector as any, 'detectChangesUncached').mockImplementation(async () => {
      const changedDocuments = await (detector as any).compareWithLocalRecords(cloud, { rootToken: f.watched.id, watchedRootUrl: f.watched.url, traversalComplete: true });
      return { changed: changedDocuments.length > 0, changedDocuments, checkedAt: 'fixture', totalNodes: 3 };
    });
    await detector.detectChanges(f.watched.url);
    for (const token of ['b','sheet']) expect((await f.call('/api/trash/manual-delete', { obj_token: token, block: true })).data).toMatchObject({ blocked: true, pending_sync: false });
    const mapping = new MappingService({} as never, f.store, f.snapshot, f.config);
    expect(mapping.getStoredDiff(f.watched.url).added.some((doc) => ['b','sheet'].includes(doc.objToken))).toBe(false);
    expect((await detector.detectChanges(f.watched.url)).changedDocuments.some((doc) => ['b','sheet'].includes(doc.objToken))).toBe(false); expect(query).toHaveBeenCalledOnce();
    expect((await detector.detectChanges(f.watched.url, { forceFresh: true, bypassCooldown: true })).changedDocuments.some((doc) => ['b','sheet'].includes(doc.objToken))).toBe(false);
    expect((await f.call('/api/sync', { documents: [{ objToken: 'b' }], options: {} })).status).toBe(409);
    const blocklist = await f.call('/api/sync/blocklist'); expect(blocklist.data.items).toHaveLength(2);
    expect(f.store.listSyncBlockedSources(path.join(f.root, '其他库'))).toEqual([]);
    expect((await f.call('/api/sync/blocklist/remove', { root: 'old', tokens: ['b','sheet'] })).status).toBe(409);
    expect((await f.call('/api/sync/blocklist/remove', { root: f.raw, tokens: ['b','sheet'] })).data.removed).toBe(2);
    expect(mapping.getStoredDiff(f.watched.url).added.map((d) => d.objToken)).toEqual(expect.arrayContaining(['b','sheet']));
    expect(f.store.listSyncBlockedSources(f.raw)).toEqual([]);
  });
  describe('多选批量确认与执行', () => {
    const request = (root: string, tokens: string[], action: 'delete' | 'block' = 'delete', extra = {}) => ({ root, tokens, action, includeDescendants: false, deleteFiles: action === 'delete', block: action === 'block', ...extra });
    it('父级补全子文档去重；包含同步根本身时清单按最终父链判定移除，预览不改文件/DB', async () => {
      const f = await managedFixture(); const before = f.store.getAllDocuments();
      const result = await f.call('/api/trash/source-batch/preview', request(f.raw, ['a','b'], 'delete', { includeDescendants: true }));
      expect(result.status).toBe(200); expect(result.data.items).toHaveLength(3); expect(result.data).toMatchObject({ directCount: 2, descendantCount: 1 });
      expect(result.data.items.every((item: any) => item.effect === 'removed')).toBe(true); expect(result.data.files).toHaveLength(4);
      expect(f.store.getAllDocuments()).toEqual(before); expect(f.store.listSyncBlockedSources(f.raw)).toEqual([]);
      for (const doc of f.docs) expect(fs.existsSync(doc.localMdPath!)).toBe(true);
    });
    it('批量删除使用一次文件回收与元数据事务，未选父文档和其字节保持', async () => {
      const f = await managedFixture(); const body = request(f.raw, ['b','sheet']);
      const preview = await f.call('/api/trash/source-batch/preview', body);
      expect(preview.data.items.map((item: any) => item.effect)).toEqual(['pending','pending']);
      const response = await f.call('/api/trash/source-batch/apply', { ...body, confirm: 'APPLY', expectedRevision: preview.data.revision });
      expect(response.status).toBe(200); expect(response.data).toMatchObject({ processed: 2, movedFiles: 3, pending: 2, blocked: 0 });
      expect(f.store.getDocumentByObjToken('b')).toMatchObject({ syncState: 'pending_added', localMdPath: '' });
      expect(f.store.getDocumentByObjToken('sheet')).toMatchObject({ syncState: 'pending_added', localMdPath: '' });
      expect(f.store.getSheetSheets('sheet')).toEqual([]); expect(fs.existsSync(f.docs[0].localMdPath!)).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(response.data.trashDir,'cleanup.json'),'utf8')).documents).toHaveLength(2);
    });
    it('只屏蔽保留文件、表格子索引和成功基线；多篇原子加入名单', async () => {
      const f = await managedFixture(); const before = f.store.getAllDocuments(); const csv = fs.readFileSync(f.csv,'utf8');
      const body = request(f.raw, ['b','sheet'], 'block'); const preview = await f.call('/api/trash/source-batch/preview', body);
      expect(preview.data.files).toEqual([]); expect(preview.data.affectedStandardDocs).toEqual([]);
      expect((await f.call('/api/trash/source-batch/apply', { ...body, confirm: 'APPLY', expectedRevision: preview.data.revision })).data).toMatchObject({ processed: 2, blocked: 2, movedFiles: 0 });
      expect(f.store.getAllDocuments()).toEqual(before); expect(fs.readFileSync(f.csv,'utf8')).toBe(csv); expect(f.store.getSheetSheets('sheet')).toHaveLength(1);
      expect(f.store.listSyncBlockedSources(f.raw)).toHaveLength(2);
    });
    it('确认缺失、过期revision、库切换或未知标识整批拒绝', async () => {
      const f = await managedFixture(); const body = request(f.raw,['b','sheet']); const preview = await f.call('/api/trash/source-batch/preview',body);
      expect((await f.call('/api/trash/source-batch/apply', { ...body, expectedRevision: preview.data.revision })).status).toBe(400);
      expect((await f.call('/api/trash/source-batch/apply', { ...body, confirm: 'APPLY', expectedRevision: 'stale' })).status).toBe(409);
      expect((await f.call('/api/trash/source-batch/preview', request('old-root',['b']))).status).toBe(409);
      expect((await f.call('/api/trash/source-batch/preview', request(f.raw,['b','missing']))).status).toBe(409);
      for (const doc of f.docs) expect(fs.existsSync(doc.localMdPath!)).toBe(true);
    });
    it('预览后文件内容或新增下级改变时拒绝执行，不能按旧清单删除', async () => {
      const f = await managedFixture(); const body = request(f.raw,['b']); const preview = await f.call('/api/trash/source-batch/preview',body);
      fs.appendFileSync(f.docs[1].localMdPath!, '\n新的有效内容');
      expect((await f.call('/api/trash/source-batch/apply', { ...body, confirm: 'APPLY', expectedRevision: preview.data.revision })).status).toBe(409);
      const fresh = await f.call('/api/trash/source-batch/preview',body);
      f.store.upsertDocument({ ...f.docs[2], objToken: 'new-child', parentNodeToken: 'wiki-b' });
      expect((await f.call('/api/trash/source-batch/apply', { ...body, confirm: 'APPLY', expectedRevision: fresh.data.revision })).status).toBe(409);
      expect(fs.existsSync(f.docs[1].localMdPath!)).toBe(true);
    });
    it('仅更新观测时间不会使已确认的相同处理范围无故过期', async () => {
      const f = await managedFixture(); const body = request(f.raw,['b']); const preview = await f.call('/api/trash/source-batch/preview',body);
      (f.store as any).db.prepare('UPDATE documents SET last_seen_at=? WHERE obj_token=?').run(new Date().toISOString(),'b');
      expect((await f.call('/api/trash/source-batch/apply', { ...body, confirm: 'APPLY', expectedRevision: preview.data.revision })).status).toBe(200);
    });
    it('元数据第二项失败回滚所有文件与首项的屏蔽/基线修改', async () => {
      const f = await managedFixture(); const before = f.store.getAllDocuments(); const body = request(f.raw,['b','sheet'],'delete',{block:true});
      const preview = await f.call('/api/trash/source-batch/preview',body); const original = f.store.clearLocalDocument.bind(f.store); let count = 0;
      vi.spyOn(f.store, 'clearLocalDocument').mockImplementation((...args) => { if (++count === 2) throw new Error('batch second commit failure'); original(...args); });
      expect((await f.call('/api/trash/source-batch/apply', { ...body, confirm: 'APPLY', expectedRevision: preview.data.revision })).status).toBe(500);
      expect(f.store.getAllDocuments()).toEqual(before); expect(f.store.listSyncBlockedSources(f.raw)).toEqual([]);
      for (const doc of f.docs) expect(fs.existsSync(doc.localMdPath!)).toBe(true); expect(fs.existsSync(f.csv)).toBe(true);
    });
    it('构建中不允许批量删除，仍可只屏蔽且保持原文', async () => {
      const f = await managedFixture(); const body = request(f.raw,['b']); const preview = await f.call('/api/trash/source-batch/preview',body); f.running();
      expect((await f.call('/api/trash/source-batch/apply', { ...body, confirm: 'APPLY', expectedRevision: preview.data.revision })).status).toBe(409);
      const blockBody = request(f.raw,['b'],'block'); const blockPreview = await f.call('/api/trash/source-batch/preview',blockBody);
      expect((await f.call('/api/trash/source-batch/apply', { ...blockBody, confirm: 'APPLY', expectedRevision: blockPreview.data.revision })).status).toBe(200);
      expect(fs.existsSync(f.docs[1].localMdPath!)).toBe(true);
    });
  });

});
