/**
 * SyncProgress - 同步进度（T6，04 §4.2.1 / §7.2 #13）
 *
 * dry-run 核验进行中显示。useSync.syncDocuments 是 batch-style（一次性返回 SyncResult），
 * 当前 server 不暴露流式进度（/api/sync 等到全部完成才返回），因此 UI 在
 * syncing=true 期间展示 indeterminate 进度 + 已知总数；服务端真实流式接入
 * 待 P5 SSE/WebSocket 改造（已记录在 P5 待办）。
 *
 * 不接受猜测的 percent——仅在 syncing=true 时显示活动指示，避免误导。
 */

import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardBody } from './common/Card';

interface SyncProgressProps {
  syncing: boolean;
  total: number;
  /** Number of items already confirmed done (best-effort, often 0 until result arrives). */
  done?: number;
}

export function SyncProgress({ syncing, total, done = 0 }: SyncProgressProps) {
  if (!syncing) return null;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <Card variant="default" className="border-seal/20">
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-seal animate-spin" />
            <span className="text-sm text-ink">核验中…</span>
            {total > 0 && (
              <span className="text-xs text-ink-faint font-sans-ui">
                {done} / {total}
              </span>
            )}
          </div>
          <span className="text-xs text-ink-faint font-sans-ui">{pct}%</span>
        </div>

        {/* Indeterminate bar when no progress granularity; determinate when done>0. */}
        <div className="w-full h-1.5 bg-paper-2 rounded-full overflow-hidden">
          {done > 0 ? (
            <div
              className="h-full bg-seal transition-all duration-normal"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="h-full w-1/3 bg-seal/60 animate-pulse" />
          )}
        </div>

        <p className="text-[11px] text-ink-faint">
          后端为整批 dry-run 核验（不流式返回）；请等待完成查看预览。
          <CheckCircle2 className="inline w-3 h-3 text-jade ml-2 mr-0.5" />
          通过核验
          <XCircle className="inline w-3 h-3 text-seal-2 ml-2 mr-0.5" />
          失败项将在预览面板分组展示
        </p>
      </CardBody>
    </Card>
  );
}
