/**
 * TopBar - 顶部条（T2 R2.1-AC1/AC2，04 §2.3）
 *
 * 高度 52px（精简自 64px）。结构：
 *   左：印章 logo + 标题
 *   中：3 主区导航（壹总览 / 贰同步 / 叁设置），楷体序号 + sans 标签
 *   右：认证徽标 + 待同步徽标
 *
 * 决策：原 6 Tab 全部并入 3 主区；日志→同步区抽屉（LogDrawer 由 SyncView 控制）；
 * 更新→设置区子卡。立即检测/同步全部迁入主区上下文操作（GlobalStatusBar / SyncView）。
 */

import { Wifi, WifiOff } from 'lucide-react';

export type MainArea = 'overview' | 'sync' | 'settings';

interface TopBarProps {
  currentArea: MainArea;
  onAreaChange: (area: MainArea) => void;
  authReady: boolean;
  pendingCount: number;
}

const NAV_ITEMS: { id: MainArea; ordinal: string; label: string }[] = [
  { id: 'overview', ordinal: '壹', label: '总览' },
  { id: 'sync', ordinal: '贰', label: '同步' },
  { id: 'settings', ordinal: '叁', label: '设置' },
];

export function TopBar({ currentArea, onAreaChange, authReady, pendingCount }: TopBarProps) {
  return (
    <header className="h-[52px] shrink-0 bg-card-bg border-b border-line flex items-center justify-between px-4">
      {/* Left: seal logo + title */}
      <div className="flex items-center gap-2.5 min-w-[140px]">
        <div className="w-8 h-8 rounded-sm bg-seal flex items-center justify-center shadow-sm">
          <span className="text-white font-kai text-sm font-medium">飞</span>
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold font-kai text-ink">飞书同步</span>
          <span className="text-[10px] text-ink-faint font-mono">v0.2.0</span>
        </div>
      </div>

      {/* Center: 3 main areas */}
      <nav className="flex items-center gap-1">
        {NAV_ITEMS.map((item) => {
          const isActive = currentArea === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onAreaChange(item.id)}
              className={`relative h-9 px-4 rounded-md flex items-center gap-2 transition-colors ${
                isActive
                  ? 'text-seal bg-[rgba(158,43,37,0.06)]'
                  : 'text-ink-soft hover:bg-paper hover:text-ink'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              <span
                className={`text-xs font-kai ${isActive ? 'text-seal' : 'text-ink-faint'}`}
              >
                {item.ordinal}
              </span>
              <span className="text-sm font-sans-ui">{item.label}</span>
              {isActive && (
                <span
                  aria-hidden
                  className="absolute -bottom-[1px] left-2 right-2 h-[2px] bg-seal rounded-full"
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Right: auth + pending badges */}
      <div className="flex items-center gap-2 min-w-[200px] justify-end">
        {pendingCount > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-seal/10 border border-seal/20">
            <span className="w-1.5 h-1.5 rounded-full bg-seal animate-pulse-seal" />
            <span className="text-xs font-sans-ui text-seal font-medium">待同步 {pendingCount}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-paper border border-line">
          {authReady ? (
            <>
              <Wifi className="w-3.5 h-3.5 text-jade" />
              <span className="text-xs text-ink-soft font-sans-ui">已认证</span>
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-seal animate-pulse-seal" />
              <WifiOff className="w-3.5 h-3.5 text-seal" />
              <span className="text-xs text-seal font-sans-ui">未认证</span>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
