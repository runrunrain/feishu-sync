/**
 * ChangeListPanel - 变更列表三状态（T4 R2.3-AC1/AC2，04 §5）
 *
 * 4 tab：全部 / 新增 / 已修改 / 已删除。
 * 数据源 GET /api/mapping/diff（P2-T5 已有），按 changeType 分组。
 * 删除项不进批量同步，单独显示「移入回收站 / 永久清理」。
 *
 * 选中状态由父组件持有（避免与 SyncView 之间重复定义），本组件
 * 受控：通过 props 注入 selectedTokens + onSelectionChange。
 */

import { useMemo, useState } from 'react';
import { RefreshCw, CheckSquare, AlertCircle, Inbox } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { Button } from './common/Button';
import { EmptyState } from './common/EmptyState';
import { ChangeItem } from './ChangeItem';
import { BatchActionBar } from './BatchActionBar';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';
import { getMappingDiff } from '../api/client';
import type { ChangedDocument, DiffReport, SheetSub } from '../types';

type Tab = 'all' | 'added' | 'modified' | 'deleted';

const TAB_LABEL: Record<Tab, string> = {
  all: '全部',
  added: '新增',
  modified: '已修改',
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
  /** Deleted-state action stubs (TrashDrawer wiring lands in P4-2). */
  onTrash?: (objToken: string) => void;
  onPurge?: (objToken: string) => void;
}

export function ChangeListPanel({
  rootUrl,
  rootUrlError,
  selectedTokens,
  onSelectionChange,
  initialDiff,
  onRefresh,
  onTrash,
  onPurge,
}: ChangeListPanelProps) {
  const [tab, setTab] = useState<Tab>('all');
  const [diff, setDiff] = useState<DiffReport | null>(initialDiff ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetSubs] = useState<Record<string, SheetSub[]>>({});
  const toast = useToast();

  const fetchDiff = async () => {
    if (!rootUrl) return;
    setLoading(true);
    setError(null);
    try {
      const report = await getMappingDiff(rootUrl);
      setDiff(report);
      onRefresh?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '检测失败';
      setError(msg);
      appLogger.error('change-list', 'getMappingDiff failed', err);
      toast.push({
        type: 'error',
        message: '检测失败',
        hint: msg,
      });
    } finally {
      setLoading(false);
    }
  };

  // First-load behaviour: prefer parent-supplied diff; else fetch when rootUrl ready.
  useMemo(() => {
    if (!diff && rootUrl && !loading && !error) {
      void fetchDiff();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, rootUrl]);

  const grouped = useMemo(() => {
    if (!diff) return { added: [], modified: [], deleted: [] as ChangedDocument[] };
    return {
      added: diff.added,
      modified: diff.modified,
      deleted: diff.deleted,
    };
  }, [diff]);

  const visibleChanges = useMemo(() => {
    if (tab === 'all') {
      return [...grouped.added, ...grouped.modified, ...grouped.deleted];
    }
    return grouped[tab];
  }, [tab, grouped]);

  const selectableChanges = useMemo(
    () => [...grouped.added, ...grouped.modified],
    [grouped],
  );

  const allSelected =
    selectableChanges.length > 0 &&
    selectableChanges.every((c) => selectedTokens.includes(c.objToken));

  const handleToggle = (objToken: string) => {
    const next = selectedTokens.includes(objToken)
      ? selectedTokens.filter((t) => t !== objToken)
      : [...selectedTokens, objToken];
    onSelectionChange(next);
  };

  const handleSelectAll = () => {
    if (allSelected) {
      onSelectionChange([]);
    } else {
      onSelectionChange(selectableChanges.map((c) => c.objToken));
    }
  };

  const handleInvert = () => {
    const inverted = selectableChanges
      .map((c) => c.objToken)
      .filter((t) => !selectedTokens.includes(t));
    onSelectionChange(inverted);
  };

  const handleBatchSync = () => {
    if (selectedTokens.length === 0) return;
    // Actual sync invocation lives in SyncControlPanel (T6, P4-2). Here we
    // surface a hint and log intent — full sync wiring lands with SyncView.
    toast.push({
      type: 'info',
      message: `已选择 ${selectedTokens.length} 项，请在「同步操作面板」中开始同步`,
    });
    appLogger.info('change-list', 'batch sync requested', { count: selectedTokens.length });
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
            <p className="text-sm text-ink-soft">扫描文档中…</p>
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
            action={{ label: '重试', onClick: fetchDiff }}
          />
        </CardBody>
      </Card>
    );
  }

  // ----- Empty state -----
  const totalChanges =
    grouped.added.length + grouped.modified.length + grouped.deleted.length;
  if (totalChanges === 0) {
    return (
      <Card variant="elevated">
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-kai font-medium text-ink">变更列表</h2>
            <Button size="sm" variant="secondary" onClick={fetchDiff} loading={loading}>
              <RefreshCw className="w-4 h-4" />
              立即检测
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          <EmptyState
            icon={<CheckSquare className="w-10 h-10 text-jade" />}
            title="一切就绪"
            description="无未同步变更。所有文档均为最新。"
            action={{ label: '立即检测', onClick: fetchDiff }}
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
            <span className="text-xs text-ink-faint font-sans-ui">
              共 {totalChanges} 项变更
              {diff && diff.checkedAt && (
                <> · {new Date(diff.checkedAt).toLocaleString('zh-CN', { hour12: false })}</>
              )}
            </span>
            <Button size="sm" variant="secondary" onClick={fetchDiff} loading={loading}>
              <RefreshCw className="w-4 h-4" />
              立即检测
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {/* Tabs */}
        <div className="flex items-center gap-1.5 border-b border-line pb-2">
          {(['all', 'added', 'modified', 'deleted'] as Tab[]).map((t) => {
            const count = t === 'all' ? totalChanges : grouped[t].length;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-3 py-1 rounded text-xs font-sans-ui border transition-colors ${
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
          totalSelectable={selectableChanges.length}
          hasDeleted={grouped.deleted.length > 0 && tab !== 'deleted'}
          onSelectAll={handleSelectAll}
          onInvert={handleInvert}
          onBatchSync={handleBatchSync}
          onBatchSkip={handleBatchSkip}
          allSelected={allSelected}
        />

        {/* List */}
        {visibleChanges.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Inbox className="w-10 h-10 text-ink-faint mb-2" />
            <p className="text-sm text-ink-soft">当前筛选下无变更</p>
          </div>
        ) : (
          <div className="space-y-2">
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
