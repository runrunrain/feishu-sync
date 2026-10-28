/**
 * HistoryRevertModal —— 云端历史回滚弹窗（P0-S5，两段流，设计 §4.5）
 *
 * 流程（消费 S4 路由）：
 *   1. preview：POST /history-revert/preview（body { pushLogId } | { historyVersionId }）
 *      → 展示目标版本信息 + 警告原文 + blockedReason 阻断面。
 *   2. execute：confirm 输入框预填 `REVERT_CLOUD:<historyVersionId>`，输入值
 *      与目标 id 派生值完全一致才可执行（服务端同值校验，裸 REVERT_CLOUD 拒 400）。
 *   3. 异步收敛：202 { state:'running', taskId } → running 徽标 + 轮询 push-log
 *      行的 revertState（server 轮询器落库），done/failed/unknown 终态收敛；
 *      done 后触发正文重载（回滚完成 → 单文档回拉已由服务端发起）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, History, Loader2, RefreshCw, RotateCcw, XCircle } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { StatusBadge } from '../common/StatusBadge';
import { useToast } from '../common/Toast';
import {
  APIError,
  executeHistoryRevert,
  getSourcePushLog,
  previewHistoryRevert,
} from '../../api/client';
import { appLogger } from '../../utils/appLogger';
import type { HistoryRevertExecutionResult, HistoryRevertPlan, SourcePushLogRecord } from '../../types';
import { deriveRevertConfirmValue, formatTime, REVERT_BLOCKED_TEXT, REVERT_WARNING_TEXT, shortHistoryId } from './labels';

/** 轮询节奏：与 server 轮询器同拍（5s），单次会话上限 10 分钟。 */
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_TRIES = 120;

export interface RevertTarget {
  pushLogId?: string;
  historyVersionId?: string;
  /** 入口来源说明（「写回记录 / 云端历史」），仅展示用。 */
  sourceLabel: string;
}

interface HistoryRevertModalProps {
  open: boolean;
  onClose: () => void;
  objToken: string;
  target: RevertTarget | null;
  /** 回滚收敛（done/unknown）后通知宿主刷新正文与编辑状态。 */
  onReverted: () => void;
}

type Phase = 'preview' | 'executing' | 'result';

/** 执行结果呈现态：202 异步收敛后的终态联合。 */
interface ResultFace {
  kind: 'done' | 'running' | 'failed' | 'unknown';
  taskId: string | null;
  message: string | null;
  pull: HistoryRevertExecutionResult['pull'];
}

export function HistoryRevertModal({ open, onClose, objToken, target, onReverted }: HistoryRevertModalProps) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('preview');
  const [planLoading, setPlanLoading] = useState(false);
  const [plan, setPlan] = useState<HistoryRevertPlan | null>(null);
  const [planError, setPlanError] = useState<{ code: string; message: string } | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [executing, setExecuting] = useState(false);
  const [execError, setExecError] = useState<{ code: string; message: string } | null>(null);
  const [result, setResult] = useState<ResultFace | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTriesRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const loadPlan = useCallback(() => {
    if (!target) return;
    setPhase('preview');
    setPlanLoading(true);
    setPlan(null);
    setPlanError(null);
    setExecError(null);
    setResult(null);
    setConfirmText('');
    previewHistoryRevert(objToken, {
      ...(target.pushLogId ? { pushLogId: target.pushLogId } : {}),
      ...(target.historyVersionId ? { historyVersionId: target.historyVersionId } : {}),
    })
      .then((next) => {
        if (!mountedRef.current) return;
        setPlan(next);
        // 预填确认值（任务书：预填 REVERT_CLOUD:<id> 待确认；按钮以精确匹配门控）。
        if (next.blockedReason == null && next.target.historyVersionId) {
          setConfirmText(deriveRevertConfirmValue(next.target.historyVersionId));
        }
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        const face = errorFace(error);
        setPlanError({ code: face.code, message: face.message });
      })
      .finally(() => {
        if (mountedRef.current) setPlanLoading(false);
      });
  }, [objToken, target]);

  useEffect(() => {
    if (open && target) loadPlan();
    if (!open) stopPolling();
  }, [open, target, loadPlan, stopPolling]);

  /** 202 running → 轮询 push-log 行 revertState 至终态（与 server 轮询器落库节奏同拍）。 */
  const pollRevertState = useCallback((pushLogId: string) => {
    pollTriesRef.current = 0;
    const tick = () => {
      pollTriesRef.current += 1;
      getSourcePushLog(objToken)
        .then(({ logs }) => {
          if (!mountedRef.current) return;
          const row: SourcePushLogRecord | undefined = logs.find((log) => log.id === pushLogId);
          if (row && row.revertState !== 'running' && row.revertState != null) {
            setPollCount(pollTriesRef.current);
            if (row.revertState === 'done') {
              const partial = row.revertError ? `（部分块回滚失败：${row.revertError}）` : '';
              setResult({ kind: 'done', taskId: row.revertTaskId, message: `云端已回滚到目标版本${partial}`, pull: null });
              toast.push({ type: 'success', message: `云端回滚完成${partial}` });
              onReverted();
            } else if (row.revertState === 'failed') {
              setResult({ kind: 'failed', taskId: row.revertTaskId, message: row.revertError ?? '云端返回回滚失败', pull: null });
            } else {
              setResult({ kind: 'unknown', taskId: row.revertTaskId, message: row.revertError ?? '回滚状态未知，请到飞书文档历史核对实际结果', pull: null });
              onReverted();
            }
            return;
          }
          if (pollTriesRef.current >= POLL_MAX_TRIES) {
            setPollCount(pollTriesRef.current);
            setResult({ kind: 'unknown', taskId: row?.revertTaskId ?? null, message: '轮询超时（10 分钟）：回滚状态未知，请到飞书文档历史核对', pull: null });
            return;
          }
          setPollCount(pollTriesRef.current);
          pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
        })
        .catch((error) => {
          if (!mountedRef.current) return;
          appLogger.warn('history-revert', 'poll push-log failed', error);
          if (pollTriesRef.current >= POLL_MAX_TRIES) {
            setResult({ kind: 'unknown', taskId: null, message: '轮询请求连续失败：回滚状态未知，请到飞书核对', pull: null });
            return;
          }
          pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
        });
    };
    pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [objToken, onReverted, toast]);

  const doExecute = () => {
    if (!plan || !target || plan.blockedReason != null) return;
    const required = deriveRevertConfirmValue(plan.target.historyVersionId);
    if (confirmText.trim() !== required) return;
    setExecuting(true);
    setExecError(null);
    executeHistoryRevert(
      objToken,
      {
        ...(target.pushLogId ? { pushLogId: target.pushLogId } : {}),
        ...(target.historyVersionId ? { historyVersionId: target.historyVersionId } : {}),
      },
      confirmText.trim(),
    )
      .then((result) => {
        if (!mountedRef.current) return;
        setPhase('result');
        if (result.state === 'running') {
          setResult({ kind: 'running', taskId: result.taskId, message: null, pull: null });
          toast.push({ type: 'info', message: '回滚请求已提交云端（异步执行），正在跟踪收敛…' });
          pollRevertState(result.pushLogId);
        } else {
          setResult({ kind: 'done', taskId: result.taskId, message: '云端已回滚到目标版本', pull: result.pull });
          toast.push({ type: 'success', message: '云端回滚完成' });
          onReverted();
        }
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        const face = errorFace(error);
        setExecError({ code: face.code, message: face.message });
      })
      .finally(() => {
        if (mountedRef.current) setExecuting(false);
      });
  };

  if (!target) return null;
  const requiredConfirm = plan && plan.blockedReason == null && plan.target.historyVersionId
    ? deriveRevertConfirmValue(plan.target.historyVersionId)
    : null;
  const confirmMatches = requiredConfirm != null && confirmText.trim() === requiredConfirm;

  return (
    <Modal
      open={open}
      title="回滚云端历史"
      onClose={() => {
        stopPolling();
        onClose();
      }}
      contentClassName="max-w-xl"
      zIndexClass="z-[400]"
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-faint">
          入口：{target.sourceLabel}。回滚会在云端产生新的历史版本（可再回滚）；本地正文由回滚完成后的单文档回拉恢复，本地未写回的修改会阻断回滚。
        </p>

        {/* ── 阶段 1：preview ─────────────────────────────────────── */}
        {phase === 'preview' && (
          <>
            {planLoading && (
              <div className="flex items-center gap-2 py-6 text-ink-faint">
                <Loader2 className="w-4 h-4 animate-spin" />
                <p className="text-sm">正在生成回滚计划（读取云端历史与文档状态）…</p>
              </div>
            )}
            {planError && !planLoading && (
              <div className="space-y-2">
                <p className="text-sm text-seal-2">{planError.message}</p>
                <Button variant="secondary" size="sm" onClick={loadPlan}>
                  <RefreshCw className="w-3.5 h-3.5" />
                  重试
                </Button>
              </div>
            )}
            {plan && !planLoading && plan.blockedReason != null && (
              <div className="rounded-md border border-seal-2/40 bg-seal-2/5 p-3 space-y-1.5">
                <p className="text-sm text-seal-2 font-medium">暂不能回滚</p>
                <p className="text-xs text-ink-soft leading-relaxed">
                  {REVERT_BLOCKED_TEXT[plan.blockedReason] ?? plan.blockedReason}
                </p>
              </div>
            )}
            {plan && !planLoading && plan.blockedReason == null && (
              <>
                <div className="rounded-md border border-line bg-paper-2/60 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-sm text-ink font-medium">
                      <History className="w-4 h-4 text-ink-soft" />
                      回滚目标版本
                    </span>
                    <StatusBadge status={plan.source === 'push_log' ? 'success' : 'neutral'} size="sm">
                      {plan.source === 'push_log' ? '写回锚点' : '指定历史版本'}
                    </StatusBadge>
                  </div>
                  <dl className="grid grid-cols-[92px_1fr] gap-x-3 gap-y-1.5 text-xs">
                    <dt className="text-ink-faint">版本 id</dt>
                    <dd className="font-mono text-ink break-all" data-testid="revert-target-id">{plan.target.historyVersionId || '—'}</dd>
                    <dt className="text-ink-faint">版本时间</dt>
                    <dd className="text-ink">{formatTime(plan.target.createdAt)}</dd>
                    <dt className="text-ink-faint">编辑者</dt>
                    <dd className="text-ink">{plan.target.editorName ?? (plan.target.editorIds.length > 0 ? `${plan.target.editorIds.length} 位编辑者（open_id）` : '未知')}</dd>
                    {plan.source === 'push_log' && (
                      <>
                        <dt className="text-ink-faint">锚点精确性</dt>
                        <dd className="text-ink">
                          {plan.anchorExact === true ? (
                            <span className="text-jade">精确（恰为写回前状态）</span>
                          ) : (
                            <span className="text-seal-2">近似（早于写回前状态）</span>
                          )}
                        </dd>
                      </>
                    )}
                  </dl>
                </div>

                {plan.warnings.length > 0 && (
                  <div className="rounded-md border border-seal/30 bg-seal/5 p-3 space-y-1.5">
                    {plan.warnings.map((warning) => (
                      <p key={warning} className="flex items-start gap-1.5 text-xs text-seal leading-relaxed">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        {REVERT_WARNING_TEXT[warning] ?? warning}
                      </p>
                    ))}
                  </div>
                )}

                {execError && (
                  <div className="rounded-md border border-seal-2/40 bg-seal-2/5 p-3 space-y-1">
                    <p className="text-sm text-seal-2 font-medium">回滚未执行成功</p>
                    <p className="text-xs text-ink-soft leading-relaxed">{execError.message}</p>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label htmlFor="revert-confirm-input" className="text-xs text-ink-soft">
                    确认执行：输入框已预填确认串，内容与目标版本一致时才能执行
                  </label>
                  <input
                    id="revert-confirm-input"
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!confirmMatches}
                    data-testid="revert-confirm-input"
                    className="w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-xs text-ink focus:outline-none focus:border-seal/50"
                  />
                  {requiredConfirm && !confirmMatches && (
                    <p className="text-[11px] text-ink-faint">需要精确匹配：<span className="font-mono">{requiredConfirm}</span></p>
                  )}
                </div>

                <div className="flex items-center justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => { stopPolling(); onClose(); }} disabled={executing}>
                    取消
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={doExecute}
                    loading={executing}
                    disabled={!confirmMatches}
                    data-testid="revert-execute"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    确认回滚云端
                  </Button>
                </div>
              </>
            )}
          </>
        )}

        {/* ── 阶段 2：执行结果 / 异步收敛 ─────────────────────────── */}
        {phase === 'result' && result && (
          <div className="space-y-3" data-testid={`revert-result-${result.kind}`}>
            {result.kind === 'running' && (
              <div className="rounded-md border border-jade/30 bg-jade/5 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <StatusBadge status="loading" size="sm">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    回滚执行中
                  </StatusBadge>
                  <span className="text-[11px] text-ink-faint">已轮询 {pollCount} 次（每 5 秒）· 任务 {result.taskId ?? '—'}</span>
                </div>
                <p className="text-xs text-ink-soft leading-relaxed">
                  云端已接受回滚请求（异步执行，任务 id {shortHistoryId(result.taskId)}）。正在跟踪状态直至完成；完成后本地正文将由单文档回拉自动恢复。
                </p>
              </div>
            )}
            {result.kind === 'done' && (
              <div className="rounded-md border border-jade/30 bg-jade/5 p-3 space-y-1.5">
                <p className="flex items-center gap-1.5 text-sm text-jade font-medium">
                  <CheckCircle2 className="w-4 h-4" />
                  回滚完成
                </p>
                <p className="text-xs text-ink-soft leading-relaxed">{result.message}</p>
                {result.pull && !result.pull.ok && (
                  <p className="text-xs text-seal leading-relaxed">
                    本地回拉未完成（{result.pull.status}）：请稍后在「贰 同步」手动同步该文档收敛正文。
                  </p>
                )}
              </div>
            )}
            {result.kind === 'failed' && (
              <div className="rounded-md border border-seal-2/40 bg-seal-2/5 p-3 space-y-1.5">
                <p className="flex items-center gap-1.5 text-sm text-seal-2 font-medium">
                  <XCircle className="w-4 h-4" />
                  回滚失败
                </p>
                <p className="text-xs text-ink-soft leading-relaxed">{result.message}</p>
                <p className="text-xs text-ink-faint">云端正文未被本次操作改动，可修正后重试。</p>
              </div>
            )}
            {result.kind === 'unknown' && (
              <div className="rounded-md border border-line bg-paper-2/60 p-3 space-y-1.5">
                <p className="flex items-center gap-1.5 text-sm text-ink font-medium">
                  <AlertTriangle className="w-4 h-4 text-seal" />
                  回滚状态未知（不自动重试）
                </p>
                <p className="text-xs text-ink-soft leading-relaxed">{result.message}</p>
                <p className="text-xs text-ink-faint leading-relaxed">
                  回滚非幂等，不会自动重试。请打开飞书文档 → 右上「…」→ 历史版本 核对实际结果后决定后续操作。
                </p>
              </div>
            )}
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => { stopPolling(); onClose(); }}>
                关闭
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function errorFace(error: unknown): { code: string; message: string } {
  if (error instanceof APIError) {
    const body = (error.response ?? {}) as { error?: unknown; message?: unknown };
    return {
      code: typeof body.error === 'string' ? body.error : '',
      message: error.message,
    };
  }
  return { code: '', message: error instanceof Error ? error.message : String(error) };
}
