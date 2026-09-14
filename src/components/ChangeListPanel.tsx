/**
 * ChangeListPanel - 变更列表高密度表格/行式主区（T4 R2.3-AC1/AC2，04 §5）
 *
 * 5 tab：全部 / 新增 / 已修改 / 图片缺失待修复 / 已删除。
 * 数据源为已持久化的 GET /api/mapping/diff?cached=1，按 changeType 分组。
 * 删除项不进批量同步，单独显示「移入回收站 / 永久清理」。
 *
 * 选中状态由父组件持有（避免与 SyncView 之间重复定义），本组件受控：
 * 通过 props 注入 selectedTokens + onSelectionChange。
 *
 * 高密度优化（2026-09 洛神重构）：
 * - 表格式连续行布局替代旧独立卡片平铺模式，消除多余外边距与卡片重叠边框
 * - 默认紧凑模式（行高 ~33px），一屏可见条目数相比旧卡片提升 ≥2 倍
 * - 支持「紧凑 / 舒适」密度切换并持久化本地偏好
 * - 提供表头列对齐（复选框、文档标题与路径、变更状态、云端修改时间、详情展开）
 * - 完整保留 tab 过滤、批量操作、子表展开与单文档操作
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, CheckSquare, AlertCircle, Inbox, AlignJustify, List } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { Button } from './common/Button';
import { EmptyState } from './common/EmptyState';
import { ChangeItem } from './ChangeItem';
import { BatchActionBar } from './BatchActionBar';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';
import { onDiffChanged, isDetectRunning, setDetectRunning } from '../utils/syncEvents';
import { useDetectRunning } from '../hooks/useDetectRunning';
import { detectChanges, detectChangesAll, getStoredMappingDiff } from '../api/client';
import type { ChangedDocument, DiffReport, SheetSub } from '../types';
import { isUsableWikiUrl } from '../utils/wikiUrl';

type Tab = 'all' | 'added' | 'modified' | 'mediaGap' | 'deleted';
export type DensityMode = 'compact' | 'comfortable';

const TAB_LABEL: Record<Tab, string> = {
  all: '全部',
  added: '新增',
  modified: '已修改',
  mediaGap: '图片缺失待修复',
  deleted: '已删除',
};

const DENSITY_STORAGE_KEY = 'feishu-sync:change-list-density';

interface ChangeListPanelProps {
  rootUrl: string | null;
  rootUrlError: string | null;
  selectedTokens: string[];
  onSelectionChange: (tokens: string[]) => void;
  /** Initial diff (from parent). If absent, panel fetches its own. */
  initialDiff?: DiffReport | null;
  onRefresh?: () => void;
  /**
   * P4-2: notifies the parent whenever the diff updates (including the first
   * fetch). The parent uses this to resolve selected documents for the sync
   * payload without re-implementing the diff fetch.
   */
  onDiffChange?: (diff: DiffReport | null) => void;
  /** Deleted-state action stubs (TrashDrawer wiring lands in P4-2). */
  onTrash?: (objToken: string) => void;
  onPurge?: (objToken: string) => void;
  /**
   * v0.2.0 sync-state-timeout-fix §问题1: when more than one watchedRoot is
   * configured the singular `rootUrl` only reflects the FIRST valid root,
   * so changes that live in other subtrees never appear in the panel even
   * though the status-bar counter (also fed by mapping/diff in the fixed
   * useSyncStatus) reports them. Passing the full list enables multi-root
   * aggregation here so the change list matches the pending counter.
   */
  watchedRootUrls?: string[];
  /** Incremented by SyncView after a structural repair or sync completes. */
  reloadSignal?: number;
  /**
   * v0.2.9：批量同步真正入口。此前「批量同步」按钮只 toast 提示用户去
   * 同步操作面板；现在由 SyncView 注入与「开始同步」完全相同的确认 + 同步流程。
   */
  onBatchSync?: () => void;
  /** 可选：定位/打开本地文档目录 */
  onOpenFolder?: (localMdPath: string) => void;
}

/**
 * Aggregate multiple per-root DiffReports into a single DiffReport-shaped
 * view model. The server-side cached `/api/mapping/diff` is per-root, so we fan
 * out client-side and merge:
 *   - added/modified/deleted arrays are concatenated
 *   - unchanged/totalCloud/totalLocal are summed (counts)
 *   - checkedAt is the latest (max) timestamp across roots
 */
async function fetchMultiRootDiff(
  rootUrls: string[],
): Promise<{ report: DiffReport; failedRoots: string[] }> {
  const added: ChangedDocument[] = [];
  const modified: ChangedDocument[] = [];
  const deleted: ChangedDocument[] = [];
  // Dedup by objToken: custom-folder docs are intentionally merged
  // into EVERY root's stored diff server-side, so a naive concat repeats them.
  const seen = { added: new Set<string>(), modified: new Set<string>(), deleted: new Set<string>() };
  const pushUnique = (
    bucket: ChangedDocument[],
    seenTokens: Set<string>,
    docs: ChangedDocument[],
  ) => {
    for (const doc of docs) {
      const key = doc.objToken ?? `${doc.title}:${doc.localMdPath ?? ''}`;
      if (seenTokens.has(key)) continue;
      seenTokens.add(key);
      bucket.push(doc);
    }
  };
  let unchanged = 0;
  let totalCloud = 0;
  let totalLocal = 0;
  let checkedAt = '';
  const failedRoots: string[] = [];

  for (const url of rootUrls) {
    if (!isUsableWikiUrl(url)) continue;
    try {
      const r = await getStoredMappingDiff(url);
      pushUnique(added, seen.added, r.added);
      pushUnique(modified, seen.modified, r.modified);
      pushUnique(deleted, seen.deleted, r.deleted);
      unchanged += r.unchanged ?? 0;
      totalCloud += r.totalCloud ?? 0;
      totalLocal += r.totalLocal ?? 0;
      if (r.checkedAt && r.checkedAt > checkedAt) checkedAt = r.checkedAt;
    } catch (err) {
      appLogger.warn('change-list', 'getStoredMappingDiff failed for root', { url, err });
      failedRoots.push(url);
    }
  }

  return {
    report: {
      added,
      modified,
      deleted,
      unchanged,
      totalCloud,
      totalLocal,
      checkedAt: checkedAt || new Date().toISOString(),
    },
    failedRoots,
  };
}

export function groupDiffChanges(diff: DiffReport | null) {
  if (!diff) {
    return {
      added: [],
      modified: [],
      mediaGap: [],
      deleted: [] as ChangedDocument[],
    };
  }
  const modifiedList: ChangedDocument[] = [];
  const mediaGapList: ChangedDocument[] = [];
  for (const doc of diff.modified) {
    if (doc.mediaGapReason) {
      mediaGapList.push(doc);
    } else {
      modifiedList.push(doc);
    }
  }
  return {
    added: diff.added,
    modified: modifiedList,
    mediaGap: mediaGapList,
    deleted: diff.deleted,
  };
}

export function computeSelectableDocs(
  tab: Tab,
  grouped: {
    added: ChangedDocument[];
    modified: ChangedDocument[];
    mediaGap: ChangedDocument[];
    deleted: ChangedDocument[];
  },
): ChangedDocument[] {
  if (tab === 'mediaGap') {
    return grouped.mediaGap;
  }
  if (tab === 'added') {
    return grouped.added;
  }
  if (tab === 'modified') {
    return grouped.modified;
  }
  if (tab === 'deleted') {
    return [];
  }
  // tab === 'all': 全选默认仅勾选 added + modified，不含 mediaGap 与 deleted
  return [...grouped.added, ...grouped.modified];
}

export function ChangeListPanel({
  rootUrl,
  rootUrlError,
  selectedTokens,
  onSelectionChange,
  initialDiff,
  onRefresh,
  onDiffChange,
  onTrash,
  onPurge,
  watchedRootUrls,
  reloadSignal = 0,
  onBatchSync,
  onOpenFolder,
}: ChangeListPanelProps) {
  const [tab, setTab] = useState<Tab>('all');
  const [diff, setDiff] = useState<DiffReport | null>(initialDiff ?? null);
  const [loading, setLoading] = useState(false);
  const detecting = useDetectRunning();
  const [error, setError] = useState<string | null>(null);
  const [sheetSubs] = useState<Record<string, SheetSub[]>>({});
  const toast = useToast();
  const inFlightDetect = useRef(false);
  const inFlightStored = useRef(false);

  // 密度偏好状态管理（默认紧凑）
  const [density, setDensity] = useState<DensityMode>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem(DENSITY_STORAGE_KEY);
        if (saved === 'compact' || saved === 'comfortable') return saved;
      } catch {
        // ignore localStorage error
      }
    }
    return 'compact';
  });

  const handleDensityToggle = (mode: DensityMode) => {
    setDensity(mode);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(DENSITY_STORAGE_KEY, mode);
      } catch {
        // ignore storage error
      }
    }
  };

  const multiRootUrls = useMemo(() => {
    const valid = Array.isArray(watchedRootUrls)
      ? watchedRootUrls.filter((u): u is string => isUsableWikiUrl(u))
      : [];
    return valid.length > 1 ? valid : null;
  }, [watchedRootUrls]);

  /** 读取本地 SQLite 持久化的存量 diff */
  const loadStoredDiff = async () => {
    if (inFlightStored.current) return;
    inFlightStored.current = true;
    setLoading(true);
    setError(null);
    try {
      let report: DiffReport;
      if (multiRootUrls) {
        const { report: aggregated, failedRoots } = await fetchMultiRootDiff(multiRootUrls);
        report = aggregated;
        if (failedRoots.length > 0) {
          toast.push({
            type: 'warning',
            message: `${failedRoots.length} 个子树读取存量差异失败`,
            hint: failedRoots.map((u) => u.split('/').pop() ?? u).join(', '),
          });
        }
      } else {
        if (!rootUrl) {
          setLoading(false);
          return;
        }
        report = await getStoredMappingDiff(rootUrl);
      }
      setDiff(report);
      onRefresh?.();
      onDiffChange?.(report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载差异失败';
      setError(msg);
      appLogger.error('change-list', 'loadStoredDiff failed', err);
    } finally {
      setLoading(false);
      inFlightStored.current = false;
    }
  };

  /** 主动触发云端变更检测 */
  const handleDetect = async () => {
    if (inFlightDetect.current || isDetectRunning()) return;
    inFlightDetect.current = true;
    setDetectRunning(true, 'change-list-panel');
    setError(null);
    try {
      let report: DiffReport;
      if (multiRootUrls) {
        await detectChangesAll();
        const { report: aggregated, failedRoots } = await fetchMultiRootDiff(multiRootUrls);
        report = aggregated;
        if (failedRoots.length > 0) {
          toast.push({
            type: 'warning',
            message: `${failedRoots.length} 个子树检测失败`,
            hint: failedRoots.map((u) => u.split('/').pop() ?? u).join(', '),
          });
        } else {
          toast.push({
            type: 'success',
            message: '变更检测完成',
          });
        }
      } else {
        if (!rootUrl) return;
        await detectChanges(rootUrl);
        report = await getStoredMappingDiff(rootUrl);
        toast.push({
          type: 'success',
          message: '变更检测完成',
        });
      }
      setDiff(report);
      onRefresh?.();
      onDiffChange?.(report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '检测失败';
      setError(msg);
      appLogger.error('change-list', 'handleDetect failed', err);
      toast.push({
        type: 'error',
        message: '检测失败',
        hint: msg,
      });
    } finally {
      setDetectRunning(false, 'change-list-panel');
      inFlightDetect.current = false;
    }
  };

  const initialFetchDoneFor = useRef<string | null>(null);
  const guardKey = multiRootUrls ? `multi:${multiRootUrls.join('|')}` : (rootUrl ?? '');
  useEffect(() => {
    if (!diff && guardKey && !loading && !error && initialFetchDoneFor.current !== guardKey) {
      initialFetchDoneFor.current = guardKey;
      void loadStoredDiff();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, guardKey, loading, error]);

  const lastReloadSignal = useRef(reloadSignal);
  useEffect(() => {
    if (lastReloadSignal.current === reloadSignal) return;
    lastReloadSignal.current = reloadSignal;
    if (guardKey && !loading && !inFlightDetect.current) {
      void loadStoredDiff();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal, guardKey, loading]);

  useEffect(() => {
    return onDiffChanged((source) => {
      if (!guardKey || loading || inFlightDetect.current) return;
      appLogger.info('change-list', 'diff store changed; reloading stored list', { source });
      void loadStoredDiff();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardKey, loading]);

  const grouped = useMemo(() => groupDiffChanges(diff), [diff]);

  const visibleChanges = useMemo(() => {
    if (tab === 'all') {
      return [...grouped.added, ...grouped.modified, ...grouped.mediaGap, ...grouped.deleted];
    }
    return grouped[tab];
  }, [tab, grouped]);

  // 全选逻辑红线：全选默认不勾选「图片缺失待修复」组；deleted 不可勾选
  const currentSelectable = useMemo(() => computeSelectableDocs(tab, grouped), [tab, grouped]);

  const allSelected =
    currentSelectable.length > 0 &&
    currentSelectable.every((c) => selectedTokens.includes(c.objToken));

  const someSelected =
    currentSelectable.length > 0 &&
    currentSelectable.some((c) => selectedTokens.includes(c.objToken)) &&
    !allSelected;

  const handleToggle = (objToken: string) => {
    const next = selectedTokens.includes(objToken)
      ? selectedTokens.filter((t) => t !== objToken)
      : [...selectedTokens, objToken];
    onSelectionChange(next);
  };

  const handleSelectAll = () => {
    const selectableTokens = currentSelectable.map((c) => c.objToken);
    if (allSelected) {
      onSelectionChange(selectedTokens.filter((t) => !selectableTokens.includes(t)));
    } else {
      onSelectionChange(Array.from(new Set([...selectedTokens, ...selectableTokens])));
    }
  };

  const handleInvert = () => {
    const selectableTokens = currentSelectable.map((c) => c.objToken);
    const next = selectedTokens.filter((t) => !selectableTokens.includes(t));
    for (const t of selectableTokens) {
      if (!selectedTokens.includes(t)) {
        next.push(t);
      }
    }
    onSelectionChange(next);
  };

  const handleBatchSync = () => {
    if (selectedTokens.length === 0) return;
    if (onBatchSync) {
      appLogger.info('change-list', 'batch sync requested', { count: selectedTokens.length });
      onBatchSync();
      return;
    }
    toast.push({
      type: 'info',
      message: `已选择 ${selectedTokens.length} 项，请在「同步操作面板」中开始同步`,
    });
    appLogger.info('change-list', 'batch sync requested (no handler)', { count: selectedTokens.length });
  };

  const handleBatchSkip = () => {
    onSelectionChange([]);
    toast.push({ type: 'info', message: '已清空选择' });
  };

  const handleSyncSub = (sheetId: string) => {
    toast.push({
      type: 'info',
      message: `子表 ${sheetId} 已加入同步队列`,
      hint: '子表同步将在主同步流程中执行',
    });
  };

  // ----- Unconfigured / invalid root URL state -----
  if (rootUrlError) {
    return (
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-lg font-kai font-medium text-ink">变更列表</h2>
        </CardHeader>
        <CardBody>
          <EmptyState
            icon={<AlertCircle className="w-10 h-10 text-seal" />}
            title="尚未配置飞书根 URL"
            description={rootUrlError}
          />
        </CardBody>
      </Card>
    );
  }

  // ----- Loading state -----
  if (loading && !diff) {
    return (
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-lg font-kai font-medium text-ink">变更列表</h2>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col items-center gap-3 py-14">
            <RefreshCw className="w-8 h-8 text-seal animate-spin" />
            <p className="text-sm text-ink-soft font-sans-ui">加载存量变更中…</p>
          </div>
        </CardBody>
      </Card>
    );
  }

  // ----- Error state -----
  if (error && !diff) {
    return (
      <Card variant="elevated">
        <CardHeader>
          <h2 className="text-lg font-kai font-medium text-ink">变更列表</h2>
        </CardHeader>
        <CardBody>
          <EmptyState
            icon={<AlertCircle className="w-10 h-10 text-seal-2" />}
            title="检测失败"
            description={error}
            action={{ label: '重试', onClick: loadStoredDiff }}
          />
        </CardBody>
      </Card>
    );
  }

  // ----- Empty state -----
  const totalChanges =
    grouped.added.length +
    grouped.modified.length +
    grouped.mediaGap.length +
    grouped.deleted.length;

  if (totalChanges === 0) {
    return (
      <Card variant="elevated">
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-kai font-medium text-ink">变更列表</h2>
            <div className="flex items-center gap-2">
              {detecting && (
                <span className="text-xs text-seal font-sans-ui animate-pulse">
                  检测中，首次全量检测可能需要几分钟…
                </span>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={handleDetect}
                loading={detecting}
                title={detecting ? '检测中，首次全量检测可能需要几分钟' : '立即检测飞书知识库变更'}
              >
                <RefreshCw className={`w-4 h-4 ${detecting ? 'animate-spin' : ''}`} />
                {detecting ? '检测中…' : '立即检测'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <EmptyState
            icon={<CheckSquare className="w-10 h-10 text-jade" />}
            title="一切就绪"
            description={detecting ? '正在扫描飞书知识库变更，请稍候…' : '无未同步变更。所有文档均为最新。'}
            action={{ label: detecting ? '检测中…' : '立即检测', onClick: handleDetect, disabled: detecting }}
          />
        </CardBody>
      </Card>
    );
  }

  // ----- Success state with changes -----
  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2.5">
            <h2 className="text-lg font-kai font-medium text-ink">变更列表</h2>
            <span className="text-xs text-ink-faint font-sans-ui">
              共 {totalChanges} 项变更
              {diff && diff.checkedAt && (
                <span className="hidden sm:inline">
                  {' '}· {new Date(diff.checkedAt).toLocaleString('zh-CN', { hour12: false })}
                </span>
              )}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {detecting && (
              <span className="text-xs text-seal font-sans-ui animate-pulse hidden md:inline">
                检测中…
              </span>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={handleDetect}
              loading={detecting}
              title={detecting ? '检测中，首次全量检测可能需要几分钟' : '立即检测飞书知识库变更'}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${detecting ? 'animate-spin' : ''}`} />
              {detecting ? '检测中…' : '立即检测'}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardBody className="space-y-3.5">
        {/* Tab 栏 + 密度切换器 */}
        <div className="flex items-center justify-between gap-2 border-b border-line pb-2.5">
          {/* Tabs 过滤 */}
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-thin">
            {(['all', 'added', 'modified', 'mediaGap', 'deleted'] as Tab[]).map((t) => {
              const count = t === 'all' ? totalChanges : grouped[t].length;
              const isActive = tab === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-sans-ui border transition-colors whitespace-nowrap cursor-pointer ${
                    isActive
                      ? 'bg-seal/10 text-seal border-seal/30 font-medium'
                      : 'bg-paper text-ink-soft border-line hover:bg-paper-2'
                  }`}
                >
                  <span>{TAB_LABEL[t]}</span>
                  <span
                    className={`text-[11px] px-1.5 py-0.2 rounded-full font-mono ${
                      isActive ? 'bg-seal/15 text-seal' : 'bg-paper-2 text-ink-faint'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 密度切换器：紧凑 vs 舒适 */}
          <div className="shrink-0 flex items-center bg-paper-2/80 rounded border border-line/60 p-0.5">
            <button
              type="button"
              onClick={() => handleDensityToggle('compact')}
              title="紧凑模式（高密度浏览，默认）"
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-sans-ui transition-colors cursor-pointer ${
                density === 'compact'
                  ? 'bg-card-bg text-seal shadow-xs font-medium'
                  : 'text-ink-soft hover:text-ink'
              }`}
            >
              <AlignJustify className="w-3 h-3" />
              <span>紧凑</span>
            </button>
            <button
              type="button"
              onClick={() => handleDensityToggle('comfortable')}
              title="舒适模式（两行元数据，易于阅读）"
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-sans-ui transition-colors cursor-pointer ${
                density === 'comfortable'
                  ? 'bg-card-bg text-seal shadow-xs font-medium'
                  : 'text-ink-soft hover:text-ink'
              }`}
            >
              <List className="w-3 h-3" />
              <span>舒适</span>
            </button>
          </div>
        </div>

        {/* 批量操作工具栏 */}
        <BatchActionBar
          selectedCount={selectedTokens.length}
          totalSelectable={currentSelectable.length}
          hasDeleted={grouped.deleted.length > 0 && tab !== 'deleted'}
          onSelectAll={handleSelectAll}
          onInvert={handleInvert}
          onBatchSync={handleBatchSync}
          onBatchSkip={handleBatchSkip}
          allSelected={allSelected}
        />

        {/* 提示条：图片缺失待修复提示 */}
        {grouped.mediaGap.length > 0 && tab === 'all' && (
          <div className="flex items-center justify-between px-3 py-1.5 rounded border border-seal/20 bg-seal/5 text-xs font-sans-ui text-ink-soft">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-seal shrink-0" />
              <span>
                检测到 {grouped.mediaGap.length} 项「图片缺失待修复」文档（默认不随「全选」勾选）
              </span>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => {
                  const mediaGapTokens = grouped.mediaGap.map((d) => d.objToken);
                  const allMediaGapSelected = mediaGapTokens.every((t) => selectedTokens.includes(t));
                  if (allMediaGapSelected) {
                    onSelectionChange(selectedTokens.filter((t) => !mediaGapTokens.includes(t)));
                  } else {
                    onSelectionChange(Array.from(new Set([...selectedTokens, ...mediaGapTokens])));
                  }
                }}
                className="text-seal hover:text-seal-2 font-medium underline underline-offset-2 transition-colors cursor-pointer"
              >
                {grouped.mediaGap.every((d) => selectedTokens.includes(d.objToken))
                  ? '取消勾选该组'
                  : '勾选图片缺失组'}
              </button>
              <button
                type="button"
                onClick={() => setTab('mediaGap')}
                className="text-ink-soft hover:text-ink transition-colors cursor-pointer"
              >
                查看
              </button>
            </div>
          </div>
        )}

        {/* 高密度列表 / 表格视图 */}
        {visibleChanges.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center rounded-md border border-line/60 bg-paper-2/30">
            <Inbox className="w-10 h-10 text-ink-faint mb-2" />
            <p className="text-sm text-ink-soft font-sans-ui">当前筛选下无变更</p>
          </div>
        ) : (
          <div className="rounded-md border border-line bg-card-bg overflow-hidden shadow-xs">
            {/* 表头 Header */}
            <div className="flex items-center gap-2.5 px-3 py-1.5 bg-paper-2/80 border-b border-line text-[11px] font-sans-ui text-ink-faint select-none">
              {/* 表头全选复选框 */}
              <div className="shrink-0 w-8 flex items-center justify-center">
                <button
                  type="button"
                  onClick={handleSelectAll}
                  disabled={currentSelectable.length === 0}
                  className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                    allSelected
                      ? 'border-seal bg-seal text-white'
                      : someSelected
                        ? 'border-seal bg-seal/20 text-seal'
                        : 'border-line bg-card-bg hover:border-seal/60'
                  }`}
                  aria-label={allSelected ? '取消全选' : '全选'}
                  title={allSelected ? '取消全选' : '全选当前'}
                >
                  {allSelected && (
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
                  {someSelected && (
                    <span className="w-2 h-0.5 bg-seal rounded-full" />
                  )}
                </button>
              </div>

              {/* 类型与标题列 */}
              <div className="flex-1 min-w-0 pr-2 flex items-center gap-1.5">
                <span>文档与路径</span>
                <span className="text-[10px] text-ink-faint/60 hidden sm:inline">
                  ({visibleChanges.length} 条)
                </span>
              </div>

              {/* 状态列 */}
              <div className="shrink-0 w-22 sm:w-26 text-left">
                <span>变更状态</span>
              </div>

              {/* 时间列 */}
              <div className="shrink-0 w-22 sm:w-26 text-right">
                <span>云端更新</span>
              </div>

              {/* 详情列 */}
              <div className="shrink-0 w-9 text-center">
                <span>详情</span>
              </div>
            </div>

            {/* 表体 Rows */}
            <div className="divide-y divide-line/30">
              {visibleChanges.map((change) => (
                <ChangeItem
                  key={change.objToken}
                  change={change}
                  density={density}
                  selected={selectedTokens.includes(change.objToken)}
                  onToggleSelect={handleToggle}
                  sheets={sheetSubs[change.objToken]}
                  onSyncSub={handleSyncSub}
                  onTrash={onTrash}
                  onPurge={onPurge}
                  onOpenFolder={onOpenFolder}
                />
              ))}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
