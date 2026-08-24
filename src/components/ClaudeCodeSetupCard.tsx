/** Read-only local Claude Code readiness panel. */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { getClaudeCliStatus } from '../api/client';
import { Button } from './common/Button';
import { useToast } from './common/Toast';
import type { ClaudeCliStatus } from '../types';

const SOURCE_LABEL: Record<ClaudeCliStatus['source'], string> = {
  configured: '配置路径',
  environment: 'Claude Code 环境变量',
  path: '系统 PATH',
  'known-location': '常见 npm 安装目录',
  missing: '未检测到',
};

export function ClaudeCodeSetupCard() {
  const [status, setStatus] = useState<ClaudeCliStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const toast = useToast();

  const refresh = useCallback(async (showToast = false) => {
    setChecking(true);
    try {
      const next = await getClaudeCliStatus();
      setStatus(next);
      if (showToast) {
        toast.push({
          type: next.executable ? 'success' : 'warning',
          message: next.executable ? 'Claude Code 可用' : 'Claude Code 不可用',
          hint: next.executable
            ? `${next.version ?? '未知版本'} · ${SOURCE_LABEL[next.source]}`
            : next.error,
        });
      }
    } catch (error) {
      toast.push({
        type: 'error',
        message: '检查 Claude Code 失败',
        hint: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setChecking(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const usable = status?.executable === true;
  return (
    <div className="rounded-md border border-line bg-paper/50 p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">本机 Claude Code</p>
          <p className="mt-1 text-xs text-ink-faint leading-5">
            同步时以 <code className="font-mono">claude -p --bare</code> 无头运行；GLM 凭据和模型由上方 Anthropic 兼容配置注入，不使用个人 Claude 登录态。
          </p>
        </div>
        {usable ? (
          <CheckCircle2 className="w-5 h-5 shrink-0 text-jade" aria-label="Claude Code 可用" />
        ) : (
          <TriangleAlert className="w-5 h-5 shrink-0 text-amber-600" aria-label="Claude Code 不可用" />
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

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => void refresh(true)} loading={checking}>
          {!checking && <RefreshCw className="w-3.5 h-3.5" />}
          检查安装
        </Button>
        {checking && <Loader2 className="w-4 h-4 animate-spin text-ink-faint" />}
        {!usable && (
          <p className="text-[11px] text-ink-faint">
            请先按 Claude Code 官方方式安装；本应用不会自动安装或登录 Claude Code。
          </p>
        )}
      </div>
    </div>
  );
}
