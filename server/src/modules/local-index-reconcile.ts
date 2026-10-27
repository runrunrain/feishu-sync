import type { LocalMapStore } from './local-map-store.js';
/** 按当前磁盘校正派生索引；云端待同步身份/修复队列和版本历史不在清理范围内。 */
export function reconcileLocalIndex(store: LocalMapStore, root: string, refresh?: () => unknown) {
  if (!root || typeof store.pruneMissingLocalDocs !== 'function') return;
  const result = store.pruneMissingLocalDocs(root);
  if (result.pruned || result.prunedSheets || result.prunedDirectories) {
    try { refresh?.(); } catch (error) { console.warn('[local-index] snapshot refresh failed:', error); }
  }
  return result;
}
