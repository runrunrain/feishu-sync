/**
 * SourcePushLogDrawer —— 写回记录抽屉（P0-S5，设计 §4.5）
 *
 * 每次写回/回滚一行：时间、模式（追加/覆盖/回滚）、执行者、锚点
 * （精确/近似/无）、结果四态徽标（pushed/failed/unknown/conflict）。
 * 行操作「回滚到写回前」（无锚点/非成功写回/回滚进行中禁用并显示原因）；
 * conflict / unknown 行提供「对比云端」入口（云端正文接口未接入时弹窗
 * 呈诚实的不可读状态，见 CloudDiffModal 头注释）。
 * 存在 revert_state='running' 行时轮询收敛（与 server 轮询器落库同拍）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileClock, GitCompare, Loader2, RefreshCw, RotateCcw, ScrollText } from 'lucide-react';
import { Drawer } from '../common/Drawer';
import { StatusBadge } from '../common/StatusBadge';
import { EmptyState } from '../common/EmptyState';
import { getSourcePushLog } from '../../api/client';
import { appLogger } from '../../utils/appLogger';
import type { SourcePushLogRecord } from '../../types';
import {
  anchorFace,
  formatTime,
  PUSH_ACTOR_LABEL,
  PUSH_MODE_LABEL,
  pushOutcomeBadge,
  rollbackRowGate,
  shortHistoryId,
} from './labels';

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_TRIES = 120;

interface SourcePushLogDrawerProps {
  open: boolean;
  onClose: () => void;
  objToken: string;
  /** 本地当前正文（不含 feishu_sync 头；对比差异右侧，无编辑行时为 null）。 */
  localBody: string | null;
  /** 打开回滚弹窗（target = { pushLogId }）。 */
  onRequestRevert: (target: { pushLogId: string; sourceLabel: string }) => void;
  /** 打开冲突对比弹窗。 */
  onRequestCompare: (log: SourcePushLogRecord) => void;
  /** 行状态变化（回滚收敛）时通知宿主刷新。 */
  onLogsChanged?: () => void;
}

export function SourcePushLogDrawer({
  open,
  onClose,
  objToken,
  localBody,
  onRequestRevert,
  onRequestCompare,
  onLogsChanged,
}: SourcePushLogDrawerProps) {
  const [logs, setLogs] = useState<SourcePushLogRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    pollTriesRef.current = 0;
  }, []);

  /** 有 running 行 → 定时重拉（server 轮询器写终态后这里自然收敛）。 */
  const schedulePollIfNeeded = useCallback((rows: SourcePushLogRecord[]) => {
    if (!rows.some((row) => row.revertState === 'running')) {
      stopPolling();
      return;
    }
    if (pollTimerRef.current) return;
    const tick = () => {
      pollTriesRef.current += 1;
      getSourcePushLog(objToken)
        .then(({ logs: next }) => {
          if (!mountedRef.current) return;
          setLogs(next);
          if (next.some((row) => row.revertState === 'running') && pollTriesRef.current < POLL_MAX_TRIES) {
            pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
          } else {
            pollTimerRef.current = null;
            pollTriesRef.current = 0;
            onLogsChanged?.();
          }
        })
        .catch((err) => {
          if (!mountedRef.current) return;
          appLogger.warn('push-log', 'poll failed', err);
          if (pollTriesRef.current < POLL_MAX_TRIES) {
            pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
          } else {
            pollTimerRef.current = null;
            pollTriesRef.current = 0;
          }
        });
    };
    pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [objToken, onLogsChanged, stopPolling]);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    getSourcePushLog(objToken)
      .then(({ logs: rows }) => {
        if (!mountedRef.current) return;
        setLogs(rows);
        schedulePollIfNeeded(rows);
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : '写回记录加载失败');
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });
  }, [objToken, schedulePollIfNeeded]);

  useEffect(() => {
    if (open) refresh();
    else stopPolling();
  }, [open, refresh, stopPolling]);

  return (
    <Drawer open={open} onClose={onClose} title="写回记录" subtitle={`最近 50 次写回与回滚 · ${objToken}`} widthClass="w-[720px] max-w-[94vw]">
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-ink-faint">
            锚点是写回前最新云端历史版本：精确 = 恰为写前状态；近似 = 早于写前状态（回滚会一并撤销此期间修改）。
          </p>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            title="刷新写回记录"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 text-[11px] text-ink-soft transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-40"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>

        {loading && logs == null && (
          <div className="flex items-center justify-center gap-2 py-12 text-ink-faint">
            <Loader2 className="w-4 h-4 animate-spin" />
            <p className="text-sm">正在读取写回记录…</p>
          </div>
        )}
        {error && (
          <div className="rounded-md border border-seal-2/40 bg-seal-2/5 p-3 text-xs text-seal-2 leading-relaxed">{error}</div>
        )}
        {!loading && !error && logs != null && logs.length === 0 && (
          <EmptyState
            icon={<ScrollText className="w-5 h-5" />}
            title="暂无写回记录"
            description="该文档还没有写过回或云端回滚。写回飞书、或从「云端历史」发起回滚后，这里会逐次留下记录与回退锚点。"
          />
        )}
        {logs != null && logs.length > 0 && (
          <ul className="space-y-2" data-testid="push-log-list">
            {logs.map((log) => {
              const outcome = pushOutcomeBadge(log.outcome);
              const anchor = anchorFace(log);
              const gate = rollbackRowGate(log);
              const compareable = log.outcome === 'conflict' || log.outcome === 'unknown';
              return (
                <li key={log.id} className="rounded-md border border-line bg-card-bg p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="inline-flex items-center gap-1.5 text-xs text-ink">
                      <FileClock className="w-3.5 h-3.5 text-ink-faint" />
                      {formatTime(log.createdAt)}
                    </span>
                    <StatusBadge status="neutral" size="sm">{PUSH_MODE_LABEL[log.mode] ?? log.mode}</StatusBadge>
                    <span className="text-[11px] text-ink-faint">{PUSH_ACTOR_LABEL[log.actor] ?? log.actor}</span>
                    <span
                      className={`text-[11px] font-sans-ui ${
                        anchor.kind === 'exact' ? 'text-jade' : anchor.kind === 'inexact' ? 'text-seal' : 'text-ink-faint'
                      }`}
                      title={anchor.title}
                    >
                      {anchor.kind === 'none' ? '无锚点' : `锚点 ${shortHistoryId(log.anchorHistoryId)} · ${anchor.text}`}
                    </span>
                    <span className="ml-auto" data-testid={`push-outcome-${log.outcome}`}>
                      <StatusBadge status={outcome.status} size="sm">{outcome.text}</StatusBadge>
                    </span>
                  </div>

                  {(log.revertState != null || log.postRevisionId != null || log.revertError) && (
                    <p className="text-[11px] text-ink-faint leading-relaxed">
                      {log.postRevisionId ? <>写后 revision {log.postRevisionId} · </> : null}
                      {log.revertState === 'running' && <span className="text-jade">该行回滚进行中（任务 {shortHistoryId(log.revertTaskId)}）…</span>}
                      {log.revertState === 'done' && <>已回滚（{formatTime(log.revertedAt)}）</>}
                      {log.revertState === 'failed' && <span className="text-seal-2">回滚失败：{log.revertError ?? '未知原因'}</span>}
                      {log.revertState === 'unknown' && <span className="text-seal">回滚状态未知：请到飞书历史版本核对</span>}
                    </p>
                  )}
                  {log.outcome === 'unknown' && (
                    <p className="text-[11px] text-seal leading-relaxed">写回结果不确定（超时/重启对账）：写回是否已写入云端未知，请对比云端当前内容后再决定是否重推。</p>
                  )}

                  <div className="flex items-center justify-end gap-2">
                    {compareable && (
                      <button
                        type="button"
                        onClick={() => onRequestCompare(log)}
                        className="inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 text-[11px] text-ink-soft transition-colors hover:bg-paper-2 hover:text-ink"
                      >
                        <GitCompare className="w-3 h-3" />
                        对比云端
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onRequestRevert({ pushLogId: log.id, sourceLabel: `写回记录 · ${PUSH_MODE_LABEL[log.mode] ?? log.mode} ${formatTime(log.createdAt)}` })}
                      disabled={!gate.enabled}
                      title={gate.enabled ? '回滚到该次写回/回滚之前' : gate.reason}
                      className="inline-flex items-center gap-1 rounded-md border border-seal/40 bg-seal/5 px-2 py-1 text-[11px] text-seal transition-colors hover:bg-seal/10 disabled:opacity-40 disabled:cursor-not-allowed"
                      data-testid="push-log-revert"
                    >
                      <RotateCcw className="w-3 h-3" />
                      {log.mode === 'revert' ? '回滚到此行之前' : '回滚到写回前'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {localBody == null && logs != null && logs.length > 0 && (
          <p className="text-[11px] text-ink-faint">提示：本地正文未加载，「对比云端」将以云端不可读状态呈现。</p>
        )}
      </div>
    </Drawer>
  );
}
