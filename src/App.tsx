/**
 * App - feishu-sync 主应用（v0.2.0 P4-1 重构）
 *
 * T1 R2.5 视觉精简：删除 corner-blur/radial-gradient 双圈晕染/3xl 楷体序号；
 *                  圆角统一 6px；阴影减弱；保留印章 logo + 楷体序号（仅顶部 3 个）。
 * T2 R2.1 IA 重组：6 Tab → 3 主区（壹总览/贰同步/叁设置）+ TopBar 52px。
 * T9 R2.6 全局错误反馈：ErrorBoundary 包裹 + ToastProvider 注入 useToast。
 *
 * 不再使用：SyncPulse（信息密度低，被 GlobalStatusBar 取代）。
 */

import { useState } from 'react';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ToastProvider } from './components/common/Toast';
import { TopBar, MainArea } from './components/TopBar';
import { Dashboard } from './views/Dashboard';
import { SyncView } from './views/SyncView';
import { SettingsView } from './views/SettingsView';
import { useAuthStatus } from './hooks/useAuthStatus';
import { useSyncStatus } from './hooks/useSyncStatus';
import { SyncProvider } from './hooks/useSync';

function AppShell() {
  const [currentArea, setCurrentArea] = useState<MainArea>('overview');
  const { ready: authReady } = useAuthStatus();
  const { pendingCount } = useSyncStatus();

  const renderArea = () => {
    switch (currentArea) {
      case 'overview':
        return <Dashboard onJumpToSync={() => setCurrentArea('sync')} />;
      case 'sync':
        return <SyncView />;
      case 'settings':
        return <SettingsView />;
      default:
        return <Dashboard onJumpToSync={() => setCurrentArea('sync')} />;
    }
  };

  return (
    <div className="h-[100dvh] min-h-screen w-full overflow-hidden flex flex-col bg-paper">
      <TopBar
        currentArea={currentArea}
        onAreaChange={setCurrentArea}
        authReady={authReady}
        pendingCount={pendingCount}
      />
      {/*
        主内容区布局重构（v0.2.8）：
        - 取消 max-w-* 居中限制：宽屏下两侧大空白被取消，总览/同步区全宽铺开，
          空间让给节点树 + 文档预览主内容；设置区保留 1440px 上限维持表单可读性
        - 总览区高度收敛：Dashboard 内部按 100dvh-88px 自管三栏等高布局
      */}
      <main className="flex-1 overflow-auto scrollbar-thin">
        <div
          className={`px-4 py-4 sm:px-6 lg:px-8 ${
            currentArea === 'settings' ? 'mx-auto max-w-[1440px]' : 'w-full'
          }`}
        >
          {renderArea()}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        {/* 同步状态提升到全局，切换主区卸载 SyncView 后不丢失（后台同步继续） */}
        <SyncProvider>
          <AppShell />
        </SyncProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
