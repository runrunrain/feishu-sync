/**
 * SyncPulse - 朱红印章风格同步指示条
 * 横贯顶部 48px，实时显示同步状态
 * 左：logo + 版本 | 中：朱红印章同步指示 | 右：主操作
 */

import { Clock, Activity, CheckCircle, AlertCircle, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { useSyncStatus } from '../hooks/useSyncStatus';

interface SyncPulseProps {
  onDetectNow?: () => void;
  onSyncAll?: () => void;
  authReady?: boolean;
}

export function SyncPulse({ onDetectNow, onSyncAll, authReady = false }: SyncPulseProps) {
  const { pendingCount, lastSyncTime, nextCheckTime, isDetecting } = useSyncStatus();

  // Format timestamp to relative time
  const formatRelativeTime = (timestamp: number | null): string => {
    if (!timestamp) return '--';
    const now = Date.now();
    const diff = Math.floor((now - timestamp) / 1000); // seconds

    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return `${Math.floor(diff / 86400)} 天前`;
  };

  // Format next check time
  const formatNextCheck = (timestamp: number | null): string => {
    if (!timestamp) return '已排程';
    const now = Date.now();
    const diff = Math.floor((timestamp - now) / 1000);

    if (diff <= 0) return '即刻检测';
    if (diff < 60) return `${diff} 秒后`;
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟后`;
    return `${Math.floor(diff / 3600)} 小时后`;
  };

  const pendingText = pendingCount > 0
    ? `${pendingCount} 篇待同步`
    : '全部已同步';

  return (
    <div className="h-[48px] bg-card-bg border-b border-line flex items-center justify-between px-3 relative">
      {/* 角落水墨晕染装饰（左上） */}
      <div className="absolute -top-8 -left-8 w-24 h-24 bg-jade/10 rounded-full blur-xl pointer-events-none" />

      {/* Left: Logo + Version */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-center gap-1.5">
          {/* Feishu + Sync icon combination */}
          <div className="relative w-6 h-6 flex items-center justify-center">
            <Activity className="w-4 h-4 text-seal" strokeWidth={2.5} />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold font-kai text-ink">
              飞书同步
            </span>
          </div>
        </div>
        <div className="h-4 w-px bg-line opacity-60 mx-1" />
        <span className="text-xs text-ink-faint font-mono">v0.1.0</span>
      </div>

      {/* Center: 朱红印章同步指示 */}
      <div className="flex items-center gap-2 px-4 py-1.5 bg-paper rounded-full border border-line shadow-sm">
        {/* 朱红印章图形 */}
        <div className="relative">
          {pendingCount > 0 ? (
            <>
              <div className="w-3 h-3 rounded-sm bg-seal flex items-center justify-center animate-pulse-seal">
                <span className="text-[8px] text-white font-kai">同</span>
              </div>
              <div className="absolute inset-0 w-3 h-3 rounded-sm bg-seal opacity-30 blur-md" />
            </>
          ) : (
            <div className="w-3 h-3 rounded-sm bg-jade flex items-center justify-center">
              <CheckCircle className="w-2 h-2 text-white" strokeWidth={3} />
            </div>
          )}
        </div>

        {/* Status text */}
        <div className="flex items-center gap-2 text-xs font-serif">
          <span className={pendingCount > 0 ? 'text-seal font-medium' : 'text-jade font-medium'}>
            {pendingText}
          </span>

          <span className="text-ink-faint">·</span>

          <span className="text-ink-soft flex items-center gap-1">
            <Clock className="w-3 h-3" />
            上次 {formatRelativeTime(lastSyncTime)}
          </span>

          {!isDetecting && nextCheckTime && (
            <>
              <span className="text-ink-faint">·</span>
              <span className="text-ink-soft flex items-center gap-1">
                {formatNextCheck(nextCheckTime)} 检测
              </span>
            </>
          )}

          {isDetecting && (
            <>
              <span className="text-ink-faint">·</span>
              <span className="text-seal flex items-center gap-1">
                <RefreshCw className="w-3 h-3 animate-spin" />
                检测中
              </span>
            </>
          )}
        </div>
      </div>

      {/* Right: Primary Actions + Auth Status */}
      <div className="flex items-center gap-2">
        {/* Auth Status Indicator */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-paper border border-line">
          {authReady ? (
            <>
              <div className="w-1.5 h-1.5 rounded-sm bg-jade" />
              <Wifi className="w-3.5 h-3.5 text-jade" />
              <span className="text-xs text-ink-soft">已连接</span>
            </>
          ) : (
            <>
              <div className="w-1.5 h-1.5 rounded-sm bg-seal animate-pulse" />
              <WifiOff className="w-3.5 h-3.5 text-seal" />
              <span className="text-xs text-seal">需认证</span>
            </>
          )}
        </div>

        {/* Detect Now Button */}
        {onDetectNow && (
          <button
            onClick={onDetectNow}
            disabled={isDetecting}
            className="px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-fast focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed
              bg-paper text-ink border border-line hover:bg-card-bg hover:border-ink-faint hover:text-seal
              shadow-sm"
          >
            {isDetecting ? (
              <span className="flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                检测中
              </span>
            ) : (
              '立即检测'
            )}
          </button>
        )}

        {/* Sync All Button */}
        {onSyncAll && pendingCount > 0 && (
          <button
            onClick={onSyncAll}
            className="px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-fast focus:outline-none
              bg-seal text-white hover:bg-seal-2 active:opacity-90
              flex items-center gap-1.5 shadow-sm glow-seal"
          >
            <Activity className="w-3.5 h-3.5" />
            同步所选
          </button>
        )}
      </div>
    </div>
  );
}
