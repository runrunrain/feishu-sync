/**
 * CloudHistoryDrawer —— 云端历史抽屉（P0-S5，设计 §4.5）
 *
 * 分页列出云端历史版本（版本时间 / revision / 类型），行操作「回滚到此版」。
 * 全局最新条目（第 1 页首行）禁用并提示（飞书 3380002：最新历史条目
 * 不可作回滚目标）。缺省加载聚合 3 页，truncated 时「继续加载」按
 * nextPageToken 续翻（单页透传）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, History, Loader2, RotateCcw } from 'lucide-react';
import { Drawer } from '../common/Drawer';
import { StatusBadge } from '../common/StatusBadge';
import { EmptyState } from '../common/EmptyState';
import { getCloudHistory } from '../../api/client';
import type { CloudHistoryEntry } from '../../types';
import { canRevertHistoryEntry, formatTime, historyTypeFace, shortHistoryId } from './labels';

interface CloudHistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  objToken: string;
  /** 打开回滚弹窗（target = { historyVersionId }）。 */
  onRequestRevert: (target: { historyVersionId: string; sourceLabel: string }) => void;
}

export function CloudHistoryDrawer({ open, onClose, objToken, onRequestRevert }: CloudHistoryDrawerProps) {
  const [entries, setEntries] = useState<CloudHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 全局最新条目 id（仅第 1 页首行；续翻页的首行不是全局最新）。 */
  const [latestId, setLatestId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const requestGeneration = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; requestGeneration.current += 1; };
  }, []);

  const loadFirstPage = useCallback(() => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setEntries(null);
    setNextPageToken(null);
    setTruncated(false);
    getCloudHistory(objToken)
      .then((page) => {
        if (!mountedRef.current || generation !== requestGeneration.current) return;
        setEntries(page.entries);
        setNextPageToken(page.truncated ? page.nextPageToken : null);
        setTruncated(page.truncated);
        setLatestId(page.entries[0]?.historyVersionId ?? null);
      })
      .catch((err) => {
        if (!mountedRef.current || generation !== requestGeneration.current) return;
        setError(err instanceof Error ? err.message : '云端历史加载失败');
      })
      .finally(() => {
        if (mountedRef.current && generation === requestGeneration.current) setLoading(false);
      });
  }, [objToken]);

  const loadMore = () => {
    if (!nextPageToken || loadingMore) return;
    const generation = requestGeneration.current;
    setLoadingMore(true);
    getCloudHistory(objToken, { pageToken: nextPageToken })
      .then((page) => {
        if (!mountedRef.current || generation !== requestGeneration.current) return;
        setEntries((prev) => [...(prev ?? []), ...page.entries]);
        setNextPageToken(page.truncated || page.hasMore ? page.nextPageToken : null);
        setTruncated(page.truncated);
      })
      .catch((err) => {
        if (!mountedRef.current || generation !== requestGeneration.current) return;
        setError(err instanceof Error ? err.message : '云端历史续翻失败');
      })
      .finally(() => {
        if (mountedRef.current && generation === requestGeneration.current) setLoadingMore(false);
      });
  };

  useEffect(() => {
    if (open) loadFirstPage();
    return () => { requestGeneration.current += 1; };
  }, [open, loadFirstPage]);

  return (
    <Drawer open={open} onClose={onClose} title="云端历史" subtitle={`飞书文档历史版本 · ${objToken}`} widthClass="w-[720px] max-w-[94vw]">
      <div className="p-4 space-y-3">
        <p className="text-xs text-ink-faint">
          回滚会在云端产生新的历史版本（可再回滚）；文档标题与内嵌白板/表格不随正文回滚。
        </p>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-12 text-ink-faint">
            <Loader2 className="w-4 h-4 animate-spin" />
            <p className="text-sm">正在读取云端历史…</p>
          </div>
        )}
        {error && !loading && (
          <div className="rounded-md border border-seal-2/40 bg-seal-2/5 p-3 space-y-1.5">
            <p className="text-xs text-seal-2 leading-relaxed">{error}</p>
          </div>
        )}
        {!loading && !error && entries != null && entries.length === 0 && (
          <EmptyState
            icon={<History className="w-5 h-5" />}
            title="云端暂无历史版本"
            description="飞书历史条目按编辑会话异步定型，新文档可能还没有可回滚的历史。"
          />
        )}
        {entries != null && entries.length > 0 && (
          <ul className="space-y-1.5" data-testid="cloud-history-list">
            {entries.map((entry, index) => {
              const typeFace = historyTypeFace(entry.type);
              const isGlobalLatest = entry.historyVersionId != null && entry.historyVersionId === latestId;
              const gate = canRevertHistoryEntry(entry, isGlobalLatest);
              return (
                <li
                  key={`${entry.historyVersionId ?? 'none'}-${index}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-line bg-card-bg px-3 py-2"
                >
                  <span className="font-mono text-[11px] text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                  <StatusBadge status={typeFace.status} size="sm">{typeFace.text}</StatusBadge>
                  <span className="text-xs text-ink">{formatTime(entry.editTime)}</span>
                  {entry.revisionId != null && (
                    <span className="text-[11px] text-ink-faint">revision {entry.revisionId}</span>
                  )}
                  <span className="font-mono text-[11px] text-ink-faint" title={entry.historyVersionId ?? ''}>
                    {shortHistoryId(entry.historyVersionId)}
                  </span>
                  {isGlobalLatest && (
                    <span className="text-[11px] text-jade" title="当前云端内容即此版本">
                      · 最新
                    </span>
                  )}
                  {entry.editorIds.length > 0 && (
                    <span className="text-[11px] text-ink-faint">{entry.editorIds.length} 位编辑者</span>
                  )}
                  <span className="ml-auto">
                    <button
                      type="button"
                      onClick={() =>
                        entry.historyVersionId &&
                        onRequestRevert({
                          historyVersionId: entry.historyVersionId,
                          sourceLabel: `云端历史 · ${formatTime(entry.editTime)}`,
                        })
                      }
                      disabled={!gate.enabled}
                      title={gate.enabled ? '回滚到该版本' : gate.reason}
                      className="inline-flex items-center gap-1 rounded-md border border-seal/40 bg-seal/5 px-2 py-1 text-[11px] text-seal transition-colors hover:bg-seal/10 disabled:opacity-40 disabled:cursor-not-allowed"
                      data-testid="history-revert"
                    >
                      <RotateCcw className="w-3 h-3" />
                      回滚到此版
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {nextPageToken && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-paper px-3 py-1.5 text-xs text-ink-soft transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-40"
            >
              {loadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {truncated ? '继续加载更早版本（已达聚合 3 页上限）' : '继续加载更早版本'}
            </button>
          </div>
        )}
      </div>
    </Drawer>
  );
}
