/**
 * SyncView - 同步主区（T2/T4/T6/T10，04 §4.2）
 *
 * P4-2 完整版：
 *   - ChangeListPanel（三状态）
 *   - SyncControlPanel（选中数 + 选中项 dry-run）
 *   - SyncProgress（同步中显示）
 *   - SyncResultList（同步结果分组）
 *   - TrashDrawer（决策2 抽屉形态，入口在底部"回收站"按钮）
 *   - LogDrawer（入口在底部"查看完整日志"按钮）
 *
 * P0-06 保护模式：本视图只保留已选文档的 dry-run 入口；full sync、LLM
 * 适配和取消在获得可靠的后端语义前不显示为可用控件。
 */

import { useEffect, useMemo, useState } from 'react';
import { ScrollText, Trash2 } from 'lucide-react';
import { ChangeListPanel } from '../components/ChangeListPanel';
import { SyncControlPanel } from '../components/SyncControlPanel';
import { SyncProgress } from '../components/SyncProgress';
import { SyncResultList } from '../components/SyncResultList';
import { LogDrawer } from '../components/LogDrawer';
import { TrashDrawer } from '../components/TrashDrawer';
import { useConfig } from '../hooks/useConfig';
import { useSync } from '../hooks/useSync';
import { useToast } from '../components/common/Toast';
import { appLogger } from '../utils/appLogger';
import { isUsableWikiUrl, pickFirstValidWikiUrl } from '../utils/wikiUrl';
import type { ChangedDocument, DiffReport, FailedDocument } from '../types';

export function SyncView() {
  const { config } = useConfig();
  const toast = useToast();
  const sync = useSync();

  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [diff, setDiff] = useState<DiffReport | null>(null);

  const activeRootUrl = pickFirstValidWikiUrl(config?.watchedRootUrls);
  const rootUrlError = !activeRootUrl
    ? (config?.watchedRootUrls?.length ?? 0) === 0
      ? '请先在设置中配置飞书根 URL（形如 https://xxx.feishu.cn/wiki/<token>）'
      : '配置的飞书根 URL 格式无效，请在设置中改为形如 https://xxx.feishu.cn/wiki/<token> 的地址'
    : null;
  const memoRootUrl = useMemo(() => (isUsableWikiUrl(activeRootUrl) ? activeRootUrl : null), [activeRootUrl]);

  // Cache current full change set (added + modified) for sync payload.
  // Re-derived from the latest diff whenever the change list refreshes.
  const allChanges = useMemo<ChangedDocument[]>(() => {
    if (!diff) return [];
    return [...diff.added, ...diff.modified, ...diff.deleted];
  }, [diff]);

  const selectedDocs = useMemo<ChangedDocument[]>(() => {
    if (allChanges.length === 0) return [];
    const byToken = new Map(allChanges.map((c) => [c.objToken, c]));
    return selectedTokens
      .map((t) => byToken.get(t))
      .filter((c): c is ChangedDocument => c != null);
  }, [allChanges, selectedTokens]);

  // Recover syncing state for SyncProgress from useSync
  const syncing = sync.syncing;

  const handleStart = async () => {
    if (selectedDocs.length === 0) {
      toast.push({ type: 'warning', message: '请先选择要同步的文档' });
      return;
    }
    appLogger.info('sync-view', 'starting selected-document dry-run', { count: selectedDocs.length });
    const result = await sync.syncDocuments(selectedDocs);
    if (result) {
      const isDryRun = result.mode === 'dry-run';
      const plannedCount = isDryRun
        ? (result.plannedDocuments ?? []).filter((document) => document.action !== 'blocked').length
        : result.syncedDocuments.length;
      const ok = result.success && result.failedDocuments.length === 0;
      toast.push({
        type: ok ? 'success' : 'warning',
        message: isDryRun
          ? (ok ? '核验计划已生成' : '核验计划已生成（含阻止项）')
          : (ok ? '同步完成' : '同步完成（含失败项）'),
        hint: isDryRun
          ? `${plannedCount} 待写入 / ${result.failedDocuments.length} 阻止`
          : `${plannedCount} 成功 / ${result.failedDocuments.length} 失败`,
      });
    }
  };

  const handleRetry = async (failed: FailedDocument[]) => {
    const retryDocs: ChangedDocument[] = selectedDocs.length > 0
      ? failed.map((f) => {
          const orig = allChanges.find((c) => c.objToken === f.objToken);
          return orig ?? {
            objToken: f.objToken,
            objType: 'unknown',
            title: f.title,
            changeType: 'modified' as const,
            cloudModifiedTime: new Date().toISOString(),
            localSyncedTime: null,
            localMdPath: null,
          };
        })
      : [];
    if (retryDocs.length === 0) {
      toast.push({ type: 'warning', message: '无原始文档信息可重试' });
      return;
    }
    await sync.syncDocuments(retryDocs);
  };

  const handleOpenMd = (localMdPath: string) => {
    if (typeof window !== 'undefined' && window.desktop) {
      window.desktop.openDataDirectory().catch((err) => {
        appLogger.error('sync-view', 'openDataDirectory failed', err);
      });
    }
    appLogger.info('sync-view', 'open md requested', { localMdPath });
  };

  const handleClearResult = () => sync.clear();

  // Trash / purge stubs (from ChangeItem) wired to TrashDrawer opener.
  const handleTrash = (objToken: string) => {
    setTrashOpen(true);
    appLogger.info('sync-view', 'trash requested (open drawer)', { objToken });
  };
  const handlePurge = (objToken: string) => {
    setTrashOpen(true);
    appLogger.info('sync-view', 'purge requested (open drawer)', { objToken });
  };

  // Reset selection when a fresh sync result arrives.
  useEffect(() => {
    if (sync.syncResult && sync.syncResult.mode !== 'dry-run' && sync.syncResult.success) {
      setSelectedTokens([]);
    }
  }, [sync.syncResult]);

  return (
    <div className="space-y-6">
      {/*
        同步区布局重构（2026-06-19）：
        - space-y-3→space-y-6：变更列表 / 同步操作 / 进度 / 结果 之间建立主区级别 24px 节奏
        - 底部入口按钮 pt-1→pt-2 + gap-2→gap-3，与同步操作面板拉开间距
      */}
      <ChangeListPanel
        rootUrl={memoRootUrl}
        rootUrlError={rootUrlError}
        selectedTokens={selectedTokens}
        onSelectionChange={setSelectedTokens}
        onDiffChange={setDiff}
        onTrash={handleTrash}
        onPurge={handlePurge}
        watchedRootUrls={config?.watchedRootUrls}
      />

      <SyncControlPanel
        selectedCount={selectedDocs.length}
        syncing={syncing}
        onStart={handleStart}
      />

      <SyncProgress
        syncing={syncing}
        total={selectedDocs.length}
        done={sync.syncResult ? sync.syncResult.syncedDocuments.length + sync.syncResult.failedDocuments.length : 0}
      />

      {sync.error && (
        <div className="p-4 rounded-md border border-seal-2/40 bg-seal-2/5 text-sm text-seal-2">
          同步错误：{sync.error}
        </div>
      )}

      {sync.syncResult && (
        <SyncResultList
          result={sync.syncResult}
          onRetry={handleRetry}
          onOpen={handleOpenMd}
          onClear={handleClearResult}
        />
      )}

      {/* Bottom entry row: trash + log */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={() => setTrashOpen(true)}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-xs text-ink-soft border border-line rounded-md bg-card-bg hover:bg-paper-2 font-sans-ui transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          回收站
        </button>
        <button
          type="button"
          onClick={() => setLogOpen(true)}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-xs text-ink-soft border border-line rounded-md bg-card-bg hover:bg-paper-2 font-sans-ui transition-colors"
        >
          <ScrollText className="w-3.5 h-3.5" />
          查看完整日志
        </button>
      </div>

      <LogDrawer open={logOpen} onClose={() => setLogOpen(false)} />
      <TrashDrawer
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        onChanged={() => {
          // After a restore/purge, the change list could refresh.
          appLogger.info('sync-view', 'trash changed; change list may need refresh');
        }}
      />
    </div>
  );
}
