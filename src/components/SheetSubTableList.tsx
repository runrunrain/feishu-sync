/**
 * SheetSubTableList - sheet 子表展开列表（T5，04 §7.2 #10）
 *
 * 嵌入 ChangeItem（T4），缩进 1 级，展示 sheet 文档的子表清单。
 * 每个子表标签可点击以单独同步该表（"同步此表"）。
 */

import { Table } from 'lucide-react';
import type { SheetSub } from '../types';

interface SheetSubTableListProps {
  sheets: SheetSub[];
  /** Optional single-sub-table sync handler. */
  onSyncSub?: (sheetId: string) => void;
}

export function SheetSubTableList({ sheets, onSyncSub }: SheetSubTableListProps) {
  if (!sheets || sheets.length === 0) return null;

  return (
    <div className="mt-1.5 ml-7 pl-3 border-l border-line space-y-1">
      <p className="text-[11px] text-ink-faint font-sans-ui">
        {sheets.length} 子表
      </p>
      <div className="flex flex-wrap gap-1.5">
        {sheets.map((s) => {
          const changed = s.status === 'changed' || s.status === 'error';
          return (
            <button
              key={s.sheetId}
              type="button"
              onClick={() => onSyncSub?.(s.sheetId)}
              disabled={!onSyncSub}
              title={onSyncSub ? `同步子表「${s.title}」` : '子表（批量同步中）'}
              className={`group inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-sans-ui transition-colors ${
                changed
                  ? 'border-seal/30 text-seal bg-[rgba(158,43,37,0.04)]'
                  : 'border-line text-ink-soft bg-paper hover:bg-paper-2'
              } ${onSyncSub ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <Table className="w-3 h-3" />
              {s.title}
              {onSyncSub && (
                <span className="opacity-0 group-hover:opacity-100 text-ink-faint transition-opacity">
                  ·同步
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
