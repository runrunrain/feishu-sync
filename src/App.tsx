/**
 * Main Application Component
 * 中国风水墨布局：顶部 Tab 导航（楷体序号+宋体标签+朱红active）+ 融合状态条 + 全宽内容区（宣纸卡片）
 */

import { useState, useMemo } from 'react';
import {
  RefreshCw,
  Home,
  Activity,
  GitCompare,
  ScrollText,
  SlidersHorizontal,
  DownloadCloud,
  Clock,
  Wifi,
  WifiOff,
  CheckCircle,
} from 'lucide-react';

// Views
import { ConfigPanel } from './components/ConfigPanel';
import { AuthStatus } from './components/AuthStatus';
import { ChangeList } from './components/ChangeList';
import { SyncPanel } from './components/SyncPanel';
import { LogViewer } from './components/LogViewer';
import { UpdatePanel } from './components/UpdatePanel';
import { useChanges } from './hooks/useChanges';
import { useAuthStatus } from './hooks/useAuthStatus';
import { useSyncStatus } from './hooks/useSyncStatus';
import { useConfig } from './hooks/useConfig';
import { isUsableWikiUrl, isValidFeishuWikiUrl, pickFirstValidWikiUrl } from './utils/wikiUrl';

type ViewType = 'home' | 'changes' | 'sync' | 'config' | 'logs' | 'updates';

interface NavItem {
  id: ViewType;
  label: string;
  labelZh: string; // 中文标签
  icon?: React.ComponentType<{ className?: string }>;
  shortcut?: string;
}

const navItems: NavItem[] = [
  { id: 'home', label: 'Home', labelZh: '首页', icon: Home, shortcut: 'H' },
  { id: 'changes', label: 'Changes', labelZh: '变更', icon: GitCompare, shortcut: 'C' },
  { id: 'sync', label: 'Sync', labelZh: '同步', icon: Activity, shortcut: 'S' },
  { id: 'config', label: 'Config', labelZh: '配置', icon: SlidersHorizontal, shortcut: ',' },
  { id: 'logs', label: 'Logs', labelZh: '日志', icon: ScrollText, shortcut: 'L' },
  { id: 'updates', label: 'Updates', labelZh: '更新', icon: DownloadCloud, shortcut: 'U' },
];

// 楷体序号
const navNumbers: string[] = ['壹', '贰', '叁', '肆', '伍', '陆'];

function App() {
  const [currentView, setCurrentView] = useState<ViewType>('home');
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);

  // Use changes hook to get available documents
  const { changes, detect } = useChanges();
  const { ready: authReady } = useAuthStatus();
  const { pendingCount, lastSyncTime, nextCheckTime, isDetecting } = useSyncStatus();
  // B4 fix: drive top-bar 立即检测 off the configured watched root URL.
  const { config } = useConfig();
  const activeRootUrl = pickFirstValidWikiUrl(config?.watchedRootUrls);
  const rootUrlUnconfigured =
    !activeRootUrl && (config?.watchedRootUrls?.length ?? 0) === 0;
  const rootUrlInvalid =
    !activeRootUrl && (config?.watchedRootUrls?.length ?? 0) > 0;
  const detectTooltip = rootUrlUnconfigured
    ? '请先在设置中配置飞书根 URL（形如 https://xxx.feishu.cn/wiki/<token>）'
    : rootUrlInvalid
      ? '配置的飞书根 URL 格式无效，请在设置中改为形如 https://xxx.feishu.cn/wiki/<token> 的地址'
      : '';

  // Get selected documents for sync based on selected tokens
  const selectedDocuments = useMemo(() => {
    return changes.filter(doc => selectedTokens.includes(doc.objToken));
  }, [changes, selectedTokens]);

  const handleSelectionChange = (tokens: string[]) => {
    setSelectedTokens(tokens);
  };

  const handleDetectNow = () => {
    // B4 fix: never invoke detect(''); fall through silently when URL is
    // missing/invalid because the button itself is disabled.
    if (!isUsableWikiUrl(activeRootUrl)) return;
    detect(activeRootUrl);
  };

  const handleSyncAll = () => {
    setSelectedTokens(changes.map(doc => doc.objToken));
    setCurrentView('sync');
  };

  // Format relative time for display
  const formatRelativeTime = (timestamp: number | null): string => {
    if (!timestamp) return '--';
    const now = Date.now();
    const diff = Math.floor((now - timestamp) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return `${Math.floor(diff / 86400)} 天前`;
  };

  const renderView = () => {
    switch (currentView) {
      case 'home':
        return (
          <div className="space-y-6">
            <div className="bg-card-bg border border-line rounded-lg p-6 shadow-sm relative overflow-hidden">
              {/* 角落水墨晕染装饰 */}
              <div className="absolute -top-10 -left-10 w-32 h-32 bg-jade/10 rounded-full blur-xl pointer-events-none" />
              <h2 className="text-xl font-kai font-medium text-ink mb-2">飞书同步</h2>
              <p className="text-ink-soft leading-relaxed">
                本地云知识库镜像。检测变更、同步文档、保持知识库最新。
              </p>
            </div>
            <AuthStatus />
          </div>
        );
      case 'changes':
        return (
          <div className="space-y-6">
            <AuthStatus />
            <ChangeList
              selectedTokens={selectedTokens}
              onSelectionChange={handleSelectionChange}
            />
          </div>
        );
      case 'sync':
        return <SyncPanel selectedDocuments={selectedDocuments} />;
      case 'config':
        return <ConfigPanel />;
      case 'logs':
        return <LogViewer />;
      case 'updates':
        return <UpdatePanel />;
      default:
        return <ConfigPanel />;
    }
  };

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-paper">
      {/* 顶部条：Logo + 标题 + 版本 | Tab导航 | 状态+操作（约64px） */}
      <header className="h-[64px] bg-card-bg border-b border-line flex items-center justify-between px-4 relative shrink-0">
        {/* 角落水墨晕染装饰（左上） */}
        <div className="absolute -top-8 -left-8 w-24 h-24 bg-jade/10 rounded-full blur-xl pointer-events-none" />

        {/* 左侧：Logo（朱红印章）+ 标题 + 版本 */}
        <div className="flex items-center gap-3 min-w-[140px]">
          {/* 朱红印章 logo */}
          <div className="w-9 h-9 rounded-sm bg-seal flex items-center justify-center shadow-sm relative overflow-hidden">
            {/* 水墨纹理效果 */}
            <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle,rgba(255,255,255,0.3)_0%,transparent_70%)]" />
            <span className="text-white font-kai text-base font-medium relative z-10">飞</span>
          </div>
          <div className="flex flex-col">
            <span className="text-base font-semibold font-kai text-ink">飞书同步</span>
            <span className="text-[10px] text-ink-faint font-mono">v0.1.0</span>
          </div>
        </div>

        {/* 中间：Tab 导航（6个） */}
        <nav className="flex items-center gap-1 mx-4">
          {navItems.map((item, index) => {
            const isActive = currentView === item.id;
            const navNum = navNumbers[index] || (index + 1).toString();

            return (
              <button
                key={item.id}
                onClick={() => setCurrentView(item.id)}
                className={`
                  h-10 px-4 rounded-t-md flex items-center gap-2 transition-all duration-fast relative
                  ${isActive
                    ? 'text-seal bg-[rgba(158,43,37,0.04)]'
                    : 'text-ink-soft hover:bg-paper hover:text-ink'
                  }
                `}
              >
                {/* 楷体序号（朱红小字） */}
                <span className={`text-xs font-kai ${isActive ? 'text-seal' : 'text-ink-faint'}`}>
                  {navNum}
                </span>
                {/* 中文标签（宋体） */}
                <span className="text-sm font-serif">{item.labelZh}</span>
                {/* Active indicator: 朱红下划线 */}
                {isActive && (
                  <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-seal rounded-t-sm" />
                )}
              </button>
            );
          })}
        </nav>

        {/* 右侧：状态徽标 + 操作按钮 */}
        <div className="flex items-center gap-3 min-w-[200px] justify-end">
          {/* 待同步徽标（朱红小圆+数字） */}
          {pendingCount > 0 && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-seal/10 border border-seal/20">
              <div className="w-2 h-2 rounded-full bg-seal animate-pulse shadow-[0_0_6px_rgba(158,43,37,0.4)]" />
              <span className="text-xs font-kai font-medium text-seal">{pendingCount}</span>
            </div>
          )}

          {/* 认证徽标 */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-paper border border-line">
            {authReady ? (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-jade shadow-[0_0_6px_rgba(107,142,138,0.5)]" />
                <Wifi className="w-3.5 h-3.5 text-jade" />
                <span className="text-xs text-ink-soft font-medium">已认证</span>
              </>
            ) : (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-seal animate-pulse shadow-[0_0_6px_rgba(158,43,37,0.4)]" />
                <WifiOff className="w-3.5 h-3.5 text-seal" />
                <span className="text-xs text-seal font-medium">未认证</span>
              </>
            )}
          </div>

          {/* 立即检测按钮（朱红边框）—— B4 fix: 禁用当根 URL 未配置或格式无效 */}
          <button
            onClick={handleDetectNow}
            disabled={isDetecting || !isValidFeishuWikiUrl(activeRootUrl)}
            title={detectTooltip}
            className="px-4 py-2 text-xs font-medium rounded-md transition-all duration-fast focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed
              bg-paper text-seal border border-seal hover:bg-seal/5 active:bg-seal/10
              shadow-sm font-serif whitespace-nowrap"
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

          {/* 同步全部按钮（朱红填充，仅待同步>0时显示） */}
          {pendingCount > 0 && (
            <button
              onClick={handleSyncAll}
              className="px-4 py-2 text-xs font-medium rounded-md transition-all duration-fast focus:outline-none
                bg-seal text-white hover:bg-seal-2 active:opacity-90
                flex items-center gap-1.5 shadow-sm glow-seal font-serif whitespace-nowrap"
            >
              <Activity className="w-3.5 h-3.5" />
              同步全部
            </button>
          )}
        </div>
      </header>

      {/* 主内容区（全宽，无侧导航） */}
      <main className="flex-1 overflow-auto scrollbar-thin">
        <div className="max-w-6xl mx-auto p-6">
          {/* 视图标题区（全宽，左对齐） */}
          <div className="mb-6">
            <div className="flex items-baseline gap-3 mb-2">
              {/* 楷体序号 */}
              <span className="text-3xl font-kai text-seal">
                {navNumbers[navItems.findIndex(item => item.id === currentView)] || '壹'}
              </span>
              <h1 className="text-2xl font-kai font-medium text-ink">
                {navItems.find(item => item.id === currentView)?.labelZh || '飞书同步'}
              </h1>
            </div>
            <p className="text-sm text-ink-soft mt-1">
              {currentView === 'home' && '飞书同步本地镜像，保持知识库最新'}
              {currentView === 'changes' && '检测并选择需要同步的文档'}
              {currentView === 'sync' && '将选中的文档同步到本地'}
              {currentView === 'config' && '配置同步设置与偏好'}
              {currentView === 'logs' && '查看应用日志与调试信息'}
              {currentView === 'updates' && '检查应用更新'}
            </p>
            {/* 时间信息（次要） */}
            {(currentView === 'home' || currentView === 'changes') && (
              <div className="flex items-center gap-3 mt-2 text-xs text-ink-faint">
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  上次 {formatRelativeTime(lastSyncTime)}
                </span>
                {!isDetecting && nextCheckTime && (
                  <span>下次 {formatRelativeTime(nextCheckTime)} 检测</span>
                )}
                {isDetecting && (
                  <span className="flex items-center gap-1 text-seal">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    检测中
                  </span>
                )}
              </div>
            )}
          </div>

          {/* 视图内容 */}
          {renderView()}
        </div>
      </main>
    </div>
  );
}

export default App;
