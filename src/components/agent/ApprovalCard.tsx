/**
 * ApprovalCard —— 会话内批准卡片（S10，设计 kb-agent-upgrade §6.5）
 *
 * app_command 的 mutate/destructive/remote_write 级命令挂起时渲染：
 * 命令名 / 风险级 / 参数摘要 / 超时倒计时 / 批准与拒绝按钮。
 * 确认只能来自这里的人类点击——模型传入的 confirm 参数已在 server 剔除。
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Clock, Terminal, X } from 'lucide-react';
import type { AgentApprovalDto, AgentApprovalRisk } from '../../types/agent';

const RISK_LABEL: Record<AgentApprovalRisk, string> = {
  read: '只读',
  mutate: '写入',
  destructive: '破坏性',
  remote_write: '远端写入',
};

const RISK_CLASS: Record<AgentApprovalRisk, string> = {
  read: 'border-jade/40 bg-jade/[0.08] text-jade',
  mutate: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600',
  destructive: 'border-seal-2/40 bg-[rgba(192,57,43,0.08)] text-seal-2',
  remote_write: 'border-seal-2/40 bg-[rgba(192,57,43,0.08)] text-seal-2',
};

/** 倒计时文案（纯函数，供组件测试锚定）：过期 → null。 */
export function formatCountdown(expiresAt: string, now: number): string | null {
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

interface ApprovalCardProps {
  approval: AgentApprovalDto;
  onDecide: (id: string, decision: 'approve' | 'reject') => void;
  /** 正在裁决的批准 id（按钮禁用防双击）。 */
  busy?: boolean;
}

export function ApprovalCard({ approval, onDecide, busy = false }: ApprovalCardProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const countdown = formatCountdown(approval.expiresAt, now);
  const expired = countdown === null;
  const disabled = busy || expired;

  return (
    <div
      className="px-4 py-3 rounded-md border border-line bg-card-bg"
      data-testid="approval-card"
      data-approval-id={approval.id}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Terminal className="w-4 h-4 shrink-0 text-ink-soft" />
        <span className="text-sm font-medium font-mono text-ink" data-testid="approval-command">
          {approval.command}
        </span>
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${RISK_CLASS[approval.risk]}`}
          data-testid="approval-risk"
          data-risk={approval.risk}
        >
          {(approval.risk === 'destructive' || approval.risk === 'remote_write') && (
            <AlertTriangle className="w-2.5 h-2.5" />
          )}
          {RISK_LABEL[approval.risk]}
        </span>
        <span
          className={`ml-auto inline-flex items-center gap-1 text-[11px] font-mono ${expired ? 'text-ink-faint' : 'text-ink-soft'}`}
          data-testid="approval-countdown"
        >
          <Clock className="w-3 h-3" />
          {expired ? '已超时' : `${countdown} 后超时`}
        </span>
      </div>

      <p className="mt-2 text-[11px] font-mono text-ink-faint break-all" data-testid="approval-args">
        {approval.argsSummary || '（无参数）'}
      </p>

      <p className="mt-1.5 text-[11px] text-ink-soft">
        Agent 请求执行上述命令；批准后立即执行，拒绝则本次调用失败。确认只能由你完成。
      </p>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onDecide(approval.id, 'approve')}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-jade text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-jade/90 transition-colors"
          data-testid="approval-approve"
        >
          <Check className="w-3.5 h-3.5" />
          批准执行
        </button>
        <button
          type="button"
          onClick={() => onDecide(approval.id, 'reject')}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-seal-2/40 text-seal-2 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[rgba(192,57,43,0.06)] transition-colors"
          data-testid="approval-reject"
        >
          <X className="w-3.5 h-3.5" />
          拒绝
        </button>
        {busy ? <span className="text-[11px] text-ink-faint">正在提交裁决…</span> : null}
      </div>
    </div>
  );
}
