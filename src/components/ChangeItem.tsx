/**
 * ChangeItem - 变更列表项（T4 R2.3-AC1/AC2，04 §5.3）
 *
 * 三状态视觉编码（颜色+图标+文字三重）：
 *   - added    jade #6b8e8a  / Plus      / "新增"
 *   - modified seal #9e2b25 / PencilLine / "已修改"
 *   - deleted  ink-faint    / Archive    / "已删除"
 *
 * 删除项不进批量同步，单独显示「移入回收站」「永久清理」入口。
 * 回收站抽屉本体在 P4-2，本 Task 仅留按钮入口。
 */

import { useState } from 'react';
import {
  FileText,
  Table,
  FileType,
  Plus,
  PencilLine,
  Archive,
  ChevronRight,
  Clock,
  Trash2,
} from 'lucide-react';
import { StatusBadge } from './common/StatusBadge';
import { BusinessTag } from './common/BusinessTag';
import { SheetSubTableList } from './SheetSubTableList';
import type { ChangedDocument, SheetSub } from '../types';

interface ChangeItemProps {
  change: ChangedDocument;
  selected: boolean;
  onToggleSelect: (objToken: string) => void;
  /** Optional sub-sheets (only sheet documents). */
  sheets?: SheetSub[];
  /** Optional business marks (e.g. T/D/R). */
  businessMarks?: string[];
  onSyncSub?: (sheetId: string) => void;
  /** Deleted-state actions. */
  onTrash?: (objToken: string) => void;
  onPurge?: (objToken: string) => void;
}

const TYPE_ICON = {
  docx: FileText,
  sheet: Table,
  slides: FileType,
  unknown: FileType,
};

const STATE_ICON = {
  added: Plus,
  modified: PencilLine,
  deleted: Archive,
};

const STATE_LABEL = {
  added: '新增',
  modified: '已修改',
  deleted: '已删除',
};

function formatRelativeTime(unixSecondsStr: string): string {
  const t = parseInt(unixSecondsStr, 10);
  if (!Number.isFinite(t)) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - t);
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ChangeItem({
  change,
  selected,
  onToggleSelect,
  sheets,
  businessMarks,
  onSyncSub,
  onTrash,
  onPurge,
}: ChangeItemProps) {
  const [expanded, setExpanded] = useState(false);
  const isDeleted = change.changeType === 'deleted';
  const StateIcon = STATE_ICON[change.changeType];
  const TypeIcon = TYPE_ICON[change.objType] ?? FileType;

  const stateBgClass =
    change.changeType === 'added'
      ? 'row-state-added'
      : change.changeType === 'modified'
        ? 'row-state-modified'
        : 'row-state-deleted';

  const rowBg = selected ? 'bg-seal/5' : stateBgClass;

  return (
    <div
      className={`rounded-md border transition-colors ${rowBg} ${
        selected ? 'border-seal/30' : 'border-line'
      }`}
    >
      <div
        className="flex items-center gap-3 px-3 py-2.5 cursor-pointer"
        onClick={() => onToggleSelect(change.objToken)}
        role="button"
        tabIndex={0}
      >
        {/* Checkbox (disabled for deleted: cannot batch-sync) */}
        <span
          className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
            isDeleted
              ? 'border-line bg-paper-2 cursor-not-allowed opacity-60'
              : selected
                ? 'border-seal bg-seal text-white'
                : 'border-line bg-card-bg hover:border-seal/60'
          }`}
          aria-label={isDeleted ? '删除项不可批量同步' : selected ? '取消选择' : '选择'}
        >
          {!isDeleted && selected && (
            <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M2.5 6.5L5 9L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>

        {/* Type icon */}
        <TypeIcon className="w-4 h-4 text-ink-soft shrink-0" />

        {/* Title + business tags */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm truncate ${isDeleted ? 'text-ink-faint line-through' : 'text-ink'}`}>
              {change.title}
            </span>
            {businessMarks && businessMarks.length > 0 && (
              <BusinessTag marks={businessMarks} />
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-ink-faint">
            <span className="uppercase font-sans-ui">{change.objType}</span>
            <span aria-hidden>·</span>
            <span className="font-mono truncate max-w-[280px]">
              {change.localMdPath || '尚未同步'}
            </span>
          </div>
        </div>

        {/* State badge */}
        <StatusBadge status={change.changeType} size="sm" hideDot={false}>
          <span className="inline-flex items-center gap-1">
            <StateIcon className="w-3 h-3" />
            {STATE_LABEL[change.changeType]}
          </span>
        </StatusBadge>

        {/* Time */}
        <div className="shrink-0 flex items-center gap-1 text-[11px] text-ink-faint font-mono">
          <Clock className="w-3 h-3" />
          {formatRelativeTime(change.cloudModifiedTime) || '--'}
        </div>

        {/* Expand chevron (sheet has sub-tables) */}
        {change.objType === 'sheet' && sheets && sheets.length > 0 && (
          <button
            type="button"
            aria-label={expanded ? '收起子表' : '展开子表'}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="shrink-0 text-ink-faint hover:text-ink transition-colors"
          >
            <ChevronRight className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
        )}
      </div>

      {/* Deleted-state action row (not batch-syncable) */}
      {isDeleted && (
        <div className="flex items-center gap-2 px-3 pb-2.5 -mt-1">
          <span className="inline-flex items-center gap-1 text-[11px] text-ink-faint">
            <Archive className="w-3 h-3" />
            云端已删除 · 本地副本保留
          </span>
          <div className="flex-1" />
          {onTrash && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTrash(change.objToken);
              }}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-ink-soft border border-line rounded bg-card-bg hover:bg-paper-2 font-sans-ui"
            >
              移入回收站
            </button>
          )}
          {onPurge && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPurge(change.objToken);
              }}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-seal-2 border border-seal-2/40 rounded bg-card-bg hover:bg-seal-2/5 font-sans-ui"
            >
              <Trash2 className="w-3 h-3" />
              永久清理
            </button>
          )}
        </div>
      )}

      {/* Sheet sub-tables (expanded) */}
      {change.objType === 'sheet' && expanded && sheets && sheets.length > 0 && (
        <div className="px-3 pb-2.5">
          <SheetSubTableList sheets={sheets} onSyncSub={onSyncSub} />
        </div>
      )}
    </div>
  );
}
