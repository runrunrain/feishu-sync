/**
 * ChangeItem - 变更列表项（高密度紧凑行组件）
 *
 * 遵循水墨中国风设计系统（米白宣纸、印章朱红、水墨青、墨色），
 * 固定紧凑单行模式（行高 34px），提供高密度高扫描效率展示。
 *
 * 三状态视觉编码（颜色+图标+文字三重）：
 *   - added    jade #6b8e8a  / Plus      / "新增"
 *   - modified seal #9e2b25 / PencilLine / "已修改"
 *   - deleted  ink-faint    / Archive    / "已删除"
 *
 * 行展开详情（Expanded Detail View）：
 *   - 本地/归档完整路径展示，支持快捷复制与「在文件夹中打开」
 *   - sheet 子表清单展示与单独同步（SheetSubTableList）
 *   - 云端已删除项支持「移入回收站」「永久清理」
 *   - 图片缺失原因说明（mediaGapReason）
 */

import { useState, type MouseEvent, type KeyboardEvent } from 'react';
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
  Copy,
  Check,
  FolderOpen,
  Info,
} from 'lucide-react';
import { StatusBadge } from './common/StatusBadge';
import { BusinessTag } from './common/BusinessTag';
import { SheetSubTableList } from './SheetSubTableList';
import { useToast } from './common/Toast';
import type { ChangedDocument, SheetSub } from '../types';
import { formatCloudModifiedTime } from '../utils/cloudTime';

export interface ChangeItemProps {
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
  /** Optional handler to reveal/open document local folder */
  onOpenFolder?: (localMdPath: string) => void;
  /** 批量处理进行中：禁用单条「移入回收站/永久清理」，防重复提交。 */
  actionDisabled?: boolean;
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

/** 将可能包含冗长绝对路径的 localMdPath 格式化为清晰的相对路径显示 */
function getDisplayPath(change: ChangedDocument): string {
  if (change.localRelPath) return change.localRelPath;
  if (!change.localMdPath) return '尚未同步';
  const p = change.localMdPath;
  // 若为包含知识库名称的长绝对路径，提取最后的相对层级
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length > 3) {
    return parts.slice(-3).join('/');
  }
  return p;
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
  onOpenFolder,
  actionDisabled = false,
}: ChangeItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const isDeleted = change.changeType === 'deleted';
  const StateIcon = STATE_ICON[change.changeType];
  const TypeIcon = TYPE_ICON[change.objType] ?? FileType;
  const isSheet = change.objType === 'sheet';
  const hasSubSheets = isSheet && Array.isArray(sheets) && sheets.length > 0;
  const isCustomArchive = Boolean(change.localMdPath && change.localMdPath.startsWith('_custom/'));

  const stateBgClass =
    change.changeType === 'added'
      ? 'row-state-added'
      : change.changeType === 'modified'
        ? 'row-state-modified'
        : 'row-state-deleted';

  const handleRowClick = () => {
    if (isDeleted) {
      // 已删除项不可批量勾选，点击整行展开/收起详情
      setExpanded((v) => !v);
      return;
    }
    onToggleSelect(change.objToken);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      handleRowClick();
    }
  };

  const handleCopyPath = async (e: MouseEvent) => {
    e.stopPropagation();
    const textToCopy = change.localMdPath || change.objToken;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(textToCopy);
      } else {
        const input = document.createElement('input');
        input.value = textToCopy;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }
      setCopied(true);
      toast.push({ type: 'success', message: '已复制路径' });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.push({ type: 'warning', message: '复制路径失败，请手动选择' });
    }
  };

  const handleOpenDirectory = (e: MouseEvent) => {
    e.stopPropagation();
    if (!change.localMdPath) {
      toast.push({ type: 'info', message: '文档尚未同步，无本地目录' });
      return;
    }
    onOpenFolder?.(change.localMdPath);
  };

  const displayPath = getDisplayPath(change);

  return (
    <div
      className={`border-b border-line/40 last:border-b-0 transition-colors ${
        selected ? 'bg-seal/[0.06] border-l-2 border-l-seal' : `${stateBgClass} hover:bg-paper-2/60`
      }`}
    >
      <div
        className="flex items-center gap-2.5 px-3 min-h-[34px] py-1.5 cursor-pointer select-none focus:outline-none focus:bg-paper-2/80"
        onClick={handleRowClick}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        aria-label={`${change.title} - ${STATE_LABEL[change.changeType]}`}
      >
        {/* Checkbox (32px 居中对齐，删除项禁用不可批量同步) */}
        <div
          className="shrink-0 w-8 flex items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            if (!isDeleted) onToggleSelect(change.objToken);
          }}
        >
          <span
            className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-all ${
              isDeleted
                ? 'border-line/60 bg-paper-2/80 cursor-not-allowed opacity-50'
                : selected
                  ? 'border-seal bg-seal text-white shadow-xs'
                  : 'border-line bg-card-bg hover:border-seal/60'
            }`}
            aria-label={isDeleted ? '删除项不可批量同步' : selected ? '取消选择' : '选择'}
          >
            {!isDeleted && selected && (
              <svg
                viewBox="0 0 12 12"
                className="w-2.5 h-2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M2.5 6.5L5 9L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
        </div>

        {/* Type icon (14px 墨色图标) */}
        <div className="shrink-0 flex items-center justify-center text-ink-soft">
          <TypeIcon className="w-3.5 h-3.5" />
        </div>

        {/* Title + Path (主导弹性伸缩列) */}
        <div className="flex-1 min-w-0 pr-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`text-xs font-medium truncate shrink-0 max-w-[55%] md:max-w-[65%] lg:max-w-[72%] ${
                isDeleted ? 'text-ink-faint line-through' : 'text-ink'
              }`}
              title={change.title}
            >
              {change.title}
            </span>

            {/* 缺失修复徽章 */}
            {change.mediaGapReason && (
              <span
                className="inline-flex items-center px-1 py-0.2 rounded text-[10px] font-sans-ui bg-seal/10 text-seal border border-seal/25 shrink-0"
                title={`图片缺失待修复: ${change.mediaGapReason}`}
              >
                图片缺失
              </span>
            )}

            {/* 业务标签 */}
            {businessMarks && businessMarks.length > 0 && (
              <div className="shrink-0">
                <BusinessTag marks={businessMarks} />
              </div>
            )}

            {/* 次级路径（淡墨色等宽字体，超出截断） */}
            <span
              className="text-[11px] text-ink-faint font-mono truncate min-w-0 flex-1 hidden sm:inline-block"
              title={change.localMdPath || change.localRelPath || '尚未同步'}
            >
              <span className="text-ink-faint/40 mr-1.5">/</span>
              {displayPath}
            </span>
          </div>
        </div>

        {/* State badge 列（固定对齐宽约 96px~104px） */}
        <div className="shrink-0 w-22 sm:w-26 flex items-center justify-start">
          <StatusBadge status={change.changeType} size="sm" hideDot={false}>
            <span className="inline-flex items-center gap-1">
              <StateIcon className="w-2.5 h-2.5" />
              {STATE_LABEL[change.changeType]}
            </span>
          </StatusBadge>
        </div>

        {/* Time 列（固定对齐宽约 96px~104px） */}
        <div
          className="shrink-0 w-22 sm:w-26 flex items-center justify-end gap-1 text-[11px] text-ink-faint font-mono"
          title={`云端更新: ${change.cloudModifiedTime || '未知'}`}
        >
          <Clock className="w-3 h-3 text-ink-faint/70 shrink-0" />
          <span className="truncate">{formatCloudModifiedTime(change.cloudModifiedTime)}</span>
        </div>

        {/* Detail Expand Chevron 列（宽约 36px，居中） */}
        <div className="shrink-0 w-9 flex items-center justify-center">
          <button
            type="button"
            aria-label={expanded ? '收起详情' : '展开详情'}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className={`p-1 rounded text-ink-faint hover:text-ink hover:bg-paper-2 transition-colors cursor-pointer ${
              expanded ? 'text-seal' : ''
            } ${hasSubSheets ? 'text-jade font-medium' : ''}`}
            title={hasSubSheets ? `含 ${sheets?.length} 个子表 (点击展开)` : '查看文档详情与操作'}
          >
            <ChevronRight
              className={`w-3.5 h-3.5 transition-transform duration-150 ${
                expanded ? 'rotate-90' : ''
              }`}
            />
          </button>
        </div>
      </div>

      {/* 行展开详情区（Expanded Area） */}
      {expanded && (
        <div className="px-4 py-2.5 bg-paper-2/50 border-t border-line/40 text-xs text-ink space-y-2.5 animate-fade-in">
          {/* 路径与元信息 */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-card-bg/90 p-2.5 rounded border border-line/60">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="shrink-0 text-[11px] font-sans-ui text-ink-soft font-medium">
                {isCustomArchive ? '归档路径:' : '本地路径:'}
              </span>
              <code
                className="text-[11px] font-mono text-ink bg-paper px-2 py-0.5 rounded border border-line/40 truncate select-all flex-1"
                title={change.localMdPath || '尚未同步'}
              >
                {change.localMdPath || '尚未同步（写入本地时将按层级生成）'}
              </code>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {change.localMdPath && (
                <>
                  <button
                    type="button"
                    onClick={handleCopyPath}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-ink-soft border border-line rounded bg-card-bg hover:bg-paper font-sans-ui transition-colors cursor-pointer"
                    title="复制相对路径"
                  >
                    {copied ? <Check className="w-3 h-3 text-jade" /> : <Copy className="w-3 h-3" />}
                    {copied ? '已复制' : '复制路径'}
                  </button>

                  {onOpenFolder && (
                    <button
                      type="button"
                      onClick={handleOpenDirectory}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-ink-soft border border-line rounded bg-card-bg hover:bg-paper font-sans-ui transition-colors cursor-pointer"
                      title="打开所在目录"
                    >
                      <FolderOpen className="w-3 h-3" />
                      打开目录
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 图片缺失原因说明 */}
          {change.mediaGapReason && (
            <div className="flex items-start gap-2 p-2 rounded bg-seal/5 border border-seal/20 text-ink-soft text-[11px] font-sans-ui">
              <Info className="w-3.5 h-3.5 text-seal shrink-0 mt-0.5" />
              <div>
                <span className="text-seal font-medium">图片缺失待修复原因：</span>
                {change.mediaGapReason}
              </div>
            </div>
          )}

          {/* Sheet 子表展开 */}
          {isSheet && sheets && sheets.length > 0 && (
            <div className="pt-1">
              <SheetSubTableList sheets={sheets} onSyncSub={onSyncSub} />
            </div>
          )}

          {/* 已删除项操作条（云端已删除，本地副本保留） */}
          {isDeleted && (
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-line/30">
              <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-faint">
                <Archive className="w-3.5 h-3.5 text-ink-faint" />
                云端已删除 · 本地副本仍保留
              </span>
              <div className="flex items-center gap-2">
                {onTrash && (
                  <button
                    type="button"
                    disabled={actionDisabled}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTrash(change.objToken);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] text-ink-soft border border-line rounded bg-card-bg hover:bg-paper font-sans-ui transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    移入回收站
                  </button>
                )}
                {onPurge && (
                  <button
                    type="button"
                    disabled={actionDisabled}
                    onClick={(e) => {
                      e.stopPropagation();
                      onPurge(change.objToken);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] text-seal-2 border border-seal-2/40 rounded bg-card-bg hover:bg-seal-2/5 font-sans-ui transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-3 h-3" />
                    永久清理
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
