import type { Config, DocumentRecord, WatchedRootConfig } from '../types/index.js';
import { getEnabledWatchedRoots } from '../types/index.js';
import type { LocalMapStore } from './local-map-store.js';
import { ToolError } from '../agent/agent-tool-service.js';
import { cleanupSources } from '../kb/source-cleanup.js';

/** 必须有有效祖先链通向启用中的同步根；不把归档、循环/缺失/删除候选上级当作有效绑定。 */
export function createPendingRootResolver(all: DocumentRecord[], config: Config) {
  const byWiki = new Map(all.filter((node) => node.wikiNodeToken).map((node) => [node.wikiNodeToken!, node]));
  const roots = getEnabledWatchedRoots(config);
  return (doc: DocumentRecord): WatchedRootConfig | null => {
  if (doc.customFolderId || !doc.parentNodeToken || !doc.wikiNodeToken) return null;
  const seen = new Set<string>([doc.wikiNodeToken]);
  let parent = byWiki.get(doc.parentNodeToken);
  while (parent && parent.wikiNodeToken && !seen.has(parent.wikiNodeToken)) {
    if (parent.cloudDeleted || parent.syncState === 'missing_candidate' || parent.syncState === 'deleted_confirmed' || parent.customFolderId) return null;
    seen.add(parent.wikiNodeToken);
    const root = roots.find((item) => item.id === parent!.wikiNodeToken);
    if (root) {
      if (doc.watchedRootId && doc.watchedRootId !== root.id) return null;
      if (!doc.watchedRootId && doc.watchedRootUrl && doc.watchedRootUrl !== root.url) return null;
      return root;
    }
    parent = byWiki.get(parent.parentNodeToken ?? '');
  }
  return null;
  };
}
export function pendingRootForDeletedDoc(doc: DocumentRecord, all: DocumentRecord[], config: Config): WatchedRootConfig | null { return createPendingRootResolver(all, config)(doc); }
export function deleteSourceNode(store: LocalMapStore, config: Config, doc: DocumentRecord, options: { deleteFiles: boolean; block: boolean }) {
  if ((options.block || options.deleteFiles && (doc.localRelPath || doc.localMdPath)) && !config.knowledgeBaseRoot) throw new ToolError('knowledge_base_root_not_configured', '请先配置本地知识库目录', 400);
  const root = pendingRootForDeletedDoc(doc, store.getAllDocuments(), config);
  const blocked = options.block || store.isSyncBlocked(config.knowledgeBaseRoot, doc.objToken);
  const commit = () => store.clearLocalDocument(doc.objToken, { pending: Boolean(root), blockRoot: blocked ? config.knowledgeBaseRoot : undefined, watchedRootId: root?.id, watchedRootUrl: root?.url });
  let cleanup: ReturnType<typeof cleanupSources> | undefined;
  if (options.deleteFiles && (doc.localRelPath || doc.localMdPath)) {
    cleanup = cleanupSources(store, config.knowledgeBaseRoot, [{ objToken: doc.objToken, relPath: doc.localRelPath || doc.localMdPath }], { allowMissing: true, commit });
  } else commit();
  return { ok: true, pending_sync: Boolean(root) && !blocked, blocked, file_moved_to_trash: Boolean(cleanup?.movedFiles), trash_dir: cleanup?.trashDir };
}
