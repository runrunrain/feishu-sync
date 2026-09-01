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
import { useDesktopUpdateBadge } from './hooks/useDesktopUpdate';
import { SyncProvider } from './hooks/useSync';

function AppShell() {
  const [currentArea, setCurrentArea] = useState<MainArea>('overview');
  const { ready: authReady } = useAuthStatus();
  const { pendingCount } = useSyncStatus();
  // 全局新版本徽标（仅桌面端；启动时主进程会静默检查一次更新）。
  const { availableVersion } = useDesktopUpdateBadge();

  return (
    <div className="h-[100dvh] min-h-screen w-full overflow-hidden flex flex-col bg-paper">
      <TopBar
        currentArea={currentArea}
        onAreaChange={setCurrentArea}
        authReady={authReady}
        pendingCount={pendingCount}
        updateVersion={availableVersion}
      />
      {/*
        主内容区布局（v0.2.9 常驻挂载重构）：
        - 三个主区全部常驻挂载，切换仅 hidden 隐藏、不卸载——此前切走再切回
          会丢失 SyncView 本地状态（diff 列表、勾选项、同步进度/结果的前端
          展示），同步虽在后台继续（SyncProvider 全局态），界面却被重置；
          常驻后同步过程的进度条、结果报告在往返切换后原样保留
        - 取消 max-w-* 居中限制：宽屏下两侧大空白被取消；设置区保留
          1440px 上限维持表单可读性
        - 注意：隐藏主区的 window 级交互（如 NodeTreeView 的 ↑/↓ 键盘
          导航）需各自以 offsetParent 可见性门控，避免后台响应按键
      */}
      <main className="flex-1 overflow-auto scrollbar-thin">
        <div
          className={`px-4 py-4 sm:px-6 lg:px-8 ${
            currentArea === 'settings' ? 'mx-auto max-w-[1440px]' : 'w-full'
          }`}
        >
          <div className={currentArea === 'overview' ? 'animate-fade-in' : 'hidden'}>
            <Dashboard onJumpToSync={() => setCurrentArea('sync')} />
          </div>
          <div className={currentArea === 'sync' ? 'animate-fade-in' : 'hidden'}>
            {/* active 标记主区是否可见：同步区常驻挂载（v0.2.9），但变为
                可见时需重读后端持久化 diff（服务端 PollingScheduler 定时
                检测没有客户端事件，列表/待处理可能已过期） */}
            <SyncView active={currentArea === 'sync'} />
          </div>
          <div className={currentArea === 'settings' ? 'animate-fade-in' : 'hidden'}>
            {/* focusTabId：点 TopBar「新版本」徽标时直达「应用 · 关于与更新」 */}
            <SettingsView focusTabId={availableVersion ? 'application' : undefined} />
          </div>
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
