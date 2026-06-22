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
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
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
        - 缩进 14px/级 保持（与原设计一致）
      */}
      {isDropTargetBefore && <div className="tree-drop-indicator" />}
      <div
        className={`flex items-center gap-2 h-8 pr-2.5 rounded-sm cursor-pointer transition-colors ${
          selected
            ? 'bg-[rgba(158,43,37,0.04)]'
            : 'hover:bg-paper-2'
        } ${selected ? 'before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 before:bg-seal' : ''}`}
        style={{ paddingLeft: 8 + level * 14 }}
        onClick={() => onSelect(node.obj_token)}
        draggable
        onDragStart={(e) => onDragStart(e, node)}
        onDragOver={(e) => onDragOver(e, node)}
        onDragLeave={(e) => onDragLeave(e, node)}
        onDrop={(e) => onDrop(e, node)}
      >
        {/* Drag handle (visible on hover) */}
        <span
          aria-hidden
          className="shrink-0 w-3 text-ink-faint/40 group-hover:text-ink-faint cursor-grab active:cursor-grabbing select-none"
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
        <TypeIcon className="w-4 h-4 text-ink-soft shrink-0" />

        {/* Business marks (independent tag, decision 1) */}
        {businessMarks && businessMarks.length > 0 && (
          <BusinessTag marks={businessMarks} />
        )}

        {/* Title */}
        <span
          className={`flex-1 truncate text-[13px] ${
            node.cloud_deleted === 1 ? 'text-ink-faint line-through' : 'text-ink'
          }`}
          style={{ fontFamily: 'var(--serif)' }}
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
