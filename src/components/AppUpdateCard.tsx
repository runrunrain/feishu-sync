/**
 * AppUpdateCard - 关于与更新（T8，04 §4.3 / §7.2 #19）
 *
 * 整合原 UpdatePanel：版本号 + 检查更新 + 自启动 + 通知开关。
 * 自启动/通知开关通过 useConfig().updateConfig 写回 config.json。
 * 文案中文化。
 */

import { useEffect, useState } from 'react';
import { Download, RefreshCw, CheckCircle } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import { Button } from './common/Button';
import { Toggle } from './common/Input';
import { useConfig } from '../hooks/useConfig';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';
import type { DesktopUpdateState } from '../types';

const APP_VERSION = 'v0.2.0';

export function AppUpdateCard() {
  const { config, updateConfig } = useConfig();
  const toast = useToast();
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.desktop) {
      window.desktop.update.getState().then(setUpdateState).catch((err) => {
        appLogger.warn('app-update', 'getState failed (non-fatal)', err);
      });
    }
  }, []);

  const handleCheck = async () => {
    if (!window.desktop) return;
    setLoading(true);
    try {
      const result = await window.desktop.update.check();
      if (result.available) {
        setUpdateState({ state: 'available', version: result.version });
        toast.push({ type: 'info', message: `发现新版本 ${result.version}`, hint: result.releaseNotes?.slice(0, 80) });
      } else {
        setUpdateState({ state: 'idle' });
        toast.push({ type: 'success', message: '已是最新版本' });
      }
    } catch (err) {
      appLogger.error('app-update', 'check failed', err);
      toast.push({ type: 'error', message: '检查更新失败', hint: err instanceof Error ? err.message : '' });
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!window.desktop) return;
    setLoading(true);
    try {
      await window.desktop.update.download();
      setUpdateState({ state: 'downloaded' });
    } catch (err) {
      appLogger.error('app-update', 'download failed', err);
      toast.push({ type: 'error', message: '下载失败', hint: err instanceof Error ? err.message : '' });
    } finally {
      setLoading(false);
    }
  };

  const handleInstall = async () => {
    if (!window.desktop) return;
    try {
      await window.desktop.update.installAndRestart();
    } catch (err) {
      appLogger.error('app-update', 'install failed', err);
      toast.push({ type: 'error', message: '安装失败', hint: err instanceof Error ? err.message : '' });
    }
  };

  const statusText = (() => {
    if (!updateState) return '未知';
    switch (updateState.state) {
      case 'idle': return '已是最新';
      case 'checking': return '检查中…';
      case 'available': return `有新版本：${updateState.version ?? ''}`;
      case 'downloading': return `下载中… ${updateState.progress ?? 0}%`;
      case 'downloaded': return '已下载，等待安装';
      case 'installing': return '安装中…';
      default: return '未知';
    }
  })();

  return (
    <Card variant="default">
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-kai font-medium text-ink">关于与更新</h2>
          <StatusBadge
            status={
              updateState?.state === 'available' || updateState?.state === 'downloaded'
                ? 'warning'
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
          <span className="text-sm font-mono text-seal">{APP_VERSION}</span>
        </div>

        {updateState?.state === 'available' && (
          <Button onClick={handleDownload} loading={loading} size="sm">
            <Download className="w-4 h-4" />
            下载更新
          </Button>
        )}

        {updateState?.state === 'downloaded' && (
          <Button onClick={handleInstall} size="sm">
            <CheckCircle className="w-4 h-4" />
            安装并重启
          </Button>
        )}

        {updateState?.state === 'downloading' && (
          <div className="space-y-1.5">
            <div className="w-full bg-paper-2 rounded-full h-2 overflow-hidden">
              <div
                className="bg-seal h-2 rounded-full transition-all"
                style={{ width: `${updateState.progress ?? 0}%` }}
              />
            </div>
            <p className="text-xs text-ink-faint text-center font-sans-ui">{updateState.progress ?? 0}%</p>
          </div>
        )}

        {(updateState?.state === 'idle' || !updateState) && (
          <Button variant="secondary" onClick={handleCheck} loading={loading} size="sm">
            <RefreshCw className="w-4 h-4" />
            检查更新
          </Button>
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
