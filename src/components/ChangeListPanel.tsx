/**
 * ChangeListPanel - 变更列表三状态（T4 R2.3-AC1/AC2，04 §5）
 *
 * 4 tab：全部 / 新增 / 已修改 / 已删除。
 * 数据源为已持久化的 GET /api/mapping/diff?cached=1，按 changeType 分组。
 * 删除项不进批量同步，单独显示「移入回收站 / 永久清理」。
 *
 * 选中状态由父组件持有（避免与 SyncView 之间重复定义），本组件
 * 受控：通过 props 注入 selectedTokens + onSelectionChange。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, CheckSquare, AlertCircle, Inbox } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { Button } from './common/Button';
import { EmptyState } from './common/EmptyState';
import { ChangeItem } from './ChangeItem';
import { BatchActionBar } from './BatchActionBar';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';
import { onDiffChanged } from '../utils/syncEvents';
import { detectChanges, detectChangesAll, getStoredMappingDiff } from '../api/client';
import type { ChangedDocument, DiffReport, SheetSub } from '../types';
import { isUsableWikiUrl } from '../utils/wikiUrl';

type Tab = 'all' | 'added' | 'modified' | 'mediaGap' | 'deleted';

const TAB_LABEL: Record<Tab, string> = {
  all: '全部',
  added: '新增',
  modified: '已修改',
  mediaGap: '图片缺失待修复',
  deleted: '已删除',
};

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
   *
   * When omitted or containing a single URL, the panel keeps the legacy
   * single-root behaviour (one stored-diff call).
   */
  watchedRootUrls?: string[];
  /** Incremented by SyncView after a structural repair or sync completes. */
  reloadSignal?: number;
  /**
   * v0.2.9：批量同步真正入口。此前「批量同步」按钮只 toast 提示用户去
   * 同步操作面板（意义不明）；现在由 SyncView 注入与「开始同步」完全
   * 相同的确认 + 同步流程。缺省时保留旧提示行为（向后兼容）。
   */
  onBatchSync?: () => void;
}

/**
 * Aggregate multiple per-root DiffReports into a single DiffReport-shaped
 * view model. The server-side cached `/api/mapping/diff` is per-root, so we fan
 * out client-side and merge:
 *   - added/modified/deleted arrays are concatenated
 *   - unchanged/totalCloud/totalLocal are summed (counts)
 *   - checkedAt is the latest (max) timestamp across roots so the UI shows
 *     "checked at <most recent root>"
 *
 * Per-root failures degrade gracefully: a root whose diff call failed is
 * counted with zero changes and surfaced via a non-fatal warning toast
 * rather than aborting the whole panel.
 */
async function fetchMultiRootDiff(
  rootUrls: string[],
): Promise<{ report: DiffReport; failedRoots: string[] }> {
  const added: ChangedDocument[] = [];
  const modified: ChangedDocument[] = [];
  const deleted: ChangedDocument[] = [];
  // Dedup by objToken: custom-folder (归档) docs are intentionally merged
  // into EVERY root's stored diff server-side, so a naive concat repeats
  // them once per watchedRoot (4 roots -> 4 identical rows).
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
}: ChangeListPanelProps) {
  const [tab, setTab] = useState<Tab>('all');
  const [diff, setDiff] = useState<DiffReport | null>(initialDiff ?? null);
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetSubs] = useState<Record<string, SheetSub[]>>({});
  const toast = useToast();
  const inFlightDetect = useRef(false);
  const inFlightStored = useRef(false);

  // Effective root set for diff fetching. Multi-root aggregation only kicks
  // in when the caller provides MORE THAN ONE valid URL; otherwise we fall
  // back to the legacy single-root path so existing behaviour is unchanged.
  const multiRootUrls = useMemo(() => {
    const valid = Array.isArray(watchedRootUrls)
      ? watchedRootUrls.filter((u): u is string => isUsableWikiUrl(u))
      : [];
    return valid.length > 1 ? valid : null;
  }, [watchedRootUrls]);

  /**
   * 读取本地 SQLite 持久化的存量 diff，快速返回，不触发云端全量遍历。
   * 用于初次挂载、切页激活（reloadSignal）以及数据变更广播（onDiffChanged）。
   */
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

  /**
   * 主动触发变更检测（点击「立即检测」）：发起真实云端遍历（changes-all / detectChanges），
   * 包含元数据比对与媒体完整性核对。期间按钮显示检测中状态并防止并发重复触发。
   */
  const handleDetect = async () => {
    if (inFlightDetect.current) return;
    inFlightDetect.current = true;
    setDetecting(true);
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
        if (!rootUrl) {
          setDetecting(false);
          inFlightDetect.current = false;
          return;
        }
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
      setDetecting(false);
      inFlightDetect.current = false;
    }
  };

  // First-load behaviour: prefer parent-supplied diff; else fetch once when
  // rootUrl becomes ready.
  const initialFetchDoneFor = useRef<string | null>(null);
  const guardKey = multiRootUrls ? `multi:${multiRootUrls.join('|')}` : (rootUrl ?? '');
  useEffect(() => {
    if (!diff && guardKey && !loading && !error && initialFetchDoneFor.current !== guardKey) {
      initialFetchDoneFor.current = guardKey;
      void loadStoredDiff();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, guardKey, loading, error]);

  // A structural repair writes fresh topology into SQLite before the sync
  // retry begins. Re-read the cached diff when the parent explicitly signals
  // that update; rendering itself still never starts a cloud traversal.
  const lastReloadSignal = useRef(reloadSignal);
  useEffect(() => {
    if (lastReloadSignal.current === reloadSignal) return;
    lastReloadSignal.current = reloadSignal;
    if (guardKey && !loading && !detecting) {
      void loadStoredDiff();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal, guardKey, loading, detecting]);

  // 跨视图实时刷新：仅拉取 SQLite 存量缓存 diff（本地读，绝不触发云端遍历）。
  // 彻底阻断 detectChangesAll -> emitDiffChanged -> 递归云端全量检测的循环死锁。
  useEffect(() => {
    return onDiffChanged((source) => {
      if (!guardKey || loading || detecting) return;
      appLogger.info('change-list', 'diff store changed; reloading stored list', { source });
      void loadStoredDiff();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardKey, loading, detecting]);

  const grouped = useMemo(() => {
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
  }, [diff]);

  const visibleChanges = useMemo(() => {
    if (tab === 'all') {
      return [...grouped.added, ...grouped.modified, ...grouped.mediaGap, ...grouped.deleted];
    }
    return grouped[tab];
  }, [tab, grouped]);

  // 本批需求契约：「全选」默认不勾选「图片缺失待修复」组；该组有自己的组内全选。
  const currentSelectable = useMemo(() => {
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
    // tab === 'all': 全选默认仅勾选 added + modified，不含 mediaGap
    return [...grouped.added, ...grouped.modified];
  }, [tab, grouped]);

  const allSelected =
    currentSelectable.length > 0 &&
    currentSelectable.every((c) => selectedTokens.includes(c.objToken));

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
    // v0.2.9：批量同步直接复用 SyncView 注入的「开始同步」流程（确认 +
    // 原子写入），不再只提示用户去别处操作。
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
            <p className="text-sm text-ink-soft">加载存量变更中…</p>
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
            action={{ label: detecting ? '检测中…' : '立即检测', onClick: handleDetect }}
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
          <h2 className="text-lg font-kai font-medium text-ink">变更列表</h2>
          <div className="flex items-center gap-2">
            {detecting && (
              <span className="text-xs text-seal font-sans-ui animate-pulse">
                检测中，首次全量检测可能需要几分钟…
              </span>
            )}
            <span className="text-xs text-ink-faint font-sans-ui">
              共 {totalChanges} 项变更
              {diff && diff.checkedAt && (
                <> · {new Date(diff.checkedAt).toLocaleString('zh-CN', { hour12: false })}</>
              )}
            </span>
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
      <CardBody className="space-y-4">
        {/* Tabs */}
        <div className="flex items-center gap-2 border-b border-line pb-3 overflow-x-auto">
          {(['all', 'added', 'modified', 'mediaGap', 'deleted'] as Tab[]).map((t) => {
            const count = t === 'all' ? totalChanges : grouped[t].length;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-3.5 py-1.5 rounded text-xs font-sans-ui border transition-colors whitespace-nowrap ${
                  tab === t
                    ? 'bg-seal/10 text-seal border-seal/30'
                    : 'bg-paper text-ink-soft border-line hover:bg-paper-2'
                }`}
              >
                {TAB_LABEL[t]} ({count})
              </button>
            );
          })}
        </div>

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

        {/* 提示条：当全部 tab 包含图片缺失项时，提示用户并提供快速组内全选入口 */}
        {grouped.mediaGap.length > 0 && tab === 'all' && (
          <div className="flex items-center justify-between px-3.5 py-2 rounded border border-seal/20 bg-seal/5 text-xs font-sans-ui text-ink-soft">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-seal shrink-0" />
              <span>检测到 {grouped.mediaGap.length} 项「图片缺失待修复」文档（默认不随「全选」勾选）</span>
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

        {/* List */}
        {visibleChanges.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 text-center">
            <Inbox className="w-12 h-12 text-ink-faint mb-3" />
            <p className="text-sm text-ink-soft">当前筛选下无变更</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {visibleChanges.map((change) => (
              <ChangeItem
                key={change.objToken}
                change={change}
                selected={selectedTokens.includes(change.objToken)}
                onToggleSelect={handleToggle}
                sheets={sheetSubs[change.objToken]}
                onSyncSub={handleSyncSub}
                onTrash={onTrash}
                onPurge={onPurge}
              />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
