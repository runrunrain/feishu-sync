/**
 * MoveOutModal —— 移出到云空间弹窗（P2-S7，两段流，设计 §3.4；
 * 消费 P2-S6 四端点，交互骨架与 HistoryRevertModal 同模式）
 *
 * 流程：
 *   1. preview：POST /move-to-drive/preview → 文档名 / 所属知识库 /
 *      目标（个人云空间根）/ 后果固定文案 + blockedReason 八分支可读文案。
 *   2. execute：确认输入框预填 `MOVE_OUT:<wikiNodeToken>`（preview 返回
 *      权威 nodeToken 派生），精确匹配才可执行（服务端同值校验）。
 *   3. 异步收敛：202 { state:'moving', moveId } → moving 徽标 + 轮询
 *      GET /moves/:moveId 至 moved/failed/unknown 终态（server 轮询器
 *      落库，此处只读收敛展示）。
 *
 * 哑面板（MoveOutPreviewPanel / MoveOutResultPanel）导出供 SSR 锚定；
 * 智能壳只负责加载 / 执行 / 轮询状态机。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FolderOutput, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { StatusBadge } from '../common/StatusBadge';
import { useToast } from '../common/Toast';
import { APIError, executeMoveToDrive, getCloudMove, previewMoveToDrive } from '../../api/client';
import { appLogger } from '../../utils/appLogger';
import type { CloudMoveRecord, MoveOutPreview } from '../../types';
import {
  MOVE_OUT_BLOCKED_TEXT,
  MOVE_OUT_UNKNOWN_GUIDE,
  cloudMoveStateBadge,
  deriveMoveOutConfirmValue,
} from './labels';
import { formatTime } from '../source-history/labels';

/** 轮询节奏：与 server 轮询器同拍（5s），单次会话上限 10 分钟。 */
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_TRIES = 120;

export interface MoveOutTarget {
  objToken: string;
  title: string;
}

interface MoveOutModalProps {
  open: boolean;
  onClose: () => void;
  objToken: string | null;
  target: MoveOutTarget | null;
  /** 移出收敛（moved/unknown/failed 终态）后通知宿主刷新树与移出记录。 */
  onMoved: () => void;
}

type Phase = 'preview' | 'result';

/** 轮询收敛后的终态呈现（kind 与 cloud_moves.state 对齐）。 */
export interface MoveOutResultFace {
  kind: 'moved' | 'moving' | 'failed' | 'unknown';
  moveId: string;
  taskId: string | null;
  message: string | null;
}

export function MoveOutModal({ open, onClose, objToken, target, onMoved }: MoveOutModalProps) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('preview');
  const [planLoading, setPlanLoading] = useState(false);
  const [plan, setPlan] = useState<MoveOutPreview | null>(null);
  const [planError, setPlanError] = useState<{ code: string; message: string } | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [executing, setExecuting] = useState(false);
  const [execError, setExecError] = useState<{ code: string; message: string } | null>(null);
  const [result, setResult] = useState<MoveOutResultFace | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTriesRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    // StrictMode 双挂载（dev）：effect 重跑时恢复 mounted 标记，否则首次
    // cleanup 置 false 后 loadPlan 的 then 守卫会永久吞掉 setPlan（卡 loading）。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const loadPlan = useCallback(() => {
    if (!objToken) return;
    setPhase('preview');
    setPlanLoading(true);
    setPlan(null);
    setPlanError(null);
    setExecError(null);
    setResult(null);
    setConfirmText('');
    previewMoveToDrive(objToken)
      .then((next) => {
        if (!mountedRef.current) return;
        setPlan(next);
        // 预填确认值（任务书：预填 MOVE_OUT:<wikiNodeToken> 待确认；
        // 按钮以精确匹配门控——改一字即不可执行）。
        if (next.blockedReason == null && next.nodeToken) {
          setConfirmText(deriveMoveOutConfirmValue(next.nodeToken));
        }
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        const face = errorFace(error);
        setPlanError(face);
      })
      .finally(() => {
        if (mountedRef.current) setPlanLoading(false);
      });
  }, [objToken]);

  useEffect(() => {
    if (open && objToken) loadPlan();
    if (!open) stopPolling();
  }, [open, objToken, loadPlan, stopPolling]);

  /** 202 moving → 轮询 moves/:moveId 至终态（server 轮询器落库节奏同拍）。 */
  const pollMoveState = useCallback((moveId: string) => {
    pollTriesRef.current = 0;
    const finish = (face: MoveOutResultFace, notify?: 'moved') => {
      setResult(face);
      if (notify === 'moved') {
        toast.push({ type: 'success', message: '文档已移出到云空间' });
        onMoved();
      }
    };
    const tick = () => {
      pollTriesRef.current += 1;
      setPollCount(pollTriesRef.current);
      getCloudMove(moveId)
        .then((row: CloudMoveRecord) => {
          if (!mountedRef.current) return;
          if (row.state === 'moving' || row.state === 'pending') {
            if (pollTriesRef.current >= POLL_MAX_TRIES) {
              finish({
                kind: 'unknown',
                moveId,
                taskId: row.taskId ?? null,
                message: '轮询超时（10 分钟）：移出状态未知，请到飞书知识库核对',
              });
              return;
            }
            pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
            return;
          }
          if (row.state === 'moved') {
            finish(
              { kind: 'moved', moveId, taskId: row.taskId ?? null, message: `移出完成于 ${formatTime(row.updatedAt)}` },
              'moved',
            );
          } else if (row.state === 'failed') {
            finish({ kind: 'failed', moveId, taskId: row.taskId ?? null, message: row.error ?? '云端返回移出失败' });
          } else {
            finish({ kind: 'unknown', moveId, taskId: row.taskId ?? null, message: MOVE_OUT_UNKNOWN_GUIDE });
            onMoved();
          }
        })
        .catch((error) => {
          if (!mountedRef.current) return;
          appLogger.warn('move-out', 'poll cloud move failed', error);
          if (pollTriesRef.current >= POLL_MAX_TRIES) {
            finish({ kind: 'unknown', moveId, taskId: null, message: '轮询请求连续失败：移出状态未知，请到飞书核对' });
            return;
          }
          pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
        });
    };
    pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [onMoved, toast]);

  const doExecute = () => {
    if (!plan || !objToken || plan.blockedReason != null) return;
    const required = deriveMoveOutConfirmValue(plan.nodeToken);
    if (confirmText.trim() !== required) return;
    setExecuting(true);
    setExecError(null);
    executeMoveToDrive(objToken, confirmText.trim())
      .then((outcome) => {
        if (!mountedRef.current) return;
        setPhase('result');
        if (outcome.state === 'moving') {
          setResult({ kind: 'moving', moveId: outcome.moveId, taskId: outcome.taskId, message: null });
          toast.push({ type: 'info', message: '移出请求已提交云端（异步执行），正在跟踪收敛…' });
          pollMoveState(outcome.moveId);
        } else {
          setResult({
            kind: 'moved',
            moveId: outcome.moveId,
            taskId: outcome.taskId,
            message: '文档已移出到云空间',
          });
          toast.push({ type: 'success', message: '文档已移出到云空间' });
          onMoved();
        }
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        const face = errorFace(error);
        setExecError(face);
      })
      .finally(() => {
        if (mountedRef.current) setExecuting(false);
      });
  };

  if (!target) return null;

  return (
    <Modal
      open={open}
      title="移出到云空间"
      onClose={() => {
        stopPolling();
        onClose();
      }}
      contentClassName="max-w-xl"
      zIndexClass="z-[400]"
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-faint">
          把文档从知识库结构中拿走并转为云空间权限模型（删除的安全替代）。只支持单篇叶子文档、人工确认发起。
        </p>

        {phase === 'preview' && (
          <>
            {planLoading && (
              <div className="flex items-center gap-2 py-6 text-ink-faint" data-testid="moveout-preview-loading">
                <Loader2 className="w-4 h-4 animate-spin" />
                <p className="text-sm">正在读取文档与知识库状态…</p>
              </div>
            )}
            {planError && !planLoading && (
              <div className="space-y-2" data-testid="moveout-preview-error">
                <p className="text-sm text-seal-2">
                  {MOVE_OUT_BLOCKED_TEXT[planError.code as keyof typeof MOVE_OUT_BLOCKED_TEXT] ?? planError.message}
                </p>
                <Button variant="secondary" size="sm" onClick={loadPlan}>
                  <RefreshCw className="w-3.5 h-3.5" />
                  重试
                </Button>
              </div>
            )}
            {plan && !planLoading && (
              <MoveOutPreviewPanel
                plan={plan}
                confirmText={confirmText}
                onConfirmTextChange={setConfirmText}
                executing={executing}
                execError={execError}
                onCancel={() => { stopPolling(); onClose(); }}
                onExecute={doExecute}
              />
            )}
          </>
        )}

        {phase === 'result' && result && (
          <MoveOutResultPanel result={result} pollCount={pollCount} onClose={() => { stopPolling(); onClose(); }} />
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 哑面板：preview + 确认值门控（导出供 SSR 测试锚定）
// ---------------------------------------------------------------------------

export function MoveOutPreviewPanel({
  plan,
  confirmText,
  onConfirmTextChange,
  executing,
  execError,
  onCancel,
  onExecute,
}: {
  plan: MoveOutPreview;
  confirmText: string;
  onConfirmTextChange: (value: string) => void;
  executing: boolean;
  execError: { code: string; message: string } | null;
  onCancel: () => void;
  onExecute: () => void;
}) {
  const requiredConfirm = plan.blockedReason == null && plan.nodeToken
    ? deriveMoveOutConfirmValue(plan.nodeToken)
    : null;
  const confirmMatches = requiredConfirm != null && confirmText.trim() === requiredConfirm;

  return (
    <>
      {plan.blockedReason != null ? (
        <div className="rounded-md border border-seal-2/40 bg-seal-2/5 p-3 space-y-1.5" data-testid="moveout-blocked">
          <p className="text-sm text-seal-2 font-medium">暂不能移出</p>
          <p className="text-xs text-ink-soft leading-relaxed">
            {MOVE_OUT_BLOCKED_TEXT[plan.blockedReason] ?? plan.blockedReason}
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-md border border-line bg-paper-2/60 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-sm text-ink font-medium">
                <FolderOutput className="w-4 h-4 text-ink-soft" />
                移出对象
              </span>
              <StatusBadge status="neutral" size="sm">不可逆操作</StatusBadge>
            </div>
            <dl className="grid grid-cols-[92px_1fr] gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-ink-faint">文档</dt>
              <dd className="text-ink break-all" data-testid="moveout-title">{plan.title || '（无标题）'}</dd>
              <dt className="text-ink-faint">所属知识库</dt>
              <dd className="text-ink break-all">{plan.watchedRootLabel || '—'}</dd>
              <dt className="text-ink-faint">移出目标</dt>
              <dd className="text-ink">{plan.target.label || '个人空间根'}</dd>
              <dt className="text-ink-faint">节点</dt>
              <dd className="font-mono text-ink break-all" data-testid="moveout-node-token">{plan.nodeToken}</dd>
            </dl>
          </div>

          <div className="rounded-md border border-seal/30 bg-seal/5 p-3 space-y-1.5" data-testid="moveout-consequences">
            {plan.consequences.map((line) => (
              <p key={line} className="flex items-start gap-1.5 text-xs text-seal leading-relaxed">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                {line}
              </p>
            ))}
            <p className="flex items-start gap-1.5 text-xs text-ink-soft leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              移出后不再同步该文档；本地文件与标准库内容保留不动。
            </p>
          </div>

          {execError && (
            <div className="rounded-md border border-seal-2/40 bg-seal-2/5 p-3 space-y-1">
              <p className="text-sm text-seal-2 font-medium">移出未执行成功</p>
              <p className="text-xs text-ink-soft leading-relaxed">{execError.message}</p>
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="moveout-confirm-input" className="text-xs text-ink-soft">
              确认执行：输入框已预填确认串，内容与该文档的节点标识一致时才能执行
            </label>
            <input
              id="moveout-confirm-input"
              value={confirmText}
              onChange={(event) => onConfirmTextChange(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!confirmMatches}
              data-testid="moveout-confirm-input"
              className="w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-xs text-ink focus:outline-none focus:border-seal/50"
            />
            {requiredConfirm && !confirmMatches && (
              <p className="text-[11px] text-ink-faint">需要精确匹配：<span className="font-mono">{requiredConfirm}</span></p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={executing}>
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={onExecute}
              loading={executing}
              disabled={!confirmMatches}
              data-testid="moveout-execute"
            >
              <FolderOutput className="w-3.5 h-3.5" />
              确认移出到云空间
            </Button>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 哑面板：执行结果 / 异步收敛（导出供 SSR 测试锚定）
// ---------------------------------------------------------------------------

export function MoveOutResultPanel({
  result,
  pollCount,
  onClose,
}: {
  result: MoveOutResultFace;
  pollCount: number;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3" data-testid={`moveout-result-${result.kind}`}>
      {result.kind === 'moving' && (
        <div className="rounded-md border border-jade/30 bg-jade/5 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <StatusBadge status="loading" size="sm">
              <Loader2 className="w-3 h-3 animate-spin" />
              移出执行中
            </StatusBadge>
            <span className="text-[11px] text-ink-faint">已轮询 {pollCount} 次（每 5 秒）· 任务 {result.taskId ?? '—'}</span>
          </div>
          <p className="text-xs text-ink-soft leading-relaxed">
            云端已接受移出请求（异步执行，记录 {result.moveId}）。正在跟踪状态直至完成；完成后文档树会刷新为「已移出到云空间」。
          </p>
        </div>
      )}
      {result.kind === 'moved' && (
        <div className="rounded-md border border-jade/30 bg-jade/5 p-3 space-y-1.5">
          <p className="flex items-center gap-1.5 text-sm text-jade font-medium">
            <CheckCircle2 className="w-4 h-4" />
            已移出到云空间
          </p>
          <p className="text-xs text-ink-soft leading-relaxed">{result.message}</p>
          <p className="text-xs text-ink-faint leading-relaxed">
            本应用停止同步该文档；本地文件与标准库内容保留不动。文档树稍后随检测展示为「已移出到云空间」。
          </p>
        </div>
      )}
      {result.kind === 'failed' && (
        <div className="rounded-md border border-seal-2/40 bg-seal-2/5 p-3 space-y-1.5">
          <p className="flex items-center gap-1.5 text-sm text-seal-2 font-medium">
            <XCircle className="w-4 h-4" />
            移出失败
          </p>
          <p className="text-xs text-ink-soft leading-relaxed">{result.message}</p>
          <p className="text-xs text-ink-faint">云端结构未被本次操作改动，可修正后重新发起（新记录）。</p>
        </div>
      )}
      {result.kind === 'unknown' && (
        <div className="rounded-md border border-line bg-paper-2/60 p-3 space-y-1.5">
          <p className="flex items-center gap-1.5 text-sm text-ink font-medium">
            <AlertTriangle className="w-4 h-4 text-seal" />
            移出状态未知（不自动重试）
          </p>
          <p className="text-xs text-ink-soft leading-relaxed">{result.message}</p>
          <p className="text-xs text-ink-faint leading-relaxed">{MOVE_OUT_UNKNOWN_GUIDE}</p>
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={onClose}>
          关闭
        </Button>
      </div>
    </div>
  );
}

/** 当前记录状态徽标文案（导出给列表/详情复用；锚定 cloudMoveStateBadge）。 */
export { cloudMoveStateBadge };

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
