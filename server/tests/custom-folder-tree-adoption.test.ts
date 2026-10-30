import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { ChangeDetector } from '../src/modules/change-detector.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { MappingService } from '../src/modules/mapping-service.js';
import { SnapshotService } from '../src/modules/snapshot-service.js';
import { createOperationManifest } from '../src/modules/operation-manifest.js';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { IndexScanner } from '../src/modules/index-scanner.js';
import { detectRoutes } from '../src/routes/detect.js';
import type { ChangedDocument, DocumentRecord } from '../src/types/index.js';

const fixtures: Array<{ dir: string; store: LocalMapStore }> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

async function fixture(options: { oldRootFields?: boolean; differentWiki?: boolean; redirectWiki?: boolean; incomplete?: boolean; changed?: boolean; phantomParent?: boolean; unconfiguredRoot?: boolean; duplicateWiki?: 'first' | 'last' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tree-'));
  const root = path.join(dir, 'raw'); fs.mkdirSync(root);
  const store = new LocalMapStore(path.join(dir, 'data.sqlite')); store.initialize(); fixtures.push({ dir, store });
  const config = new ConfigManager(path.join(dir, 'config.json')); await config.load();
  const watched = { id: 'rootToken', url: 'https://test.feishu.cn/wiki/rootToken', localDir: '主知识库', layoutProfile: 'mirror-title-file' as const, enabled: true };
  await config.updateConfig({ knowledgeBaseRoot: root, watchedRoots: [watched] } as never);
  const oldRel = '_custom/归档/旧文档.md'; const file = path.join(root, oldRel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = '<!--\nfeishu_sync:\n  obj_token: "docObject"\n  wiki_node_token: "docNode"\n-->\n# 旧文档\n原始正文\n';
  fs.writeFileSync(file, bytes);
  store.createCustomFolder({ id: 'archive', name: '归档', localRelPath: '_custom/归档' });
  store.setDocumentCustomFolder({ objToken: 'docObject', folderId: 'archive', wikiNodeToken: null, objType: 'docx', title: '旧文档',
    localMdPath: file, localRelPath: oldRel, originalLink: 'https://test.feishu.cn/wiki/docNode', objEditTime: 100, spaceId: 'space' });
  const nodes = {
    rootToken: { node_token: 'rootToken', obj_token: 'rootObject', obj_type: 'docx', title: '主知识库', parent_node_token: null, has_child: true, space_id: 'space', obj_edit_time: 100 },
    parentNode: { node_token: 'parentNode', obj_token: 'parentObject', obj_type: 'docx', title: '父文档', parent_node_token: 'rootToken', has_child: true, space_id: 'space', obj_edit_time: 100 },
    docNode: { node_token: options.differentWiki ? 'shortcutNode' : 'docNode', obj_token: 'docObject', obj_type: 'docx', title: '旧文档', parent_node_token: options.phantomParent ? 'phantomNode' : 'parentNode', has_child: false, space_id: 'space', obj_edit_time: options.changed ? 200 : 100 },
  };
  for (const node of [nodes.rootToken, nodes.parentNode]) {
    const rel = `主知识库/${node.node_token}.md`; const localPath = path.join(root, rel); fs.mkdirSync(path.dirname(localPath), { recursive: true }); fs.writeFileSync(localPath, '# baseline');
    store.upsertDocument({ objToken: node.obj_token, wikiNodeToken: node.node_token, objType: 'docx', title: node.title, localMdPath: localPath,
      localRelPath: rel, lastSyncedAt: '2026-10-01', lastSyncedModifyTime: '100', status: 'synced', watchedRootId: watched.id,
      watchedRootUrl: watched.url, parentNodeToken: node.parent_node_token, spaceId: 'space', hasChild: true, observedObjEditTime: 100 } as DocumentRecord);
    store.markDocumentSynced({ objToken: node.obj_token, syncedObjEditTime: 100, localMdPath: localPath, lastSyncedModifyTime: '100', lastSyncedAt: '2026-10-01' });
  }
  if (options.oldRootFields) store.recordCloudObservation({ objToken: 'docObject', wikiNodeToken: 'docNode', objType: 'docx', title: '旧文档',
    spaceId: 'space', parentNodeToken: 'parentNode', watchedRootId: watched.id, watchedRootUrl: watched.url, observedObjEditTime: 100,
    hasChild: false, observationStatus: 'available', lastSeenAt: '2026-10-01' });
  const lark = {
    async getNode(reference: string) {
      if (reference.includes('rootToken')) return nodes.rootToken;
      if (reference.includes('parentNode')) return nodes.parentNode;
      if (reference.includes('phantomNode')) return { ...nodes.parentNode, node_token: 'phantomNode', obj_token: 'phantomObject' };
      if (reference.includes('shortcutNode') && options.duplicateWiki) return { ...nodes.docNode, node_token: 'shortcutNode' };
      if (reference.includes('docNode') && options.differentWiki && !options.redirectWiki) return { ...nodes.docNode, node_token: 'docNode', parent_node_token: 'outside' };
      if (reference.includes('docNode') || reference.includes('shortcutNode')) return nodes.docNode;
      throw new Error('unknown node');
    },
    async listWikiNodes(input: { parentNodeToken: string }) {
      if (options.incomplete && input.parentNodeToken === 'parentNode') throw new Error('partial traversal');
      if (input.parentNodeToken === 'rootToken') return [nodes.parentNode];
      if (input.parentNodeToken === 'parentNode') {
        if (options.duplicateWiki) {
          const shortcut = { ...nodes.docNode, node_token: 'shortcutNode' };
          return options.duplicateWiki === 'first' ? [shortcut, nodes.docNode] : [nodes.docNode, shortcut];
        }
        return [nodes.docNode];
      }
      return [];
    },
    async getDocumentMetas(requests: Array<{ docToken: string; docType: string }>) {
      return { metas: requests.map((r) => ({ docToken: r.docToken, docType: r.docType, title: r.docToken, latestModifyTime: r.docToken === 'docObject' && options.changed ? 200 : 100 })), failed: [] };
    },
  };
  const snapshot = new SnapshotService(store, config, { larkCliClient: lark, config: config.getConfig() });
  const refreshSnapshot = vi.fn(() => snapshot.generate());
  const detector = new ChangeDetector(lark as never, store, { knowledgeBaseRoot: root, watchedRootUrlsProvider: () => options.unconfiguredRoot ? [] : [watched.url], onArchiveAdopted: refreshSnapshot, mediaGap: { enabled: false } });
  const mapping = new MappingService(detector, store, snapshot, config);
  const app = new Hono(); app.use('*', async (c, next) => { (c as any).localMapStore = store; (c as any).configManager = config; (c as any).changeDetector = detector; await next(); }); app.route('/', detectRoutes);
  return { dir, root, store, config, watched, file, bytes, oldRel, nodes, lark, detector, mapping, snapshot, refreshSnapshot, app };
}

describe('自定义归档进入受管理的飞书节点树', () => {
  it.each(['fast', 'full'] as const)('%s 检测后归位，旧文件和基线保持，后续同步继续使用原路径', async (mode) => {
    const f = await fixture();
    await f.detector.detectChanges(f.watched.url, { mode, forceFresh: true, bypassCooldown: true });
    const record = f.store.getDocumentByObjToken('docObject')!;
    expect(record).toMatchObject({ customFolderId: null, watchedRootId: 'rootToken', wikiNodeToken: 'docNode', parentNodeToken: 'parentNode', syncedObjEditTime: 100 });
    expect(f.store.listCustomFolderDocs('archive', f.root)).toEqual([]);
    expect(f.mapping.getTreeDetailed().nodes.find((node) => node.obj_token === 'docObject')).toMatchObject({ parent_node_token: 'parentNode', watched_root_url: f.watched.url });
    expect(f.snapshot.readExisting(f.root)?.nodes.find((node) => node.obj_token === 'docObject')).toMatchObject({ parent_node_token: 'parentNode', watched_root_url: f.watched.url });
    expect(f.refreshSnapshot).toHaveBeenCalledOnce();
    expect(fs.readFileSync(f.file, 'utf8')).toBe(f.bytes);
    const duplicate = path.join(f.root, '主知识库', '父文档', '重复副本.md');
    fs.mkdirSync(path.dirname(duplicate), { recursive: true }); fs.writeFileSync(duplicate, f.bytes);
    await new IndexScanner({ localMapStore: f.store, larkCliClient: f.lark, config: f.config.getConfig() }).scanKnowledgeBase(f.root);
    expect(f.store.getDocumentByObjToken('docObject')).toMatchObject({ customFolderId: null, localRelPath: f.oldRel,
      watchedRootId: f.watched.id, watchedRootUrl: f.watched.url, wikiNodeToken: 'docNode', parentNodeToken: 'parentNode' });
    expect(f.store.listCustomFolderDocs('archive', f.root)).toEqual([]);
    expect(f.mapping.getTreeDetailed().nodes.find((node) => node.obj_token === 'docObject')).toMatchObject({ parent_node_token: 'parentNode', watched_root_url: f.watched.url });
    const document: ChangedDocument = { objToken: 'docObject', objType: 'docx', title: '旧文档', changeType: 'modified', cloudModifiedTime: '', localSyncedTime: null,
      wikiNodeToken: 'docNode', parentNodeToken: 'parentNode', watchedRootId: 'rootToken', parentChainTitles: ['父文档'], localMdPath: f.file, localRelPath: f.oldRel };
    const plan = createOperationManifest({ knowledgeBaseRoot: f.root, watchedRoots: [f.watched], documents: [document], mode: 'apply' });
    expect(plan.documents[0]).toMatchObject({ action: 'replace', localMdPath: f.file, localRelPath: f.oldRel });
    fs.writeFileSync(f.file, '<!--\nfeishu_sync:\n  obj_token: "otherObject"\n-->\n# 别人的文件');
    expect(createOperationManifest({ knowledgeBaseRoot: f.root, watchedRoots: [f.watched], documents: [document], mode: 'apply' }).documents[0])
      .toMatchObject({ action: 'blocked', reasonCode: 'path_conflict' });
    fs.unlinkSync(f.file);
    const collision = path.join(f.root, '主知识库', '父文档', '旧文档.md');
    fs.mkdirSync(path.dirname(collision), { recursive: true }); fs.writeFileSync(collision, '# 已存在的其他文件');
    expect(createOperationManifest({ knowledgeBaseRoot: f.root, watchedRoots: [f.watched], documents: [document], mode: 'apply' }).documents[0])
      .toMatchObject({ action: 'blocked', reasonCode: 'path_conflict' });
    expect(fs.readFileSync(collision, 'utf8')).toBe('# 已存在的其他文件');
  });
  it('归位后新的云端正文可成功同步到原映射，不重复创建文件', async () => {
    const f = await fixture({ changed: true });
    const detected = await f.detector.detectChanges(f.watched.url, { mode: 'full', forceFresh: true, bypassCooldown: true });
    const document = detected.changedDocuments.find((item) => item.objToken === 'docObject')!;
    expect(document.customFolderId).toBeNull();
    const engine = new SyncEngine({ localMapStore: f.store, config: { ...f.config.getConfig(), operationManifestDir: path.join(f.dir, 'ops') },
      larkCliClient: { fetchDocumentMarkdown: async () => ({ data: { document: { content: '# 旧文档\n云端更新内容', images: [], attachments: [], sheets: [], url: '' } } }) } });
    const result = await engine.syncDocuments([document], { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' });
    expect(result.success, JSON.stringify(result.failedDocuments)).toBe(true);
    expect(fs.readFileSync(f.file, 'utf8')).toContain('云端更新内容');
    expect(f.store.getDocumentByObjToken('docObject')).toMatchObject({ customFolderId: null, localRelPath: f.oldRel, syncedObjEditTime: 200 });
    expect(fs.existsSync(path.join(f.root, '主知识库', '父文档', '旧文档.md'))).toBe(false);
  });
  it('历史上已有根和父节点但仍留在归档的记录，可在下一次快速遍历修复', async () => {
    const f = await fixture({ oldRootFields: true });
    await f.detector.detectChanges(f.watched.url, { mode: 'fast', forceFresh: true, bypassCooldown: true });
    expect(f.store.getDocumentByObjToken('docObject')).toMatchObject({ customFolderId: null, parentNodeToken: 'parentNode' });
    expect(f.mapping.getTreeDetailed().nodes.some((node) => node.obj_token === 'docObject')).toBe(true);
  });
  it('父子文档同时从归档迁入时，即使旧缓存先返回子节点也按父子顺序接入', async () => {
    const f = await fixture({ oldRootFields: true });
    (f.store as any).db.prepare(`UPDATE documents SET custom_folder_id = 'archive', watched_root_id = NULL, watched_root_url = NULL,
      original_link = 'https://test.feishu.cn/wiki/parentNode' WHERE obj_token = 'parentObject'`).run();
    await f.detector.detectChanges(f.watched.url, { mode: 'fast', forceFresh: true, bypassCooldown: true });
    expect(f.store.getDocumentByObjToken('parentObject')?.customFolderId).toBeNull();
    expect(f.store.getDocumentByObjToken('docObject')?.customFolderId).toBeNull();
    const nodes = f.mapping.getTreeDetailed().nodes;
    expect(nodes.find((node) => node.obj_token === 'docObject')?.parent_node_token).toBe('parentNode');
    expect(nodes.some((node) => node.wiki_node_token === 'parentNode')).toBe(true);
  });
  it('树遍历不完整时，单靠旧根字段和元数据不能转移归档', async () => {
    const f = await fixture({ oldRootFields: true, incomplete: true });
    await f.detector.detectChanges(f.watched.url, { mode: 'fast', forceFresh: true, bypassCooldown: true });
    expect(f.store.getDocumentByObjToken('docObject')?.customFolderId).toBe('archive');
    expect(f.store.listCustomFolderDocs('archive', f.root)).toHaveLength(1);
    expect(f.refreshSnapshot).not.toHaveBeenCalled();
  });
  it('同一云文档的另一个 Wiki 节点不视为原节点移动', async () => {
    const f = await fixture({ differentWiki: true });
    await f.detector.detectChanges(f.watched.url, { mode: 'full', forceFresh: true, bypassCooldown: true });
    expect(f.store.getDocumentByObjToken('docObject')).toMatchObject({ customFolderId: 'archive', watchedRootId: null });
  });
  it.each(['fast', 'full'] as const)('%s 检测同时发现原节点和快捷方式时，持续保留原节点', async (mode) => {
    for (const duplicateWiki of ['first', 'last'] as const) {
      const f = await fixture({ duplicateWiki, oldRootFields: true, changed: true });
      for (let i = 0; i < 2; i++) {
        const result = await f.detector.detectChanges(f.watched.url, { mode, forceFresh: true, bypassCooldown: true });
        expect(f.store.getDocumentByObjToken('docObject')).toMatchObject({ customFolderId: null, wikiNodeToken: 'docNode', parentNodeToken: 'parentNode' });
        expect(result.changedDocuments.filter((item) => item.objToken === 'docObject')).toHaveLength(1);
      }
    }
  });
  it('旧 Wiki 地址能明确解析到新节点时，支持节点标识变化后的迁入', async () => {
    const f = await fixture({ differentWiki: true, redirectWiki: true });
    await f.detector.detectChanges(f.watched.url, { mode: 'full', forceFresh: true, bypassCooldown: true });
    expect(f.store.getDocumentByObjToken('docObject')).toMatchObject({ customFolderId: null, wikiNodeToken: 'shortcutNode', parentNodeToken: 'parentNode' });
    await new IndexScanner({ localMapStore: f.store, larkCliClient: f.lark, config: f.config.getConfig() }).scanKnowledgeBase(f.root);
    expect(f.store.getDocumentByObjToken('docObject')).toMatchObject({ customFolderId: null, wikiNodeToken: 'shortcutNode', watchedRootUrl: f.watched.url });
  });
  it('不属于已启用同步根，或父链仅靠补查推测时不转移归档', async () => {
    for (const options of [{ unconfiguredRoot: true }, { phantomParent: true }]) {
      const f = await fixture(options);
      await f.detector.detectChanges(f.watched.url, { mode: 'full', forceFresh: true, bypassCooldown: true });
      expect(f.store.getDocumentByObjToken('docObject')?.customFolderId).toBe('archive');
    }
  });
  it('屏蔽或手动删除的文档不会被树遍历自动恢复', async () => {
    const f = await fixture();
    f.store.blockSyncSources(f.root, [f.store.getDocumentByObjToken('docObject')!]);
    await f.detector.detectChanges(f.watched.url, { mode: 'full', forceFresh: true, bypassCooldown: true });
    expect(f.store.getDocumentByObjToken('docObject')?.customFolderId).toBe('archive');
    f.store.removeSyncBlockedSources(f.root, ['docObject']);
    f.store.markLocalSourceDeleted(f.root, f.store.getDocumentByObjToken('docObject')!);
    await f.detector.detectChanges(f.watched.url, { mode: 'full', forceFresh: true, bypassCooldown: true });
    expect(f.store.getDocumentByObjToken('docObject')?.customFolderId).toBe('archive');
    expect(f.store.isLocalSourceDeleted(f.root, 'docObject')).toBe(true);
  });
  it('一次全量检测中归档文档发生内容变化并迁入节点树，只返回一次树内结果', async () => {
    const f = await fixture({ changed: true });
    const response = await f.app.request('/api/detect/changes-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'full', mediaGapScope: 'local-only' }) });
    expect(response.status).toBe(200);
    const result = await response.json() as { changedDocuments: ChangedDocument[] };
    const docs = result.changedDocuments.filter((doc) => doc.objToken === 'docObject');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ customFolderId: null, parentNodeToken: 'parentNode', watchedRootId: 'rootToken', parentChainTitles: ['父文档'] });
  });
});
