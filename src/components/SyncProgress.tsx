/**
 * SyncProgress - 顶部常驻同步进度条（2026-09 重构）
 *
 * - 位置：挂在同步主区最顶部，sticky 跟随滚动——同步期间始终可见，
 *   不再被挤到页面底部；
 * - 真实进度：useSync.syncDocuments 逐文档串行提交（后端按文档独立原子
 *   提交，语义等价），每完成一篇推进 done；百分比与「done / total」
 *   均为真实数值；
 * - 当前文档：currentTitle 实时显示正在同步的文档名（截断保护 +
 *   title 属性悬浮看全名）；
 * - 失败计数实时可见（failedCount），完成后由结果报告面板接管详情。
 */

import { Loader2, FileText, CheckCircle2, XCircle } from 'lucide-react';

interface SyncProgressProps {
  syncing: boolean;
  total: number;
  /** 已完成（成功+失败）文档数——真实进度，逐文档提交驱动。 */
  done: number;
  /** 当前正在同步的文档标题。 */
  currentTitle?: string | null;
  /** 本次已失败文档数（实时）。 */
  failedCount?: number;
}

export function SyncProgress({
  syncing,
  total,
  done,
  currentTitle = null,
  failedCount = 0,
}: SyncProgressProps) {
  if (!syncing) return null;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-30 rounded-md border border-seal/25 bg-card-bg/95 backdrop-blur-sm shadow-sm px-4 py-2.5"
    >
      <div className="flex items-center gap-3">
        <Loader2 className="w-4 h-4 text-seal animate-spin shrink-0" />
        <div className="min-w-0 flex-1 flex items-center gap-2.5">
          <span className="text-sm text-ink font-medium whitespace-nowrap">同步中</span>
          <span className="text-xs text-ink-faint font-sans-ui tabular-nums whitespace-nowrap">
            {done} / {total} · {pct}%
          </span>
          {/* 当前正在同步的文档 */}
          <span className="min-w-0 flex items-center gap-1.5 text-xs text-ink-soft font-sans-ui">
            <FileText className="w-3.5 h-3.5 shrink-0 text-seal/70" />
            <span className="truncate" title={currentTitle ?? undefined}>
              {currentTitle ?? '…'}
            </span>
          </span>
          {(failedCount ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-seal-2 font-sans-ui whitespace-nowrap">
              <XCircle className="w-3.5 h-3.5" />
              {failedCount} 失败
            </span>
          )}
        </div>
        <CheckCircle2 className="w-4 h-4 text-jade/70 shrink-0" aria-hidden />
      </div>

      {/* 真实确定性进度条 */}
      <div className="mt-2 w-full h-1.5 bg-paper-2 rounded-full overflow-hidden">
        <div
          className="h-full bg-seal transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
