/**
 * GlobalStatusBar - 全局状态条（T12，04 §4.1.2）
 *
 * 单行紧凑（44-48px），展示：
 *   认证状态 / 上次检测 / 下次检测 / 立即检测 / 刷新索引
 *
 * B4 修复保持：立即检测调用 detect(config.watchedRootUrls[0])，从 useConfig
 * 取值；URL 未配置时按钮禁用 + tooltip 提示。
 */

import { useState } from 'react';
import { RefreshCw, Wifi, WifiOff, Clock, Database } from 'lucide-react';
import { useAuthStatus } from '../hooks/useAuthStatus';
import { useSyncStatus } from '../hooks/useSyncStatus';
import { useConfig } from '../hooks/useConfig';
import { useChanges } from '../hooks/useChanges';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';
import { refreshMappingIndex, rebuildIndex } from '../api/client';
import { isUsableWikiUrl, pickFirstValidWikiUrl } from '../utils/wikiUrl';

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return '--';
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function formatNextCheck(timestamp: number | null): string {
  if (!timestamp) return '已排程';
  const diff = Math.floor((timestamp - Date.now()) / 1000);
  if (diff <= 0) return '即刻检测';
  if (diff < 60) return `${diff} 秒后`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟后`;
  return `${Math.floor(diff / 3600)} 小时后`;
}

export function GlobalStatusBar() {
  const { ready: authReady, authStatus } = useAuthStatus();
  const [refreshTick, setRefreshTick] = useState(0);
  const { pendingCount, lastSyncTime, nextCheckTime, isDetecting } = useSyncStatus({ refreshTick });
  const { config } = useConfig();
  const { detect, detectAll } = useChanges();
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [detecting, setDetecting] = useState(false);

  const activeRootUrl = pickFirstValidWikiUrl(config?.watchedRootUrls);
  const urlUnconfigured = !activeRootUrl && (config?.watchedRootUrls?.length ?? 0) === 0;
  const urlInvalid = !activeRootUrl && (config?.watchedRootUrls?.length ?? 0) > 0;
  const detectDisabled = detecting || !isUsableWikiUrl(activeRootUrl);
  const detectTooltip = urlUnconfigured
    ? '请先在设置中配置飞书根 URL'
    : urlInvalid
      ? '配置的飞书根 URL 格式无效'
      : '';

  const handleDetect = async () => {
    if (!isUsableWikiUrl(activeRootUrl)) return;
    setDetecting(true);
    try {
      // v0.2.0 sync-state-timeout-fix: the status bar's detect button
      // used to fire detectChanges(firstRootUrl), which only refreshed
      // ONE watched subtree. With 4 watchedRoots configured the other
      // three subtrees stayed stale, so the user saw "no changes" in
      // the panel while pending edits silently existed in the other
      // roots. detectChangesAll() iterates every watchedRoot on the
      // server side (POST /api/detect/changes-all) and aggregates the
      // results, giving a single click the expected full-refresh
      // semantics. Per-root detect stays available via `detect(rootUrl)`
      // for callers that need it.
      const rootCount = config?.watchedRootUrls?.length ?? 0;
      if (rootCount > 1) {
        await detectAll();
      } else {
        await detect(activeRootUrl);
      }
      // Bump refreshTick so useSyncStatus re-pulls the real pendingCount
      // immediately after a detect completes; this is what keeps the
      // status-bar counter in lockstep with ChangeListPanel's diff.
      setRefreshTick((n) => n + 1);
    } finally {
      setDetecting(false);
    }
  };

  const handleRefreshIndex = async () => {
    setRefreshing(true);
    // P0-bug-2 修复：先 rebuild documents（重新扫描本地 KB 写入真实
    // title/status），再 refresh snapshot（投影 _index.json）。rebuild 期间
    // 显示 loading + "正在重建索引..."，完成后按数量提示。
    toast.push({ type: 'info', message: '正在重建索引…', hint: '重新扫描本地知识库' });
    try {
      const rebuilt = await rebuildIndex();
      appLogger.info('global-status', 'rebuild-index ok', rebuilt);
      // 后端按契约已刷新 _index.json；这里再拉一次 snapshot 保证 UI 与文件
      // 系统同步，并取到 node_count 用于提示。
      let nodeCount: number | undefined;
      try {
        const snap = await refreshMappingIndex();
        nodeCount = snap.node_count;
        appLogger.info('global-status', 'refresh-index ok after rebuild', snap);
      } catch (snapErr) {
        // snapshot 刷新失败不致命，rebuild 已成功
        appLogger.warn('global-status', 'refresh-index failed after rebuild (non-fatal)', snapErr);
      }
      const failedCount = Array.isArray(rebuilt.failed) ? rebuilt.failed.length : 0;
      const countText = typeof nodeCount === 'number'
        ? `${nodeCount} 节点`
        : `${rebuilt.rebuilt} 文档`;
      // 2026-09：手动删除的本地文件对应行已被清理——toast 提示消除疑虑，
      // 并告知恢复途径（下次检测会作为本地缺失新增项重新出现）。
      const prunedText = (rebuilt.pruned_local_missing ?? 0) > 0
        ? `，已清理 ${rebuilt.pruned_local_missing} 个手动删除的残留记录`
        : '';
      if (failedCount > 0) {
        toast.push({
          type: 'warning',
          message: `索引重建完成 · ${countText}（${failedCount} 项失败）${prunedText}`,
          hint: '失败详情见日志',
        });
      } else {
        toast.push({
          type: 'success',
          message: `索引重建完成 · ${countText}${prunedText}`,
        });
      }
      // After rebuild the pendingCount may have changed (rows flipped between
      // placeholder/synced); bump the refresh tick so useSyncStatus re-pulls.
      setRefreshTick((n) => n + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '索引重建失败';
      appLogger.error('global-status', 'rebuild-index failed', err);
      toast.push({ type: 'error', message: '索引重建失败', hint: msg });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-3 bg-card-bg border border-line rounded-md shadow-sm lg:flex-row lg:items-center lg:justify-between lg:gap-6 lg:px-5">
      {/*
        状态条布局重构（2026-06-19）：
        - px-4→px-5、py-2.5→py-3：内边距匹配 Card 内边距节奏
        - gap-4→gap-6：左右两个分组之间留呼吸
        - 内部分组 gap-1.5→gap-2.5：图标与文字间距更舒展
      */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 lg:flex-1 lg:gap-x-5">
        {/* Auth */}
        <div className="flex items-center gap-2 shrink-0">
          {authReady ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-jade" />
              <Wifi className="w-4 h-4 text-jade" />
              <span className="text-sm text-ink-soft font-sans-ui">
                已认证{lauthVersion(authStatus?.larkCliVersion)}
              </span>
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-seal animate-pulse-seal" />
              <WifiOff className="w-4 h-4 text-seal" />
              <span className="text-sm text-seal font-sans-ui">未认证</span>
            </>
          )}
        </div>

        <span className="w-px h-4 bg-line shrink-0" />

        {/* Pending count */}
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-base font-kai leading-none ${
              pendingCount > 0 ? 'text-seal' : 'text-jade'
            }`}
          >
            {pendingCount}
          </span>
          <span className="text-sm text-ink-soft font-sans-ui">
            {pendingCount > 0 ? '篇待同步' : '已就绪'}
          </span>
        </div>

        <span className="w-px h-4 bg-line shrink-0" />

        {/* Last/next detect */}
        <div className="flex items-center gap-2 text-xs text-ink-faint font-sans-ui shrink-0">
          <Clock className="w-3.5 h-3.5" />
          <span>上次 {formatRelativeTime(lastSyncTime)}</span>
          {!isDetecting && nextCheckTime && (
            <>
              <span aria-hidden>·</span>
              <span>下次 {formatNextCheck(nextCheckTime)}</span>
            </>
          )}
          {isDetecting && (
            <span className="text-seal flex items-center gap-1">
              <RefreshCw className="w-3 h-3 animate-spin" />
              检测中
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 lg:shrink-0">
        <button
          type="button"
          onClick={handleRefreshIndex}
          disabled={refreshing}
          title="重新扫描本地知识库并重建 documents 索引"
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-ink-soft border border-line rounded-md bg-paper hover:bg-paper-2 font-sans-ui transition-colors disabled:opacity-50"
        >
          <Database className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? '重建中' : '重建索引'}
        </button>
        <button
          type="button"
          onClick={handleDetect}
          disabled={detectDisabled}
          title={detectTooltip}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs text-seal border border-seal rounded-md bg-paper hover:bg-seal/5 font-sans-ui transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${detecting || isDetecting ? 'animate-spin' : ''}`} />
          {detecting || isDetecting ? '检测中' : '立即检测'}
        </button>
      </div>
    </div>
  );
}

function lauthVersion(v?: string): string {
  if (!v) return '';
  return ` · ${v}`;
}
