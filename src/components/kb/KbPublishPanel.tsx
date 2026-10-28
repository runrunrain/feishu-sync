/**
 * KbPublishPanel —— 标准库侧栏「发布」面板（P1-S9）。
 *
 * 紧凑入口：发布状态概览（已发布/冲突/未知计数）+ 最近发布记录 +
 * 「发布到飞书」主入口与「发布历史」。完整发布流在 KbPublishModal
 * （预览 → 确认值 → 执行 → 完成态）；面板只做导航与概览，不渲染假数据。
 */

import { useMemo } from 'react';
import { CloudUpload, History, RefreshCw } from 'lucide-react';
import { Button } from '../common/Button';
import { formatDateTime } from '../../utils/agentReadiness';
import type { KbPublicationRowDto } from '../../types/kb-publish';
import { KbPublishStateBadge } from './KbPublishStateBadge';

export interface KbPublishPanelProps {
  publications: KbPublicationRowDto[];
  loading: boolean;
  docCount: number;
  onOpenPublish: () => void;
  onOpenHistory: () => void;
  onRefresh: () => void;
}

export function KbPublishPanel({
  publications,
  loading,
  docCount,
  onOpenPublish,
  onOpenHistory,
  onRefresh,
}: KbPublishPanelProps) {
  const counts = useMemo(() => {
    let published = 0;
    let conflict = 0;
    let unknown = 0;
    let other = 0;
    for (const row of publications) {
      if (row.state === 'published' || row.state === 'published_with_warnings') published += 1;
      else if (row.state === 'conflict') conflict += 1;
      else if (row.state === 'unknown') unknown += 1;
      else other += 1;
    }
    return { published, conflict, unknown, other };
  }, [publications]);

  const recent = useMemo(
    () => [...publications].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6),
    [publications],
  );

  return (
    <div className="flex-1 min-h-0 overflow-auto scrollbar-thin p-4 space-y-4 text-xs text-ink-soft" data-testid="kb-publish-panel">
      <p className="leading-relaxed">
        把标准库文档发布为飞书云文档（发布根下逐篇平铺），发布后可继续以「更新」同步云端副本。
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="kb-publish-counts">
        <span className="text-jade">已发布 {counts.published}</span>
        {counts.conflict > 0 ? <span className="text-seal-2">冲突 {counts.conflict}</span> : null}
        {counts.unknown > 0 ? <span className="text-[#8a6508]">未知 {counts.unknown}</span> : null}
        {counts.other > 0 ? <span className="text-ink-faint">其他 {counts.other}</span> : null}
        <span className="text-ink-faint">/ 共 {docCount} 篇</span>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <Button size="sm" onClick={onOpenPublish} disabled={docCount === 0}>
          <CloudUpload className="w-3.5 h-3.5" />发布到飞书…
        </Button>
        <Button size="sm" variant="secondary" onClick={onOpenHistory}>
          <History className="w-3.5 h-3.5" />发布历史
        </Button>
        <Button size="sm" variant="ghost" onClick={onRefresh} loading={loading}>
          <RefreshCw className="w-3.5 h-3.5" />刷新发布状态
        </Button>
      </div>

      <div className="space-y-1 border-t border-line pt-3">
        <h4 className="text-ink font-medium">最近发布</h4>
        {loading && publications.length === 0 ? (
          <p className="text-ink-faint">正在读取发布记录…</p>
        ) : recent.length === 0 ? (
          <p className="text-ink-faint leading-relaxed">尚无发布记录。</p>
        ) : (
          <ul className="space-y-1">
            {recent.map((row) => (
              <li key={row.kbPath} className="flex items-center gap-1.5 min-w-0">
                <KbPublishStateBadge state={row.state} compact showAllStates />
                <span className="flex-1 min-w-0 truncate" title={row.kbPath}>
                  {row.kbPath}
                </span>
                <span className="shrink-0 text-[10px] text-ink-faint">{formatDateTime(row.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
