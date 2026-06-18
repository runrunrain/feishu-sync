/**
 * RecentChanges - 最近变更卡片流（T12，04 §4.1）
 *
 * 总览右栏，展示最近 10 条变更（取自 DiffReport）。点击跳转同步区。
 */

import { FileText, Table, FileType, ArrowRight, Clock, Inbox } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import type { ChangedDocument } from '../types';

interface RecentChangesProps {
  changes: ChangedDocument[];
  maxItems?: number;
  onJumpToSync?: () => void;
}

const TYPE_ICON = {
  docx: FileText,
  sheet: Table,
  slides: FileType,
  unknown: FileType,
};

const STATE_LABEL = {
  added: '新增',
  modified: '已修改',
  deleted: '已删除',
};

function formatRelativeTime(unixSecondsStr: string): string {
  const t = parseInt(unixSecondsStr, 10);
  if (!Number.isFinite(t)) return '--';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(t * 1000).toISOString().slice(0, 10);
}

export function RecentChanges({
  changes,
  maxItems = 10,
  onJumpToSync,
}: RecentChangesProps) {
  const visible = changes.slice(0, maxItems);

  return (
    <Card variant="default">
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-kai font-medium text-ink">最近变更</h2>
          <button
            type="button"
            onClick={onJumpToSync}
            className="inline-flex items-center gap-1 text-xs text-seal hover:text-seal-2 font-sans-ui"
          >
            查看全部
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </CardHeader>
      <CardBody className="space-y-1.5">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-center">
            <Inbox className="w-8 h-8 text-ink-faint mb-2" />
            <p className="text-sm text-ink-soft">暂无变更</p>
            <p className="text-xs text-ink-faint mt-1">一切就绪</p>
          </div>
        ) : (
          visible.map((c) => {
            const TypeIcon = TYPE_ICON[c.objType] ?? FileType;
            return (
              <div
                key={c.objToken}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-paper-2 cursor-pointer"
                onClick={onJumpToSync}
                role="button"
                tabIndex={0}
              >
                <TypeIcon className="w-3.5 h-3.5 text-ink-soft shrink-0" />
                <span className="flex-1 truncate text-sm text-ink">{c.title}</span>
                <StatusBadge status={c.changeType} size="sm">
                  {STATE_LABEL[c.changeType]}
                </StatusBadge>
                <span className="shrink-0 flex items-center gap-1 text-[11px] text-ink-faint font-mono">
                  <Clock className="w-3 h-3" />
                  {formatRelativeTime(c.cloudModifiedTime)}
                </span>
              </div>
            );
          })
        )}
      </CardBody>
    </Card>
  );
}
