/**
 * CloudMovesSection —— 该文档的移出记录列表（P2-S7 状态文案，消费
 * GET /api/sources/moves?objToken=；数据由宿主注入，本组件纯展示）。
 *
 * 每行：发起时间 / 状态徽标（pending→moving→moved/failed/unknown）/
 * 失败原因（failed 行展开）/ 目标与操作者。列表按最新在前渲染
 *（server 返回序）。无记录时不渲染（入口由宿主控制）。
 */

import { FolderOutput } from 'lucide-react';
import { useState } from 'react';
import { reconcileCloudMove } from '../../api/client';
import { StatusBadge } from '../common/StatusBadge';
import type { CloudMoveRecord } from '../../types';
import { cloudMoveStateBadge } from './labels';
import { formatTime } from '../source-history/labels';

const ACTOR_LABEL: Record<string, string> = {
  ui: '界面',
  cli: '命令行',
};

export function CloudMovesSection({ moves, onChanged }: { moves: CloudMoveRecord[]; onChanged?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const reconcile = async (move: CloudMoveRecord, manual?: 'moved' | 'not_moved') => {
    if (busy) return;
    if (manual && !window.confirm(`请先到飞书确认移出任务已结束，且文档${manual === 'moved' ? '已移出' : '仍在原知识库'}。若任务仍在执行，解除保护可能造成后续操作冲突。确认核对结果吗？`)) return;
    setBusy(move.id);
    setMessage(null);
    try {
      const confirm = manual ? `MOVE_SETTLED_${manual === 'moved' ? 'MOVED' : 'NOT_MOVED'}:${move.id}` : undefined;
      const result = await reconcileCloudMove(move.id, confirm);
      if (result.state === 'unknown') {
        setMessage(result.reason === 'task_still_running' ? '云端移出仍在进行，保护继续生效。' : '暂无法确认任务终态或节点身份，保护继续生效。');
      } else {
        setMessage('移出状态已更新。');
        onChanged?.();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '核对移出状态失败');
    } finally { setBusy(null); }
  };
  if (moves.length === 0) return null;
  return (
    <div className="rounded-md border border-line bg-paper-2/40 p-3 space-y-2" data-testid="cloud-moves-section">
      <div className="flex items-center gap-1.5 text-xs text-ink-soft font-medium">
        <FolderOutput className="w-3.5 h-3.5 text-ink-soft" />
        移出记录（{moves.length}）
      </div>
      {message && <p role="status" className="text-xs text-ink-soft">{message}</p>}
      <ul className="space-y-1.5">
        {moves.map((move) => {
          const badge = cloudMoveStateBadge(move.state);
          return (
            <li
              key={move.id}
              data-testid="cloud-move-row"
              data-move-state={move.state}
              className="flex flex-col gap-0.5 rounded border border-line/60 bg-card-bg px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <StatusBadge status={badge.status} size="sm" className="!px-1.5 !text-[10px]">
                  {badge.text}
                </StatusBadge>
                <span className="text-[11px] text-ink-soft font-mono shrink-0" title={`记录 ${move.id}`}>
                  {formatTime(move.createdAt)}
                </span>
                <span className="ml-auto text-[10px] text-ink-faint font-sans-ui shrink-0">
                  {ACTOR_LABEL[move.actor] ?? move.actor} → {move.targetFolderToken ? `文件夹 ${move.targetFolderToken.slice(0, 10)}…` : '个人空间根'}
                </span>
              </div>
              {move.state === 'failed' && move.error ? (
                <p className="text-[11px] text-seal-2 leading-relaxed break-all" data-testid="cloud-move-error">
                  失败原因：{move.error}
                </p>
              ) : null}
              {move.state === 'unknown' ? (
                <div className="space-y-1 text-[11px] text-ink-faint leading-relaxed">
                  <p>结果未知，保护仍生效。请核对云端任务是否结束及文档去向。</p>
                  <div className="flex flex-wrap gap-2">
                    {move.taskId && <button type="button" disabled={busy != null} onClick={() => void reconcile(move)} className="underline">查询任务</button>}
                    <button type="button" disabled={busy != null} onClick={() => void reconcile(move, 'not_moved')} className="underline">确认已结束且未移出</button>
                    <button type="button" disabled={busy != null} onClick={() => void reconcile(move, 'moved')} className="underline">确认已结束且已移出</button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
