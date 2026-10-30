import type { LocalMapStore } from './local-map-store.js';
import type { DocumentRecord } from '../types/index.js';

/** 删除的源不能通过旧基线、云端观察或保留的文件重新进入本地视图。 */
export function filterDeletedLocalDocuments(store: LocalMapStore, root: string, docs: DocumentRecord[]): DocumentRecord[] {
  const deleted = new Set(root && typeof store.listLocalSourceDeletions === 'function'
    ? store.listLocalSourceDeletions(root).map((item) => item.objToken) : []);
  return docs.filter((doc) => doc.pendingReason !== 'local_deleted' && !deleted.has(doc.objToken));
}
/** 按当前磁盘校正派生索引；云端待同步身份/修复队列和版本历史不在清理范围内。 */
export function reconcileLocalIndex(store: LocalMapStore, root: string, refresh?: () => unknown) {
  if (!root || typeof store.pruneMissingLocalDocs !== 'function') return;
  const result = store.pruneMissingLocalDocs(root);
  if (result.pruned || result.prunedSheets || result.prunedDirectories) {
    try { refresh?.(); } catch (error) { console.warn('[local-index] snapshot refresh failed:', error); }
  }
  return result;
}
