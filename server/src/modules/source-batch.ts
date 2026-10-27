import fs from 'node:fs';
import crypto from 'node:crypto';
import { ToolError } from '../agent/agent-tool-service.js';
import { prepareSourceCleanup, cleanupSources } from '../kb/source-cleanup.js';
import { StandardKbStore } from '../kb/standard-kb-store.js';
import { createPendingRootResolver } from './source-node-delete.js';
import type { LocalMapStore } from './local-map-store.js';
import type { Config, DocumentRecord } from '../types/index.js';
import type { SourceBatchRequest, SourceBatchPreview, SourceBatchResult } from '../types/source-batch.js';

export function parseSourceBatchRequest(body: unknown): SourceBatchRequest {
  const value = body as Partial<SourceBatchRequest> | null;
  if (!value || typeof value.root !== 'string' || !Array.isArray(value.tokens) || !value.tokens.length || value.tokens.length > 50000
    || !value.tokens.every((token) => typeof token === 'string' && token.length > 0) || !['delete','block'].includes(value.action ?? '')
    || !['includeDescendants','deleteFiles','block'].every((key) => typeof (value as any)[key] === 'boolean'))
    throw new ToolError('invalid_request', '请提供明确的选择范围与操作选项', 400);
  return { root: value.root, tokens: [...value.tokens], action: value.action as 'delete' | 'block', includeDescendants: value.includeDescendants!, deleteFiles: value.deleteFiles!, block: value.block! };
}
/** 后端决定最终范围并计算影响；完整确认内容和相关拓扑共同参与revision。 */
export function planSourceBatch(store: LocalMapStore, config: Config, request: SourceBatchRequest) {
  if (!config.knowledgeBaseRoot || request.root !== config.knowledgeBaseRoot) throw new ToolError('knowledge_root_changed', '知识库目录已变化，请刷新清单', 409);
  const all = store.getAllDocuments(); const byToken = new Map(all.map((doc) => [doc.objToken, doc]));
  const selected = new Set(request.tokens);
  if ([...selected].some((token) => !byToken.has(token) || byToken.get(token)!.cloudDeleted)) throw new ToolError('source_selection_changed', '部分文档已变化或移入回收站，请重新选择', 409);
  const directCount = selected.size;
  if (request.includeDescendants) {
    const children = new Map<string, DocumentRecord[]>();
    for (const doc of all) if (doc.parentNodeToken && !doc.cloudDeleted) { const list = children.get(doc.parentNodeToken) ?? []; list.push(doc); children.set(doc.parentNodeToken, list); }
    const queue = [...selected];
    for (let i = 0; i < queue.length; i++) {
      const parent = byToken.get(queue[i])!;
      for (const child of [...(children.get(parent.wikiNodeToken ?? '') ?? []), ...(children.get(parent.objToken) ?? [])]) {
        if (!selected.has(child.objToken)) { selected.add(child.objToken); queue.push(child.objToken); }
      }
    }
  }
  if (selected.size > 50000) throw new ToolError('selection_too_large', '一次最多处理50000篇文档', 400);
  const docs = [...selected].sort().map((token) => byToken.get(token)!);
  const blocked = new Set(store.listSyncBlockedSources(request.root).map((doc) => doc.objToken));
  const willBlock = (doc: DocumentRecord) => request.action === 'block' || request.block || blocked.has(doc.objToken);
  const initialRoot = createPendingRootResolver(all, config);
  const removedAncestors = new Set(request.action === 'delete' ? docs.filter((doc) => !willBlock(doc) && !initialRoot(doc)).map((doc) => doc.objToken) : []);
  const finalTopology = all.filter((doc) => !removedAncestors.has(doc.objToken));
  const finalRoot = createPendingRootResolver(finalTopology, config);
  const actions = docs.map((doc) => {
    const root = request.action === 'delete' ? finalRoot(doc) : null;
    return { objToken: doc.objToken, pending: Boolean(root), blockRoot: willBlock(doc) ? request.root : undefined, watchedRootId: root?.id, watchedRootUrl: root?.url };
  });
  const sources = request.action === 'delete' && request.deleteFiles ? docs.filter((doc) => doc.localRelPath || doc.localMdPath).map((doc) => ({ objToken: doc.objToken, relPath: doc.localRelPath || doc.localMdPath })) : [];
  const prepared = sources.length ? prepareSourceCleanup(store, request.root, sources, { allowMissing: true }) : null;
  const fileStates = [...(prepared?.files ?? [])].map(([absolute, path]) => { const stat = fs.statSync(absolute); return { path, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, ino: stat.ino }; }).sort((a,b) => a.path.localeCompare(b.path));
  const manifest = new StandardKbStore(config.standardKb.outputRoot).readManifest();
  const preview: SourceBatchPreview = {
    revision: '', action: request.action, directCount, descendantCount: docs.length - directCount,
    items: docs.map((doc, i) => ({ objToken: doc.objToken, title: doc.title, path: doc.localRelPath || doc.localMdPath || '尚无本地文件', effect: actions[i].blockRoot ? 'blocked' : actions[i].pending ? 'pending' : 'removed' })),
    files: fileStates.map(({ path, size }) => ({ path, size })),
    affectedStandardDocs: request.action === 'delete' ? manifest?.docs.filter((doc) => doc.sources.some((token) => selected.has(token))).map(({ docId, title }) => ({ docId, title })) ?? [] : [],
  };
  preview.revision = crypto.createHash('sha256').update(JSON.stringify({ request, preview, fileStates, blocked: [...blocked].sort(), roots: config.watchedRoots,
    topology: all.map((doc) => [doc.objToken,doc.wikiNodeToken,doc.parentNodeToken,doc.cloudDeleted,
      doc.syncState === 'missing_candidate' || doc.syncState === 'deleted_confirmed',doc.customFolderId,doc.watchedRootId,doc.watchedRootUrl,doc.title,doc.localRelPath,doc.localMdPath]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))), release: manifest?.releaseId ?? null })).digest('hex');
  return { preview, docs, actions, sources };
}
export function executeSourceBatch(store: LocalMapStore, config: Config, request: SourceBatchRequest, expectedRevision: string): SourceBatchResult {
  const plan = planSourceBatch(store, config, request);
  if (plan.preview.revision !== expectedRevision) throw new ToolError('source_plan_changed', '文档、文件或影响范围已变化，请刷新清单后再确认', 409);
  let movedFiles = 0; let trashDir: string | undefined;
  if (request.action === 'block') store.blockSyncSources(request.root, plan.docs);
  else {
    const commit = () => store.clearLocalDocuments(plan.actions);
    if (plan.sources.length) { const result = cleanupSources(store, request.root, plan.sources, { allowMissing: true, commit }); movedFiles = result.movedFiles; trashDir = result.trashDir; }
    else commit();
  }
  return { processed: plan.docs.length, movedFiles, trashDir,
    pending: plan.preview.items.filter((doc) => doc.effect === 'pending').length,
    blocked: plan.preview.items.filter((doc) => doc.effect === 'blocked').length,
    removed: plan.preview.items.filter((doc) => doc.effect === 'removed').length };
}
