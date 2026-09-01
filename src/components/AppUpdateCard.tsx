/**
 * AppUpdateCard - 关于与更新（T8，04 §4.3 / §7.2 #19）
 *
 * 整合原 UpdatePanel：版本号 + 检查更新 + 自启动 + 通知开关。
 * 自启动/通知开关通过 useConfig().updateConfig 写回 config.json。
 * 文案中文化。
 *
 * 2026-09 内置更新修复/重写：
 *   - 此前卡片消费的是一套与主进程分叉的旧契约（state/version/available），
 *     实际 IPC 返回 phase/latestVersion/{ok,state}，导致「检查更新」永远
 *     报「已是最新版本」、进度条从不更新。现已对齐 electron/contracts.ts
 *     的真实形状（见 src/types/index.ts 的对齐说明）。
 *   - 通过 update.onEvent 订阅主进程状态机：下载进度、available/downloaded
 *     相位变化实时驱动 UI，不再只在手动点击后拉一次快照。
 *   - 新增「打开下载页」入口（openExternal → GitHub Releases）：macOS
 *     adhoc 构建不支持应用内安装（capabilities.updateInstallSupported=false）
 *     或检查失败时，手动下载是兜底路径。
 */

import { useEffect, useState } from 'react';
import { Download, RefreshCw, CheckCircle, MonitorOff, ExternalLink, AlertCircle } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import { Button } from './common/Button';
import { Toggle } from './common/Input';
import { useConfig } from '../hooks/useConfig';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';
import type { DesktopPlatformCapabilities, DesktopUpdateState } from '../types';

// 构建时由 vite 注入（package.json version）；桌面端优先使用 Electron 返回的真实版本。
declare const __APP_VERSION__: string;

/**
 * 检查桌面更新 API 是否可用。
 *
 * dev:all 模式（vite 浏览器 / 无 Electron preload）下 `window.desktop`
 * 或 `window.desktop.update` 可能为 undefined；本卡片必须在此场景下
 * 优雅降级为只读占位，绝不触发渲染期异常导致设置区整体 ErrorBoundary
 * 降级（P1-bug-1）。
 *
 * 注意：返回值不能用 `as` 断言成恒真，否则会触发恒定条件 ESLint/TS 报错，
 * 因此返回一个真实布尔表达式。
 */
function isDesktopUpdateAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.desktop &&
    !!window.desktop.update &&
    typeof window.desktop.update.getState === 'function'
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '--';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export function AppUpdateCard() {
  const { config, updateConfig } = useConfig();
  const toast = useToast();
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [capabilities, setCapabilities] = useState<DesktopPlatformCapabilities | null>(null);
  const [checking, setChecking] = useState(false);

  const updateAvailable = isDesktopUpdateAvailable();

  // 显示版本：优先 Electron 真实版本（capabilities.appVersion / 状态机
  // currentVersion），否则构建注入版本（dev/浏览器）。
  const displayVersion = `v${capabilities?.appVersion || updateState?.currentVersion || __APP_VERSION__ || '0.0.0'}`;

  const installSupported = capabilities?.updateInstallSupported ?? false;
  const releasePageUrl = capabilities?.releasePageUrl ?? null;

  // 挂载时拉一次快照 + 订阅主进程状态机（checking → available →
  // downloading(progress) → downloaded → installing 全部由事件驱动）。
  useEffect(() => {
    if (!isDesktopUpdateAvailable()) return;
    const updateApi = window.desktop!.update;

    updateApi.getState().then(setUpdateState).catch((err) => {
      appLogger.warn('app-update', 'getState failed (non-fatal)', err);
    });
    const unsubscribe = updateApi.onEvent((event) => {
      setUpdateState(event.state);
    });

    const desktop = window.desktop!;
    if (typeof desktop.getPlatformCapabilities === 'function') {
      desktop.getPlatformCapabilities().then(setCapabilities).catch((err) => {
        appLogger.warn('app-update', 'getPlatformCapabilities failed (non-fatal)', err);
      });
    }

    return unsubscribe;
  }, []);

  const handleCheck = async () => {
    if (!isDesktopUpdateAvailable()) {
      toast.push({ type: 'warning', message: '桌面环境不可用，更新功能仅在桌面端可用' });
      return;
    }
    setChecking(true);
    try {
      const result = await window.desktop!.update.check();
      // 契约：check 返回 {ok, state}，相位在 state.phase（available /
      // up-to-date / error / unsupported）。结果状态同时会经 onEvent 到达，
      // 这里直接采信返回值保证 toast 与 UI 一致。
      setUpdateState(result.state);
      if (!result.ok) {
        if (result.state.phase === 'unsupported') {
          toast.push({ type: 'warning', message: '当前环境不支持应用内更新', hint: result.error });
        } else {
          toast.push({ type: 'error', message: '检查更新失败', hint: result.error });
        }
      } else if (result.state.phase === 'available') {
        toast.push({
          type: 'info',
          message: `发现新版本 v${result.state.latestVersion ?? ''}`,
          hint: result.state.updateInfo?.releaseNotes?.slice(0, 80),
        });
      } else {
        toast.push({ type: 'success', message: '已是最新版本' });
      }
    } catch (err) {
      appLogger.error('app-update', 'check failed', err);
      toast.push({ type: 'error', message: '检查更新失败', hint: err instanceof Error ? err.message : '' });
    } finally {
      setChecking(false);
    }
  };

  const handleDownload = async () => {
    if (!isDesktopUpdateAvailable()) return;
    try {
      // 下载进度经 onEvent（progress 事件）驱动；返回值只在失败时有意义。
      const result = await window.desktop!.update.download();
      if (!result.ok) {
        toast.push({ type: 'error', message: '下载失败', hint: result.error });
      }
    } catch (err) {
      appLogger.error('app-update', 'download failed', err);
      toast.push({ type: 'error', message: '下载失败', hint: err instanceof Error ? err.message : '' });
    }
  };

  const handleInstall = async () => {
    if (!isDesktopUpdateAvailable()) return;
    try {
      const result = await window.desktop!.update.installAndRestart();
      if (!result.ok) {
        toast.push({ type: 'error', message: '安装失败', hint: result.error });
      }
    } catch (err) {
      appLogger.error('app-update', 'install failed', err);
      toast.push({ type: 'error', message: '安装失败', hint: err instanceof Error ? err.message : '' });
    }
  };

  const handleOpenReleasePage = async () => {
    if (!isDesktopUpdateAvailable() || !releasePageUrl) {
      toast.push({ type: 'warning', message: '桌面环境不可用，无法打开发布页' });
      return;
    }
    try {
      const result = await window.desktop!.openExternal(releasePageUrl);
      if (!result.ok) {
        toast.push({ type: 'error', message: '打开发布页失败', hint: result.error });
      }
    } catch (err) {
      appLogger.error('app-update', 'open release page failed', err);
      toast.push({ type: 'error', message: '打开发布页失败', hint: err instanceof Error ? err.message : '' });
    }
  };

  const phase = updateState?.phase;
  const statusText = (() => {
    switch (phase) {
      case undefined: return '未知';
      case 'idle': return '未检查';
      case 'checking': return '检查中…';
      case 'available': return `有新版本 v${updateState?.latestVersion ?? ''}`;
      case 'downloading': return `下载中… ${Math.floor(updateState?.progress?.percent ?? 0)}%`;
      case 'downloaded': return '已下载，可安装';
      case 'installing': return '安装中…';
      case 'up-to-date': return '已是最新';
      case 'error': return '检查失败';
      case 'unsupported': return '不支持应用内更新';
      default: return '未知';
    }
  })();

  const busy = phase === 'checking' || phase === 'downloading' || phase === 'installing' || checking;

  return (
    <Card variant="default">
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-kai font-medium text-ink">关于与更新</h2>
          <StatusBadge
            status={
              phase === 'available' || phase === 'downloading' || phase === 'downloaded'
                ? 'warning'
                : phase === 'error'
                  ? 'error'
                  : 'neutral'
            }
            size="sm"
          >
            {statusText}
          </StatusBadge>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-soft">当前版本</span>
          <span className="text-sm font-mono text-seal">{displayVersion}</span>
        </div>

        {phase === 'available' && (
          <div
            role="status"
            className="rounded-md border border-seal/30 bg-seal/5 px-3 py-2.5 text-xs text-ink-soft space-y-1"
          >
            <p className="font-medium text-ink">
              新版本 v{updateState?.latestVersion} 可用
              <span className="ml-2 text-ink-faint">（当前 {displayVersion}）</span>
            </p>
            {updateState?.updateInfo?.releaseNotes && (
              <p className="leading-5 line-clamp-4 whitespace-pre-wrap">
                {updateState.updateInfo.releaseNotes.slice(0, 400)}
              </p>
            )}
          </div>
        )}

        {phase === 'downloading' && (
          <div className="space-y-1.5">
            <div className="w-full bg-paper-2 rounded-full h-2 overflow-hidden">
              <div
                className="bg-seal h-2 rounded-full transition-all"
                style={{ width: `${Math.min(100, Math.max(0, updateState?.progress?.percent ?? 0))}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-ink-faint font-sans-ui">
              <span>{Math.floor(updateState?.progress?.percent ?? 0)}%</span>
              <span>
                {formatBytes(updateState?.progress?.transferred ?? 0)} / {formatBytes(updateState?.progress?.total ?? 0)}
                {updateState?.progress?.bytesPerSecond
                  ? ` · ${(updateState.progress.bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
                  : ''}
              </span>
            </div>
          </div>
        )}

        {phase === 'downloaded' && installSupported && (
          <Button onClick={handleInstall} size="sm">
            <CheckCircle className="w-4 h-4" />
            安装并重启
          </Button>
        )}

        {phase === 'downloaded' && !installSupported && (
          <div
            role="note"
            className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-ink-soft"
          >
            <p className="font-medium text-ink">更新包已下载，但当前构建不支持应用内安装</p>
            <p className="mt-1 leading-5">
              {capabilities?.updateInstallUnsupportedReason ?? '请从发布页手动下载安装。'}
            </p>
          </div>
        )}

        {phase === 'error' && updateState?.error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-seal-2/40 bg-seal-2/5 px-3 py-2.5 text-xs text-ink-soft"
          >
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-seal-2" />
            <p className="leading-5 whitespace-pre-wrap">{updateState.error}</p>
          </div>
        )}

        {phase === 'unsupported' && updateState?.error && (
          <div
            role="status"
            className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-ink-soft"
          >
            {updateState.error}
          </div>
        )}

        {!updateAvailable && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-2 p-3 text-xs text-ink-faint bg-paper-2 border border-line rounded-md font-sans-ui"
          >
            <MonitorOff className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              桌面更新服务不可用。更新与版本检查仅在桌面端（Electron）可用；
              当前运行在浏览器或 preload 未就绪的环境下，相关功能已只读降级。
            </span>
          </div>
        )}

        {updateAvailable && (
          <div className="flex items-center gap-2">
            <Button
              variant={phase === 'available' || phase === 'downloaded' ? 'secondary' : 'primary'}
              onClick={handleCheck}
              loading={busy}
              disabled={phase === 'downloading' || phase === 'installing'}
              size="sm"
            >
              {!busy && <RefreshCw className="w-4 h-4" />}
              检查更新
            </Button>

            {phase === 'available' && installSupported && (
              <Button onClick={handleDownload} size="sm">
                <Download className="w-4 h-4" />
                下载更新
              </Button>
            )}

            {releasePageUrl && (
              <Button variant="secondary" onClick={handleOpenReleasePage} size="sm">
                <ExternalLink className="w-4 h-4" />
                打开下载页
              </Button>
            )}
          </div>
        )}

        {updateState?.lastCheckedAt && (
          <p className="text-[11px] text-ink-faint font-sans-ui">
            上次检查：{new Date(updateState.lastCheckedAt).toLocaleString()}
          </p>
        )}

        <div className="space-y-3 pt-3 border-t border-line">
          <Toggle
            label="开机自启动"
            checked={config?.enableAutoStart ?? false}
            onChange={async (v) => {
              try {
                await updateConfig({ enableAutoStart: v });
                toast.push({ type: 'success', message: v ? '已开启开机自启动' : '已关闭开机自启动' });
              } catch (err) {
                toast.push({ type: 'error', message: '设置保存失败', hint: err instanceof Error ? err.message : '' });
              }
            }}
            helperText="开机时自动启动应用"
          />
          <Toggle
            label="同步完成通知"
            checked={config?.enableNotifications ?? false}
            onChange={async (v) => {
              try {
                await updateConfig({ enableNotifications: v });
                toast.push({ type: 'success', message: v ? '已开启同步通知' : '已关闭同步通知' });
              } catch (err) {
                toast.push({ type: 'error', message: '设置保存失败', hint: err instanceof Error ? err.message : '' });
              }
            }}
            helperText="同步完成或失败时弹出系统通知"
          />
        </div>
      </CardBody>
    </Card>
  );
}
