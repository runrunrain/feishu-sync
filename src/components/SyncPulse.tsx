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
    <div className="h-[48px] bg-card-bg border-b border-line flex items-center justify-between px-4 relative">
      {/* 角落水墨晕染装饰（左上） */}
      <div className="absolute -top-8 -left-8 w-24 h-24 bg-jade/10 rounded-full blur-xl pointer-events-none" />

      {/* Left: Logo（朱红印章风格）+ 标题 + 版本 */}
      <div className="flex items-center gap-3 min-w-[140px]">
        {/* 朱红印章 logo */}
        <div className="w-8 h-8 rounded-sm bg-seal flex items-center justify-center shadow-sm relative overflow-hidden">
          {/* 水墨纹理效果 */}
          <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle,rgba(255,255,255,0.3)_0%,transparent_70%)]" />
          <span className="text-white font-kai text-sm font-medium relative z-10">飞</span>
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold font-kai text-ink">飞书同步</span>
          <span className="text-[10px] text-ink-faint font-mono">v0.1.0</span>
        </div>
      </div>

      {/* Center（主状态，突出）：待同步数大字朱红 + 时间信息 */}
      <div className="flex items-center gap-4 px-5 py-2 bg-paper rounded-lg border border-line shadow-sm">
        {/* 主状态：待同步数（视觉权重最高） */}
        <div className="flex items-baseline gap-1.5">
          {pendingCount > 0 ? (
            <>
              <span className="text-2xl font-kai font-bold text-seal leading-none">{pendingCount}</span>
              <span className="text-xs text-ink-soft">篇待同步</span>
            </>
          ) : (
            <>
              <div className="w-2 h-2 rounded-sm bg-jade flex items-center justify-center">
                <CheckCircle className="w-1.5 h-1.5 text-white" strokeWidth={3} />
              </div>
              <span className="text-xs text-jade font-medium">全部已同步</span>
            </>
          )}
        </div>

        {/* 分隔线 */}
        <div className="w-px h-4 bg-line opacity-50" />

        {/* 时间信息（次要小字） */}
        <div className="flex items-center gap-3 text-xs text-ink-faint">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            上次 {formatRelativeTime(lastSyncTime)}
          </span>
          {!isDetecting && nextCheckTime && (
            <span className="flex items-center gap-1">
              {formatNextCheck(nextCheckTime)} 检测
            </span>
          )}
          {isDetecting && (
            <span className="flex items-center gap-1 text-seal">
              <RefreshCw className="w-3 h-3 animate-spin" />
              检测中
            </span>
          )}
        </div>
      </div>

      {/* Right：认证徽标 + 主操作按钮 */}
      <div className="flex items-center gap-3 min-w-[180px] justify-end">
        {/* 认证徽标（明确：已认证/未认证） */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-paper border border-line">
          {authReady ? (
            <>
              {/* 水墨青圆点 */}
              <div className="w-2 h-2 rounded-full bg-jade shadow-[0_0_6px_rgba(34,197,94,0.4)]" />
              <Wifi className="w-3.5 h-3.5 text-jade" />
              <span className="text-xs text-ink-soft font-medium">已认证</span>
            </>
          ) : (
            <>
              {/* 朱红圆点（未就绪） */}
              <div className="w-2 h-2 rounded-full bg-seal animate-pulse shadow-[0_0_6px_rgba(220,38,38,0.4)]" />
              <WifiOff className="w-3.5 h-3.5 text-seal" />
              <span className="text-xs text-seal font-medium">未认证</span>
            </>
          )}
        </div>

        {/* 立即检测按钮（朱红边框） */}
        {onDetectNow && (
          <button
            onClick={onDetectNow}
            disabled={isDetecting}
            className="px-4 py-2 text-xs font-medium rounded-md transition-all duration-fast focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed
              bg-paper text-seal border border-seal
              shadow-sm font-serif"
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

        {/* 同步全部按钮（朱红边框，仅待同步>0时显示） */}
        {onSyncAll && pendingCount > 0 && (
          <button
            onClick={onSyncAll}
            className="px-4 py-2 text-xs font-medium rounded-md transition-all duration-fast focus:outline-none
              bg-seal text-white hover:bg-seal-2 active:opacity-90
              flex items-center gap-1.5 shadow-sm glow-seal font-serif"
          >
            <Activity className="w-3.5 h-3.5" />
            同步全部
          </button>
        )}
      </div>
    </div>
  );
}
