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

// 构建时由 vite 注入（package.json version），顶部栏版本徽标与「关于与更新」保持一致。
declare const __APP_VERSION__: string;

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
    <header className="h-[56px] shrink-0 min-w-0 bg-card-bg border-b border-line flex items-center justify-between gap-3 px-4 lg:px-8">
      {/*
        布局重构（2026-06-19）：
        - 高度 52→56px：logo 32px + 内容呼吸，避免与 12px 楷体序号挤压
        - 左右 padding 16→24/32px（lg），主区导航不再贴边
        - nav gap-1→gap-2，主区按钮之间留呼吸
      */}
      {/* Left: seal logo + title */}
      <div className="flex min-w-0 items-center gap-3 lg:min-w-[160px]">
        <div className="w-9 h-9 rounded-sm bg-seal flex items-center justify-center shadow-sm transition-transform duration-200 hover:scale-105 hover:shadow-md">
          <span className="text-white font-kai text-base font-medium leading-none">飞</span>
        </div>
        <div className="flex min-w-0 flex-col leading-tight gap-0.5">
          <span className="truncate text-sm font-semibold font-kai text-ink">飞书同步</span>
          <span className="hidden text-[10px] text-ink-faint font-mono lg:block">v{__APP_VERSION__}</span>
        </div>
      </div>

      {/* Center: 3 main areas */}
      <nav className="flex shrink-0 items-center gap-0.5 lg:gap-1.5">
        {NAV_ITEMS.map((item) => {
          const isActive = currentArea === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onAreaChange(item.id)}
              className={`relative h-10 px-2.5 sm:px-3 lg:px-5 rounded-md flex items-center gap-1.5 lg:gap-2 transition-colors duration-150 ${
                isActive
                  ? 'text-seal bg-[rgba(158,43,37,0.06)]'
                  : 'text-ink-soft hover:bg-paper hover:text-ink active:bg-paper-2'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              <span
                className={`hidden text-sm font-kai lg:inline transition-colors ${isActive ? 'text-seal' : 'text-ink-faint'}`}
              >
                {item.ordinal}
              </span>
              <span className="whitespace-nowrap text-sm font-sans-ui">{item.label}</span>
              {/* 激活下划线常驻渲染，用 scaleX 做过渡，切换主区时平滑滑入 */}
              <span
                aria-hidden
                className={`absolute -bottom-[1px] left-3 right-3 h-[2px] bg-seal rounded-full transition-transform duration-200 origin-center ${
                  isActive ? 'scale-x-100' : 'scale-x-0'
                }`}
              />
            </button>
          );
        })}
      </nav>

      {/* Right: auth + pending badges */}
      <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 lg:min-w-[220px] lg:gap-3">
        {pendingCount > 0 && (
          <div className="hidden items-center gap-1.5 px-2.5 py-1 rounded-full bg-seal/10 border border-seal/20 lg:flex">
            <span className="w-1.5 h-1.5 rounded-full bg-seal animate-pulse-seal" />
            <span className="text-xs font-sans-ui text-seal font-medium">待同步 {pendingCount}</span>
          </div>
        )}
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-paper border border-line lg:px-3">
          {authReady ? (
            <>
              <Wifi className="w-3.5 h-3.5 text-jade" />
              <span className="hidden text-xs text-ink-soft font-sans-ui sm:inline">已认证</span>
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-seal animate-pulse-seal" />
              <WifiOff className="w-3.5 h-3.5 text-seal" />
              <span className="hidden text-xs text-seal font-sans-ui sm:inline">未认证</span>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
