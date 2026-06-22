/**
 * BatchActionBar - 批量操作栏（T4 R2.3，04 §5.4）
 *
 * 根据选中状态展示不同操作：
 *   - 0 项：提示选择
 *   - N 项（仅 added/modified）：批量同步 / 批量跳过
 *   - 含 deleted：禁用批量同步，提示单独处理删除项
 */

import { CheckSquare, Square, ArrowRight } from 'lucide-react';

interface BatchActionBarProps {
  selectedCount: number;
  totalSelectable: number;
  hasDeleted: boolean;
  onSelectAll: () => void;
  onInvert: () => void;
  onBatchSync: () => void;
  onBatchSkip: () => void;
  allSelected: boolean;
}

export function BatchActionBar({
  selectedCount,
  totalSelectable,
  hasDeleted,
  onSelectAll,
  onInvert,
  onBatchSync,
  onBatchSkip,
  allSelected,
}: BatchActionBarProps) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-paper-2/60 border border-line rounded-md">
      {/*
        批量操作栏布局重构（2026-06-19）：
        - px-3 py-2→px-4 py-2.5：内部 padding 与 ChangeItem 行一致
        - 内部 gap-2→gap-2.5：左半按钮组与右半操作组各自拉开
        - 按钮 px-2 py-1→px-2.5 py-1.5：小按钮 +2px 横向 +2px 纵向，避免误点
      */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onSelectAll}
          disabled={totalSelectable === 0}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-ink-soft border border-line rounded bg-card-bg hover:bg-paper font-sans-ui transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {allSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
          {allSelected ? '取消全选' : '全选'}
        </button>
        <button
          type="button"
          onClick={onInvert}
          disabled={totalSelectable === 0}
          className="inline-flex items-center px-2.5 py-1.5 text-xs text-ink-soft border border-line rounded bg-card-bg hover:bg-paper font-sans-ui transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          反选
        </button>
        <span className="text-xs text-ink-soft font-sans-ui ml-1.5">
          已选 {selectedCount} 项{hasDeleted ? '（含删除）' : ''}
        </span>
      </div>

      <div className="flex items-center gap-2.5">
        {selectedCount === 0 ? (
          <span className="text-xs text-ink-faint font-sans-ui">请选择要同步的文档</span>
        ) : (
          <>
            <button
              type="button"
              onClick={onBatchSkip}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-ink-soft border border-line rounded bg-card-bg hover:bg-paper font-sans-ui transition-colors"
            >
              批量跳过
            </button>
            <button
              type="button"
              onClick={onBatchSync}
              disabled={hasDeleted && selectedCount === 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs text-white bg-seal hover:bg-seal-2 rounded font-sans-ui transition-colors disabled:opacity-50"
            >
              批量同步
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
            {hasDeleted && (
              <span className="text-[11px] text-ink-faint font-sans-ui">
                删除项需单独移入回收站
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
