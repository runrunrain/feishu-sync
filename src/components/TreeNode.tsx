/**
 * TreeNode - 单个节点树行（T3 R2.2/R2.2bis，04 §3.2）
 *
 * 行高 28px。元素：折叠箭头 / 类型图标 / 业务标记独立标签 /
 * 标题 / 变更徽章 / 同步状态点 / 相对时间 / 同级拖拽手柄。
 *
 * 决策5：仅同级拖拽排序（HTML5 DnD）；跨父拒绝由 NodeTreeView 统一处理。
 */

import { ChevronRight, FileText, Table, FileType, Folder } from 'lucide-react';
import { BusinessTag } from './common/BusinessTag';
import { StatusBadge } from './common/StatusBadge';
import type { MappingNode } from '../types';

interface TreeNodeProps {
  node: MappingNode;
  level: number;
  expanded: boolean;
  selected: boolean;
  hasChildren: boolean;
  /** Business marks (T/D/R) — independent tag, decision 1. */
  businessMarks?: string[];
  onToggle: (objToken: string) => void;
  onSelect: (objToken: string) => void;
  /** HTML5 DnD handlers (decision 5, same-level reorder only). */
  onDragStart: (e: React.DragEvent, node: MappingNode) => void;
  onDragOver: (e: React.DragEvent, node: MappingNode) => void;
  onDragLeave: (e: React.DragEvent, node: MappingNode) => void;
  onDrop: (e: React.DragEvent, node: MappingNode) => void;
  isDropTargetBefore?: boolean;
  isDropTargetAfter?: boolean;
  isDragging?: boolean;
}

const TYPE_ICON = {
  docx: FileText,
  sheet: Table,
  slides: FileType,
  unknown: FileType,
};

// Map node status → tiny dot color (synced=jade, changed=seal, error=seal-2,
// placeholder=ink-faint hollow). 04 §3.2.
const STATUS_DOT: Record<MappingNode['status'], string> = {
  synced: 'bg-jade',
  changed: 'bg-seal animate-pulse-seal',
  error: 'bg-seal-2',
  placeholder: 'bg-transparent border border-ink-faint',
};

function formatRelative(unixSeconds: number | null): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - unixSeconds);
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}h`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  // The tree is deliberately compact. An ISO date (10 characters) can push
  // the title completely out of a narrow sidebar at deep nesting levels;
  // day counts remain precise enough for this at-a-glance indicator.
  return `${Math.floor(diff / 86400)}d`;
}

export function TreeNode({
  node,
  level,
  expanded,
  selected,
  hasChildren,
  businessMarks,
  onToggle,
  onSelect,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  isDropTargetBefore,
  isDropTargetAfter,
  isDragging,
}: TreeNodeProps) {
  const TypeIcon = hasChildren ? Folder : (TYPE_ICON[node.obj_type] ?? FileType);
  const showChangedBadge =
    node.status === 'changed' || node.cloud_deleted === 1;
  // v0.2.5 层级视觉：顶层节点（level 0）文字/图标大于深层；深层不再与顶层同尺寸。
  const isRootLevel = level === 0;

  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected}
      className={`relative group ${isDragging ? 'tree-node--dragging' : ''}`}
      style={{ paddingLeft: 0 }}
    >
      {/*
        TreeNode 布局重构（2026-06-19）：
        - 行高 28px→32px：4px 增量大幅改善节点之间的呼吸（04 §3.2 原为 28px，
          实际渲染时元素密集导致视觉拥挤；32px 在保持紧凑的同时提供视觉缓冲）
        - 内部 gap-1.5→gap-2，图标与文字之间不再挤压
        - 缩进 8px/级、上限 40px（2026-06-20 由 10px/级、上限 48px 收紧，
          把空间让给标题，深层节点标题可读性优先）
      */}
      {isDropTargetBefore && <div className="tree-drop-indicator" />}
      <div
        className={`flex min-w-0 items-center gap-2 h-8 overflow-hidden pr-2.5 rounded-sm cursor-pointer transition-all duration-150 ${
          selected
            ? 'bg-seal/[0.08] shadow-[inset_0_0_0_1px_rgba(158,43,37,0.12)]'
            : 'hover:bg-paper-2 active:bg-paper-2/70'
        } ${selected ? 'before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[3px] before:rounded-full before:bg-seal' : ''}`}
        style={{ paddingLeft: Math.min(8 + level * 8, 40) }}
        onClick={() => onSelect(node.obj_token)}
        draggable
        onDragStart={(e) => onDragStart(e, node)}
        onDragOver={(e) => onDragOver(e, node)}
        onDragLeave={(e) => onDragLeave(e, node)}
        onDrop={(e) => onDrop(e, node)}
      >
        {/* The entire row remains draggable. Hiding the handle keeps deep
            nodes usable inside the compact 280px sidebar. */}
        <span
          aria-hidden
          className="hidden shrink-0 w-3 text-ink-faint/40 group-hover:text-ink-faint cursor-grab active:cursor-grabbing select-none"
          title="拖拽以调整同级顺序"
        >
          <svg viewBox="0 0 6 12" className="w-1.5 h-3 fill-current">
            <circle cx="1.5" cy="2" r="0.9" />
            <circle cx="4.5" cy="2" r="0.9" />
            <circle cx="1.5" cy="6" r="0.9" />
            <circle cx="4.5" cy="6" r="0.9" />
            <circle cx="1.5" cy="10" r="0.9" />
            <circle cx="4.5" cy="10" r="0.9" />
          </svg>
        </span>

        {/* Collapse/expand arrow (only when has children) */}
        <span className="shrink-0 w-3.5">
          {hasChildren ? (
            <button
              type="button"
              aria-label={expanded ? '收起' : '展开'}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(node.obj_token);
              }}
              className="text-ink-faint hover:text-ink"
            >
              <ChevronRight
                className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
              />
            </button>
          ) : null}
        </span>

        {/* Type icon */}
        <TypeIcon className={`${isRootLevel ? 'w-4 h-4' : 'w-3.5 h-3.5'} shrink-0 transition-colors ${selected ? 'text-seal' : 'text-ink-soft'}`} />

        {/* Business marks (independent tag, decision 1) */}
        {businessMarks && businessMarks.length > 0 && (
          <BusinessTag marks={businessMarks} />
        )}

        {/* Title */}
        <span
          className={`min-w-0 flex-1 truncate ${isRootLevel ? 'text-[13px]' : 'text-[12px]'} ${
            node.cloud_deleted === 1
              ? 'text-ink-faint line-through'
              : selected
                ? 'text-seal font-medium'
                : 'text-ink'
          }`}
          style={{ fontFamily: 'var(--serif)' }}
          title={node.title}
        >
          {node.title}
        </span>

        {/* Change badge */}
        {showChangedBadge && (
          <StatusBadge
            status={node.cloud_deleted === 1 ? 'deleted' : node.status === 'error' ? 'error' : 'modified'}
            size="sm"
          >
            {node.cloud_deleted === 1 ? '已删除' : '变更'}
          </StatusBadge>
        )}

        {/* Status dot */}
        <span
          title={`状态：${node.status}`}
          className={`shrink-0 w-1.5 h-1.5 rounded-full ${STATUS_DOT[node.status]}`}
        />

        {/* Relative time (only for changed nodes) */}
        {showChangedBadge && (
          <span className="shrink-0 text-[11px] text-ink-faint font-mono">
            {formatRelative(node.obj_edit_time)}
          </span>
        )}
      </div>
      {isDropTargetAfter && <div className="tree-drop-indicator" />}
    </div>
  );
}
