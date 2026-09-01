/**
 * syncEvents - 跨视图同步状态事件总线（2026-06 跨视图实时刷新修复）
 *
 * 背景：v0.2.9 起三个主区（总览/同步/设置）常驻挂载、切换仅 hidden，
 * 每个视图各自缓存一份 diff 快照：
 *   - TopBar 徽标 + GlobalStatusBar「N 篇待同步」→ useSyncStatus（聚合 cached diff）
 *   - 同步页变更列表 → ChangeListPanel.diff
 *   - 总览「最近变更」→ Dashboard.changes
 * 此前不存在跨组件传播：同步完成后只有 SyncView 内部的 diffRefreshSignal
 * 被推进，总览的待同步数量/最近变更保持旧值；在总览触发检测后同步页
 * 列表也不会重读已持久化的 diff。用户报告：
 *   1) 同步完成后总览待同步数量不实时更新；
 *   2) 总览侧操作（立即检测/同步此节点跳转）后同步页变更列表不更新，
 *      必须手动点同步页的「立即检测」。
 *
 * 修复：凡是会改变服务端 diff 存储的 API（检测/同步/重建索引/回收站/
 * 归档快捷添加）在 client.ts 成功返回后 emitDiffChanged()；所有持有
 * diff 快照的组件订阅事件并重拉 cached diff（本地 SQLite 读，无云遍历）。
 * 服务端 PollingScheduler 定时检测没有客户端事件，由 SyncView 的
 * 可见性刷新兜底（切到同步区时重读一次）。
 *
 * 设计约束：
 *   - 事件只由「写路径」触发；订阅方的重拉是 cached 读，不会引发事件
 *     回环（getStoredMappingDiff 不 emit）。
 *   - 监听器异常被隔离捕获，不影响其他订阅者；同步派发，无队列。
 */

type DiffChangedListener = (source: string) => void;

const listeners = new Set<DiffChangedListener>();

/**
 * 广播「服务端 diff 存储已变更」。source 仅用于日志/诊断（如 'sync'、
 * 'detect'、'trash-purge'），订阅方不应依赖其取值做分支。
 */
export function emitDiffChanged(source: string): void {
  for (const listener of listeners) {
    try {
      listener(source);
    } catch (err) {
      // 隔离单个订阅者异常，避免破坏广播与其余订阅者。
      console.warn('[syncEvents] diff-changed listener failed', { source, err });
    }
  }
}

/**
 * 订阅 diff 变更事件，返回取消订阅函数（供 useEffect cleanup 使用）。
 */
export function onDiffChanged(listener: DiffChangedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
