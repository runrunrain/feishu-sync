/**
 * AppVersionButton - 左上角版本号快捷操作按钮
 *
 * 嵌入在 TopBar 左上角应用标题下方：
 *   - 平时为紧凑精致的版本号标签（如 v0.3.8），hover 轻微高亮并提示状态与检查更新；
 *   - 点击时：
 *     - 若有新版本或下载中：一键直达设置更新页；
 *     - 若已下载就绪：一键提示安装重启；
 *     - 若已是最新/空闲：快速触发一次云端检查更新并弹出 Toast 反馈；
 *   - 新版本可用时：亮起印章色徽标与呼吸点，提示「可更新至 v0.3.9」。
 */

import { useState } from 'react';
import {
  ArrowUpCircle,
  CheckCircle,
  Download,
  RefreshCw,
  ShieldCheck,
  AlertCircle,
} from 'lucide-react';
import { useDesktopUpdate } from '../hooks/useDesktopUpdate';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';

interface AppVersionButtonProps {
  onJumpToSettings?: (tab?: 'application') => void;
  className?: string;
}

export function AppVersionButton({ onJumpToSettings, className = '' }: AppVersionButtonProps) {
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
    // 1. 若已下载就绪，支持直接一键安装重启
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
        appLogger.error('app-version-btn', 'installAndRestart failed', err);
        onJumpToSettings?.('application');
      }
      return;
    }

    // 2. 若检测到了新版本或正在下载，快捷直达设置页更新卡片
    if (phase === 'available' || phase === 'downloading') {
      onJumpToSettings?.('application');
      return;
    }

    // 3. 若环境不支持应用内更新（如未打包或开发浏览器环境）
    if (!isSupported) {
      toast.push({
        type: 'info',
        message: `当前版本 ${currentVersion}`,
        hint: '浏览器/开发环境中应用内更新不可用，可查看发布页',
      });
      onJumpToSettings?.('application');
      return;
    }

    // 4. 其他状态（idle / up-to-date / error）：快捷触发检查更新
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
      appLogger.error('app-version-btn', 'manual check failed', err);
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

  // 图标
  const renderIcon = () => {
    if (busy || phase === 'checking') {
      return <RefreshCw className="w-2.5 h-2.5 text-seal animate-spin shrink-0" />;
    }
    if (phase === 'downloading') {
      return <Download className="w-2.5 h-2.5 text-seal animate-bounce shrink-0" />;
    }
    if (phase === 'downloaded') {
      return <CheckCircle className="w-2.5 h-2.5 text-jade shrink-0" />;
    }
    if (phase === 'available') {
      return <ArrowUpCircle className="w-2.5 h-2.5 text-seal animate-pulse-seal shrink-0" />;
    }
    if (phase === 'error') {
      return <AlertCircle className="w-2.5 h-2.5 text-seal-2 shrink-0" />;
    }
    if (phase === 'up-to-date') {
      return <ShieldCheck className="w-2.5 h-2.5 text-jade/70 shrink-0" />;
    }
    return null;
  };

  // 样式微调
  const getStyle = () => {
    if (phase === 'available') {
      return 'border-seal/40 bg-seal/10 text-seal hover:bg-seal/15 font-medium shadow-xs';
    }
    if (phase === 'downloaded') {
      return 'border-jade/40 bg-jade/10 text-jade hover:bg-jade/15 font-medium shadow-xs';
    }
    if (phase === 'downloading') {
      return 'border-seal/30 bg-seal/5 text-seal hover:bg-seal/10';
    }
    if (phase === 'error') {
      return 'border-seal-2/30 bg-seal-2/5 text-seal-2 hover:bg-seal-2/10';
    }
    return 'border-transparent text-ink-faint hover:text-seal hover:bg-paper-2 hover:border-line';
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy && phase !== 'downloading'}
      title={`${versionTip.tooltip}\n（点击检查更新或查看详情）`}
      aria-label={`版本号及更新状态：${versionTip.statusText}`}
      className={`group relative inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-mono leading-none rounded border transition-all select-none cursor-pointer disabled:cursor-not-allowed ${getStyle()} ${className}`}
    >
      {renderIcon()}
      <span className="tracking-tight">
        {phase === 'available'
          ? `可更新至 ${versionTip.displayLatestVersion}`
          : versionTip.displayCurrentVersion}
      </span>
      {phase === 'available' && (
        <span
          aria-hidden="true"
          className="w-1.5 h-1.5 rounded-full bg-seal animate-pulse-seal ml-0.5"
        />
      )}
    </button>
  );
}
