/**
 * VersionUpdateAlert - 总览页版本更新提示横幅
 *
 * 当主进程检测到新版本（phase 为 available / downloading / downloaded）时，
 * 在总览页顶部醒目展示：
 *   - 清晰对比展示：当前版本号 vs 最新版本号
 *   - 自动标识版本升级类型（重大更新 / 功能更新 / 修复补丁）
 *   - 呈现版本更新摘要（Release Notes）
 *   - 提供【前往更新】快捷入口直达设置更新区，或一键下载/安装重启
 *   - 支持【稍后】关闭该横幅（关闭后本会话内不再自动弹起，状态栏入口仍常驻）
 */

import { useState } from 'react';
import { ArrowUpCircle, CheckCircle, Download, Sparkles, X } from 'lucide-react';
import { useDesktopUpdate } from '../hooks/useDesktopUpdate';
import { useToast } from './common/Toast';
import { Button } from './common/Button';

interface VersionUpdateAlertProps {
  /** 快捷跳转至设置区（通常为 'application'） */
  onJumpToSettings?: (tab?: 'application') => void;
  className?: string;
}

export function VersionUpdateAlert({ onJumpToSettings, className = '' }: VersionUpdateAlertProps) {
  const toast = useToast();
  const {
    latestVersion,
    phase,
    updateState,
    progress,
    versionTip,
    isDownloading,
    isInstalling,
    downloadUpdate,
    installAndRestart,
  } = useDesktopUpdate();

  // 记录本会话内是否被用户主动关闭
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  // 仅在有新版本且用户未针对该版本点击关闭时渲染
  const shouldShow =
    (phase === 'available' || phase === 'downloading' || phase === 'downloaded') &&
    latestVersion &&
    dismissedVersion !== latestVersion;

  if (!shouldShow) return null;

  const handleDownload = async () => {
    try {
      toast.push({
        type: 'info',
        message: `开始下载新版本 ${versionTip.displayLatestVersion}…`,
        hint: '下载将在后台进行，请稍候',
      });
      const res = await downloadUpdate();
      if (res && !res.ok) {
        toast.push({
          type: 'error',
          message: '下载更新失败',
          hint: res.error,
        });
        onJumpToSettings?.('application');
      }
    } catch (err) {
      toast.push({
        type: 'error',
        message: '下载操作异常',
        hint: err instanceof Error ? err.message : '',
      });
      onJumpToSettings?.('application');
    }
  };

  const handleInstall = async () => {
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
          message: '安装失败',
          hint: res.error,
        });
        onJumpToSettings?.('application');
      }
    } catch (err) {
      toast.push({
        type: 'error',
        message: '安装操作异常',
        hint: err instanceof Error ? err.message : '',
      });
      onJumpToSettings?.('application');
    }
  };

  const releaseNotes = updateState?.updateInfo?.releaseNotes;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`relative overflow-hidden rounded-md border border-seal/30 bg-gradient-to-r from-seal/10 via-seal/5 to-paper p-3.5 shadow-sm transition-all sm:p-4 ${className}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {/* 左侧说明与版本号提示 */}
        <div className="flex items-start gap-3 min-w-0">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-seal/15 text-seal">
            {phase === 'downloaded' ? (
              <CheckCircle className="h-4 w-4 text-jade" />
            ) : phase === 'downloading' ? (
              <Download className="h-4 w-4 text-seal animate-bounce" />
            ) : (
              <ArrowUpCircle className="h-4 w-4 text-seal animate-pulse-seal" />
            )}
          </div>

          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium text-ink font-sans-ui">
                {versionTip.bannerTitle}
              </h3>

              {versionTip.upgradeKindLabel && (
                <span className="rounded-full bg-seal/20 px-2 py-0.5 text-[11px] font-medium text-seal font-sans-ui">
                  {versionTip.upgradeKindLabel}
                </span>
              )}

              {phase === 'downloaded' && (
                <span className="rounded-full bg-jade/20 px-2 py-0.5 text-[11px] font-medium text-jade font-sans-ui">
                  就绪待安装
                </span>
              )}
            </div>

            <p className="text-xs text-ink-soft leading-relaxed">
              {versionTip.bannerDescription}
            </p>

            {/* 下载进度条 */}
            {phase === 'downloading' && (
              <div className="pt-1.5 space-y-1 max-w-md">
                <div className="w-full bg-paper-2 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-seal h-1.5 rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.min(100, Math.max(0, progress?.percent ?? 0))}%`,
                    }}
                  />
                </div>
                <div className="text-[11px] text-ink-faint font-mono flex justify-between">
                  <span>进度：{Math.floor(progress?.percent ?? 0)}%</span>
                  {progress?.bytesPerSecond ? (
                    <span>{(progress.bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s</span>
                  ) : null}
                </div>
              </div>
            )}

            {/* 若有简短 Release Notes，显示前瞻 */}
            {phase === 'available' && releaseNotes && (
              <div className="mt-1 line-clamp-2 text-[11px] text-ink-faint font-sans-ui whitespace-pre-wrap rounded bg-paper/50 p-1.5 border border-line/50">
                {releaseNotes.trim().slice(0, 200)}
              </div>
            )}
          </div>
        </div>

        {/* 右侧快捷操作与关闭 */}
        <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
          {phase === 'downloaded' ? (
            <Button
              variant="primary"
              size="sm"
              onClick={handleInstall}
              disabled={isInstalling}
              className="text-xs h-7.5 px-3"
            >
              <CheckCircle className="w-3.5 h-3.5 mr-1" />
              {isInstalling ? '安装中…' : '立即重启安装'}
            </Button>
          ) : phase === 'available' ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDownload}
                disabled={isDownloading}
                className="text-xs h-7.5 px-2.5 border-seal/30 text-seal hover:bg-seal/10"
              >
                <Download className="w-3.5 h-3.5 mr-1" />
                {isDownloading ? '准备中…' : '一键下载'}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => onJumpToSettings?.('application')}
                className="text-xs h-7.5 px-3"
              >
                <Sparkles className="w-3.5 h-3.5 mr-1" />
                前往更新
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => onJumpToSettings?.('application')}
              className="text-xs h-7.5 px-3"
            >
              查看详情
            </Button>
          )}

          {/* 稍后提醒（关闭） */}
          <button
            type="button"
            onClick={() => setDismissedVersion(latestVersion)}
            title="稍后提醒"
            aria-label="关闭更新提示"
            className="rounded p-1 text-ink-faint hover:bg-paper-2 hover:text-ink transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
