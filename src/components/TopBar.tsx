/**
 * TopBar - 顶部条（T2 R2.1-AC1/AC2，04 §2.3）
 *
 * 高度 50px。结构：
 *   左：印章 logo + 标题 + 版本号按钮
 *   中：3 主区导航（壹总览 / 贰同步 / 叁设置），楷体序号 + sans 标签
 *   右：新版本更新入口（仅在有更新时显示）
 *
 * 决策：原 6 Tab 全部并入 3 主区；TopBar 右侧与 GlobalStatusBar 信息去重，
 * 认证与待同步徽标全部下沉至 GlobalStatusBar 统一承载。
 */

import { ArrowUpCircle } from 'lucide-react';
import { AppVersionButton } from './AppVersionButton';

// 构建时由 vite 注入（package.json version），顶部栏版本徽标与「关于与更新」保持一致。
declare const __APP_VERSION__: string;

export type MainArea = 'overview' | 'sync' | 'settings';

interface TopBarProps {
  currentArea: MainArea;
  onAreaChange: (area: MainArea) => void;
  /** 有新版本时（phase === 'available' 的 latestVersion），渲染可点击的「新版本」徽标（2026-09 内置更新）。 */
  updateVersion?: string | null;
}

const NAV_ITEMS: { id: MainArea; ordinal: string; label: string }[] = [
  { id: 'overview', ordinal: '壹', label: '总览' },
  { id: 'sync', ordinal: '贰', label: '同步' },
  { id: 'settings', ordinal: '叁', label: '设置' },
];

export function TopBar({ currentArea, onAreaChange, updateVersion }: TopBarProps) {
  return (
    <header className="h-[50px] shrink-0 min-w-0 bg-card-bg border-b border-line flex items-center justify-between gap-3 px-4 lg:px-8">
      {/*
        布局优化：
        - 高度压缩至 50px，给主视口让渡垂直空间
        - 去除右侧与 GlobalStatusBar 重复的认证与待同步徽标，只保留新版本更新入口
      */}
      {/* Left: seal logo + title + version button */}
      <div className="flex min-w-0 items-center gap-3 lg:min-w-[170px]">
        <div className="w-8 h-8 rounded-sm bg-seal flex items-center justify-center shadow-sm transition-transform duration-200 hover:scale-105 hover:shadow-md shrink-0">
          <span className="text-white font-kai text-sm font-medium leading-none">飞</span>
        </div>
        <div className="flex min-w-0 flex-col leading-tight gap-0.5 justify-center">
          <span className="truncate text-sm font-semibold font-kai text-ink">飞书同步</span>
          <div className="flex items-center">
            <AppVersionButton onJumpToSettings={() => onAreaChange('settings')} />
          </div>
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
              className={`relative h-9 px-2.5 sm:px-3 lg:px-5 rounded-md flex items-center gap-1.5 lg:gap-2 transition-colors duration-150 ${
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

      {/* Right: action items (only updates to avoid duplication with GlobalStatusBar) */}
      <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 lg:min-w-[170px]">
        {updateVersion ? (
          <button
            type="button"
            onClick={() => onAreaChange('settings')}
            title="发现新版本，点击前往设置查看"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-jade/10 border border-jade/25 hover:bg-jade/20 transition-colors"
          >
            <ArrowUpCircle className="w-3.5 h-3.5 text-jade" />
            <span className="text-xs font-sans-ui text-jade font-medium">新版本 v{updateVersion}</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}
