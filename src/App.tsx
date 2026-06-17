/**
 * Main Application Component
 * 中国风水墨布局：左导航（楷体序号+宋体标签+朱红active）+ 顶部朱红印章状态条 + 主内容区（宣纸卡片）
 */

import { useState, useMemo } from 'react';
import {
  FileSearch,
  RefreshCw,
  Settings,
  FileText,
  Cloud,
  Home,
  Activity,
  GitCompare,
  ScrollText,
  SlidersHorizontal,
  DownloadCloud,
} from 'lucide-react';

// Views
import { ConfigPanel } from './components/ConfigPanel';
import { AuthStatus } from './components/AuthStatus';
import { ChangeList } from './components/ChangeList';
import { SyncPanel } from './components/SyncPanel';
import { LogViewer } from './components/LogViewer';
import { UpdatePanel } from './components/UpdatePanel';
import { SyncPulse } from './components/SyncPulse';
import { useChanges } from './hooks/useChanges';
import { useAuthStatus } from './hooks/useAuthStatus';

type ViewType = 'home' | 'changes' | 'sync' | 'config' | 'logs' | 'updates';

interface NavItem {
  id: ViewType;
  label: string;
  labelZh: string; // 中文标签
  icon: React.ComponentType<{ className?: string }>;
  shortcut?: string;
}

const navItems: NavItem[] = [
  { id: 'home', label: 'Home', labelZh: '首页', icon: Home, shortcut: 'H' },
  { id: 'changes', label: 'Changes', labelZh: '变更', icon: GitCompare, shortcut: 'C' },
  { id: 'sync', label: 'Sync', labelZh: '同步', icon: RefreshCw, shortcut: 'S' },
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

  // Get selected documents for sync based on selected tokens
  const selectedDocuments = useMemo(() => {
    return changes.filter(doc => selectedTokens.includes(doc.objToken));
  }, [changes, selectedTokens]);

  const handleSelectionChange = (tokens: string[]) => {
    setSelectedTokens(tokens);
  };

  const handleDetectNow = () => {
    detect('');
  };

  const handleSyncAll = () => {
    setSelectedTokens(changes.map(doc => doc.objToken));
    setCurrentView('sync');
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
    <div className="h-screen w-screen overflow-hidden flex flex-col">
      {/* Sync Pulse - 朱红印章状态条 48px */}
      <SyncPulse
        onDetectNow={handleDetectNow}
        onSyncAll={handleSyncAll}
        authReady={authReady}
      />

      {/* Main Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Icon Navigation - 168px icon + 中文标签直接显示 */}
        <nav className="w-[168px] bg-card-bg border-r border-line flex flex-col py-3 gap-1 flex-shrink-0">
          {/* Logo area */}
          <div className="px-3 mb-3 flex items-center gap-2">
            <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-paper border border-line">
              <Activity className="w-4 h-4 text-seal" strokeWidth={2.5} />
            </div>
            <span className="text-sm font-semibold font-kai text-ink">飞书同步</span>
          </div>

          <div className="px-3 mb-3 h-px bg-line opacity-60" />

          {/* Navigation items - icon + 中文标签直接显示 */}
          {navItems.map((item, index) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            const navNum = navNumbers[index] || (index + 1).toString();

            return (
              <button
                key={item.id}
                onClick={() => setCurrentView(item.id)}
                className={`
                  mx-2 h-10 px-3 rounded-lg flex items-center gap-2 transition-all duration-fast relative
                  ${isActive
                    ? 'text-seal border-l-4 border-l-seal'
                    : 'text-ink-soft hover:bg-paper hover:text-ink'
                  }
                `}
                style={isActive ? { backgroundColor: 'rgba(158, 43, 37, 0.05)' } : undefined}
              >
                {/* 楷体序号（朱红小字） */}
                <span className={`text-xs font-kai ${isActive ? 'text-seal' : 'text-ink-faint'}`}>
                  {navNum}
                </span>
                <Icon className="w-4 h-4 flex-shrink-0" />
                {/* 中文标签（宋体） */}
                <span className="text-sm font-serif">{item.labelZh}</span>
                {/* Active indicator - 朱红左边框已通过 border-l 实现 */}
              </button>
            );
          })}

          <div className="flex-1" />

          {/* Settings at bottom - icon + 标签 */}
          <button
            onClick={() => setCurrentView('config')}
            className={`mx-2 mb-2 h-10 px-3 rounded-lg flex items-center gap-2 transition-all duration-fast relative
              ${currentView === 'config'
                ? 'text-seal border-l-4 border-l-seal'
                : 'text-ink-soft hover:bg-paper hover:text-ink'
              }
            `}
            style={currentView === 'config' ? { backgroundColor: 'rgba(158, 43, 37, 0.05)' } : undefined}
          >
            <SlidersHorizontal className="w-4 h-4 flex-shrink-0" />
            <span className="text-sm font-serif">配置</span>
          </button>
        </nav>

        {/* Main Content Area */}
        <main className="flex-1 overflow-auto scrollbar-thin">
          <div className="max-w-content mx-auto p-6">
            {/* View Header */}
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
                {currentView === 'changes' && '检测并选择需要同步的文档'}
                {currentView === 'sync' && '将选中的文档同步到本地'}
                {currentView === 'config' && '配置同步设置与偏好'}
                {currentView === 'logs' && '查看应用日志与调试信息'}
                {currentView === 'updates' && '检查应用更新'}
              </p>
            </div>

            {/* View Content */}
            {renderView()}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
