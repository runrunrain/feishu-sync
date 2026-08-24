/** Local OpenCode availability and explicit installation controls. */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { getOpenCodeStatus, installOpenCode } from '../api/client';
import { Button } from './common/Button';
import { useToast } from './common/Toast';
import type { OpenCodeStatus } from '../types';

const SOURCE_LABEL: Record<OpenCodeStatus['source'], string> = {
  configured: '配置路径',
  path: '系统 PATH',
  'login-shell': '登录 shell PATH',
  'npm-global-prefix': 'npm 全局 prefix',
  'npm-global-root': 'npm 全局安装目录',
  missing: '未检测到',
};

export function OpenCodeSetupCard() {
  const [status, setStatus] = useState<OpenCodeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const toast = useToast();

  const refresh = useCallback(async (showToast = false) => {
    setChecking(true);
    try {
      const next = await getOpenCodeStatus();
      setStatus(next);
      if (showToast) {
        toast.push({
          type: next.executable ? 'success' : 'warning',
          message: next.executable ? 'OpenCode 可用' : 'OpenCode 不可用',
          hint: next.executable
            ? `${next.version ?? '未知版本'} · ${SOURCE_LABEL[next.source]}`
            : next.error,
        });
      }
    } catch (error) {
      toast.push({
        type: 'error',
        message: '检查 OpenCode 失败',
        hint: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setChecking(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInstall = async () => {
    const confirmed = typeof window === 'undefined' || window.confirm(
      '将执行官方命令：npm install --global opencode-ai@latest\n\n这会修改本机全局 npm 安装目录。是否继续？',
    );
    if (!confirmed) return;
    setInstalling(true);
    try {
      const result = await installOpenCode();
      setStatus(result.status);
      toast.push({
        type: result.success ? 'success' : 'error',
        message: result.success ? 'OpenCode 已安装并验证' : 'OpenCode 安装未完成',
        hint: result.message,
      });
    } catch (error) {
      toast.push({
        type: 'error',
        message: 'OpenCode 安装失败',
        hint: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setInstalling(false);
    }
  };

  const usable = status?.executable === true;
  return (
    <div className="rounded-md border border-line bg-paper/50 p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">本机 OpenCode</p>
          <p className="mt-1 text-xs text-ink-faint leading-5">
            只检查本机 CLI；模型凭据继续由 OpenCode 自己的本地配置管理，不会导入到本应用。
          </p>
        </div>
        {usable ? (
          <CheckCircle2 className="w-5 h-5 shrink-0 text-jade" aria-label="OpenCode 可用" />
        ) : (
          <TriangleAlert className="w-5 h-5 shrink-0 text-amber-600" aria-label="OpenCode 不可用" />
        )}
      </div>

      {status && (
        <div className="text-xs text-ink-soft space-y-1 break-all">
          <p>
            状态：<span className={usable ? 'text-jade' : 'text-seal-2'}>{usable ? '可执行' : '不可执行'}</span>
            {status.version ? ` · v${status.version}` : ''}
            {` · ${SOURCE_LABEL[status.source]}`}
          </p>
          {status.executablePath && <p className="font-mono text-[11px] text-ink-faint">{status.executablePath}</p>}
          {status.error && <p className="text-seal-2">{status.error}</p>}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => void refresh(true)} loading={checking} disabled={installing}>
          {!checking && <RefreshCw className="w-3.5 h-3.5" />}
          检查安装
        </Button>
        {!usable && (
          <Button type="button" variant="secondary" size="sm" onClick={() => void handleInstall()} loading={installing} disabled={checking}>
            {!installing && <Download className="w-3.5 h-3.5" />}
            {installing ? '安装中…' : '使用 npm 安装'}
          </Button>
        )}
        {(checking || installing) && <Loader2 className="w-4 h-4 animate-spin text-ink-faint self-center" />}
      </div>
    </div>
  );
}

