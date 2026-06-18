/**
 * GlobalStatusBar - 全局状态条（T12，04 §4.1.2）
 *
 * 单行紧凑（44-48px），展示：
 *   认证状态 / 上次检测 / 下次检测 / 立即检测 / 刷新索引
 *
 * B4 修复保持：立即检测调用 detect(config.watchedRootUrls[0])，从 useConfig
 * 取值；URL 未配置时按钮禁用 + tooltip 提示。
 */

import { RefreshCw, Wifi, WifiOff, Clock, Database } from 'lucide-react';
import { useAuthStatus } from '../hooks/useAuthStatus';
import { useSyncStatus } from '../hooks/useSyncStatus';
import { useConfig } from '../hooks/useConfig';
import { useChanges } from '../hooks/useChanges';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';
import { refreshMappingIndex } from '../api/client';
import { isUsableWikiUrl, pickFirstValidWikiUrl } from '../utils/wikiUrl';
import { useState } from 'react';

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
  const { pendingCount, lastSyncTime, nextCheckTime, isDetecting } = useSyncStatus();
  const { config } = useConfig();
  const { detect } = useChanges();
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);

  const activeRootUrl = pickFirstValidWikiUrl(config?.watchedRootUrls);
  const urlUnconfigured = !activeRootUrl && (config?.watchedRootUrls?.length ?? 0) === 0;
  const urlInvalid = !activeRootUrl && (config?.watchedRootUrls?.length ?? 0) > 0;
  const detectDisabled = isDetecting || !isUsableWikiUrl(activeRootUrl);
  const detectTooltip = urlUnconfigured
    ? '请先在设置中配置飞书根 URL'
    : urlInvalid
      ? '配置的飞书根 URL 格式无效'
      : '';

  const handleDetect = () => {
    if (!isUsableWikiUrl(activeRootUrl)) return;
    detect(activeRootUrl);
  };

  const handleRefreshIndex = async () => {
    setRefreshing(true);
    try {
      const r = await refreshMappingIndex();
      appLogger.info('global-status', 'refresh-index ok', r);
      toast.push({
        type: 'success',
        message: `索引已刷新 · ${r.node_count} 节点`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '刷新索引失败';
      appLogger.error('global-status', 'refresh-index failed', err);
      toast.push({ type: 'error', message: '刷新索引失败', hint: msg });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 bg-card-bg border border-line rounded-md shadow-sm">
      <div className="flex items-center gap-4 min-w-0 flex-1">
        {/* Auth */}
        <div className="flex items-center gap-1.5 shrink-0">
          {authReady ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-jade" />
              <Wifi className="w-3.5 h-3.5 text-jade" />
              <span className="text-xs text-ink-soft font-sans-ui">
                已认证{lauthVersion(authStatus?.larkCliVersion)}
              </span>
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-seal animate-pulse-seal" />
              <WifiOff className="w-3.5 h-3.5 text-seal" />
              <span className="text-xs text-seal font-sans-ui">未认证</span>
            </>
          )}
        </div>

        <span className="w-px h-3.5 bg-line shrink-0" />

        {/* Pending count */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={`text-sm font-kai ${
              pendingCount > 0 ? 'text-seal' : 'text-jade'
            }`}
          >
            {pendingCount}
          </span>
          <span className="text-xs text-ink-soft font-sans-ui">
            {pendingCount > 0 ? '篇待同步' : '已就绪'}
          </span>
        </div>

        <span className="w-px h-3.5 bg-line shrink-0" />

        {/* Last/next detect */}
        <div className="flex items-center gap-1.5 text-xs text-ink-faint font-sans-ui shrink-0">
          <Clock className="w-3 h-3" />
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

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={handleRefreshIndex}
          disabled={refreshing}
          title="强制刷新本地索引快照"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-ink-soft border border-line rounded-md bg-paper hover:bg-paper-2 font-sans-ui transition-colors disabled:opacity-50"
        >
          <Database className="w-3.5 h-3.5" />
          {refreshing ? '刷新中' : '刷新索引'}
        </button>
        <button
          type="button"
          onClick={handleDetect}
          disabled={detectDisabled}
          title={detectTooltip}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-seal border border-seal rounded-md bg-paper hover:bg-seal/5 font-sans-ui transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isDetecting ? 'animate-spin' : ''}`} />
          {isDetecting ? '检测中' : '立即检测'}
        </button>
      </div>
    </div>
  );
}

function lauthVersion(v?: string): string {
  if (!v) return '';
  return ` · ${v}`;
}
