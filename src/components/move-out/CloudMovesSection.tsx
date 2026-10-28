/**
 * CloudMovesSection —— 该文档的移出记录列表（P2-S7 状态文案，消费
 * GET /api/sources/moves?objToken=；数据由宿主注入，本组件纯展示）。
 *
 * 每行：发起时间 / 状态徽标（pending→moving→moved/failed/unknown）/
 * 失败原因（failed 行展开）/ 目标与操作者。列表按最新在前渲染
 *（server 返回序）。无记录时不渲染（入口由宿主控制）。
 */

import { FolderOutput } from 'lucide-react';
import { StatusBadge } from '../common/StatusBadge';
import type { CloudMoveRecord } from '../../types';
import { cloudMoveStateBadge } from './labels';
import { formatTime } from '../source-history/labels';

const ACTOR_LABEL: Record<string, string> = {
  ui: '界面',
  cli: '命令行',
};

export function CloudMovesSection({ moves }: { moves: CloudMoveRecord[] }) {
  if (moves.length === 0) return null;
  return (
    <div className="rounded-md border border-line bg-paper-2/40 p-3 space-y-2" data-testid="cloud-moves-section">
      <div className="flex items-center gap-1.5 text-xs text-ink-soft font-medium">
        <FolderOutput className="w-3.5 h-3.5 text-ink-soft" />
        移出记录（{moves.length}）
      </div>
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
                <p className="text-[11px] text-ink-faint leading-relaxed">
                  结果不确定（不自动重试）：请到飞书知识库核对该节点是否仍在树内，核对后只读刷新即可收敛展示。
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
