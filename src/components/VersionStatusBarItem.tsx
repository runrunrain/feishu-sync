/**
 * VersionStatusBarItem - 总览页状态栏版本更新快捷入口
 *
 * 挂载在 GlobalStatusBar 中：
 *   - 常驻显示当前版本号（如 v0.3.7）
 *   - 根据版本号对比与更新状态机动态演变：
 *     - 发现新版本：亮起印章色徽标，提示「可更新至 v0.3.8」，点击直达设置更新页
 *     - 下载中/已就绪：实时提示进度与就绪状态
 *     - 最新/空闲：点击触发快速检查更新，并根据版本号状态弹出 Toast 提示
 */

import { useState } from 'react';
import {
  ArrowUpCircle,
  CheckCircle,
  Download,
  RefreshCw,
  Tag,
  AlertCircle,
  ShieldCheck,
} from 'lucide-react';
import { useDesktopUpdate } from '../hooks/useDesktopUpdate';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';

interface VersionStatusBarItemProps {
  /** 点击跳转到设置区对应 tab（通常为 'application'） */
  onJumpToSettings?: (tab?: 'application') => void;
  className?: string;
}

export function VersionStatusBarItem({ onJumpToSettings, className = '' }: VersionStatusBarItemProps) {
  const toast = useToast();
  const {
    currentVersion,
    phase,
    isChecking,
    isDownloading,
    isInstalling,
    isSupported,
    versionTip,
    checkUpdate,
    installAndRestart,
  } = useDesktopUpdate();

  const [localChecking, setLocalChecking] = useState(false);

  const handleClick = async () => {
    // 1. 如果已下载就绪，支持直接在总览页一键安装并重启
    if (phase === 'downloaded') {
      try {
        toast.push({
          type: 'info',
          message: `正在准备安装 ${versionTip.displayLatestVersion}…`,
          hint: '应用将自动重启以应用新版本',
        });
        const res = await installAndRestart();
        if (res && !res.ok) {
          toast.push({
            type: 'error',
            message: '安装更新失败',
            hint: res.error,
          });
          onJumpToSettings?.('application');
        }
      } catch (err) {
        appLogger.error('version-status-bar', 'installAndRestart failed', err);
        onJumpToSettings?.('application');
      }
      return;
    }

    // 2. 如果检测到了新版本或正在下载，快捷跳转到设置页「关于与更新」查看详情与操作
    if (phase === 'available' || phase === 'downloading') {
      onJumpToSettings?.('application');
      return;
    }

    // 3. 如果不支持应用内更新（如浏览器开发环境或未打包构建）
    if (!isSupported) {
      toast.push({
        type: 'info',
        message: `当前版本 ${currentVersion}`,
        hint: '浏览器/开发环境中应用内更新不可用，可查看发布页',
      });
      onJumpToSettings?.('application');
      return;
    }

    // 4. 其他情况（idle / up-to-date / error）：快捷触发一次检查更新
    setLocalChecking(true);
    toast.push({
      type: 'info',
      message: `正在检查更新 (${currentVersion})…`,
      hint: '正在连接服务器比对最新版本',
    });

    try {
      const res = await checkUpdate();
      if (!res) {
        toast.push({
          type: 'warning',
          message: `更新检查未完成 (${currentVersion})`,
          hint: '更新服务不可用或未初始化',
        });
        return;
      }

      if (res.ok) {
        const nextState = res.state;
        if (nextState.phase === 'available') {
          const lat = nextState.latestVersion ? `v${nextState.latestVersion.replace(/^v/, '')}` : '新版本';
          toast.push({
            type: 'success',
            message: `发现新版本 ${lat}！`,
            hint: `当前版本为 ${currentVersion}，点击可前往更新`,
          });
        } else if (nextState.phase === 'up-to-date') {
          toast.push({
            type: 'success',
            message: `当前已是最新版本 (${currentVersion})`,
          });
        }
      } else {
        toast.push({
          type: 'error',
          message: '检查更新失败',
          hint: res.error,
        });
      }
    } catch (err) {
      appLogger.error('version-status-bar', 'manual check failed', err);
      toast.push({
        type: 'error',
        message: '检查更新发生异常',
        hint: err instanceof Error ? err.message : '',
      });
    } finally {
      setLocalChecking(false);
    }
  };

  const busy = isChecking || localChecking || isDownloading || isInstalling;

  // 渲染图标
  const renderIcon = () => {
    if (busy || phase === 'checking') {
      return <RefreshCw className="w-3.5 h-3.5 text-seal animate-spin shrink-0" />;
    }
    if (phase === 'downloading') {
      return <Download className="w-3.5 h-3.5 text-seal animate-bounce shrink-0" />;
    }
    if (phase === 'downloaded') {
      return <CheckCircle className="w-3.5 h-3.5 text-jade shrink-0" />;
    }
    if (phase === 'available') {
      return <ArrowUpCircle className="w-3.5 h-3.5 text-seal animate-pulse-seal shrink-0" />;
    }
    if (phase === 'error') {
      return <AlertCircle className="w-3.5 h-3.5 text-seal-2 shrink-0" />;
    }
    if (phase === 'up-to-date') {
      return <ShieldCheck className="w-3.5 h-3.5 text-jade shrink-0" />;
    }
    return <Tag className="w-3.5 h-3.5 text-ink-faint group-hover:text-seal shrink-0 transition-colors" />;
  };

  // 样式微调
  const getContainerStyle = () => {
    if (phase === 'available') {
      return 'border-seal/40 bg-seal/5 hover:bg-seal/10 text-seal font-medium shadow-xs';
    }
    if (phase === 'downloaded') {
      return 'border-jade/40 bg-jade/5 hover:bg-jade/10 text-jade font-medium shadow-xs';
    }
    if (phase === 'downloading') {
      return 'border-seal/30 bg-paper-2 hover:bg-paper text-seal font-medium';
    }
    if (phase === 'error') {
      return 'border-seal-2/30 bg-seal-2/5 hover:bg-seal-2/10 text-ink-soft';
    }
    return 'border-line/70 bg-paper hover:bg-paper-2 text-ink-soft hover:border-line hover:text-ink';
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy && phase !== 'downloading'}
      title={versionTip.tooltip}
      aria-label={`版本与更新：${versionTip.statusText}`}
      className={`group relative inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border font-sans-ui transition-all select-none cursor-pointer disabled:cursor-not-allowed ${getContainerStyle()} ${className}`}
    >
      {renderIcon()}

      <span className="font-mono text-xs tracking-tight">
        {versionTip.shortLabel}
      </span>

      {/* 新版本呼吸小红点 */}
      {phase === 'available' && (
        <span
          aria-hidden="true"
          className="w-1.5 h-1.5 rounded-full bg-seal animate-pulse-seal"
        />
      )}

      {/* 升级类型小标签（如功能更新/修复补丁） */}
      {phase === 'available' && versionTip.upgradeKindLabel && (
        <span className="hidden sm:inline-block ml-0.5 rounded px-1 py-0.2 text-[10px] bg-seal/15 text-seal">
          {versionTip.upgradeKindLabel}
        </span>
      )}
    </button>
  );
}
