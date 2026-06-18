/**
 * SyncView - 同步主区（T2/T4/T6/T10，04 §4.2）
 *
 * P4-2 完整版：
 *   - ChangeListPanel（三状态）
 *   - SyncControlPanel（选中数 + enableLLM + fullSync + 开始同步/取消）
 *   - SyncProgress（同步中显示）
 *   - SyncResultList（同步结果分组）
 *   - TrashDrawer（决策2 抽屉形态，入口在底部"回收站"按钮）
 *   - LogDrawer（入口在底部"查看完整日志"按钮）
 *
 * selectedTokens + enableLLM + fullSync 由本视图持有（G2.5 props 钻取修正）。
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
  const [enableLLM, setEnableLLM] = useState(true);
  const [fullSync, setFullSync] = useState(false);
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

  // Channel label from config.llm.primaryChannel
  const channelLabel = (() => {
    const ch = config?.llm?.primaryChannel;
    return ch === 'direct' ? 'direct 通道（bigmodel paas/v4）' : 'claude CLI 通道（bigmodel Anthropic 端点）';
  })();

  // Recover syncing state for SyncProgress from useSync
  const syncing = sync.syncing;

  const handleStart = async () => {
    if (selectedDocs.length === 0) {
      toast.push({ type: 'warning', message: '请先选择要同步的文档' });
      return;
    }
    appLogger.info('sync-view', 'starting sync', { count: selectedDocs.length, enableLLM, fullSync });
    await sync.syncDocuments(selectedDocs, { enableLLM, fullSync });
    if (sync.syncResult) {
      const ok = sync.syncResult.success && sync.syncResult.failedDocuments.length === 0;
      toast.push({
        type: ok ? 'success' : 'warning',
        message: ok ? '同步完成' : '同步完成（含失败项）',
        hint: `${sync.syncResult.syncedDocuments.length} 成功 / ${sync.syncResult.failedDocuments.length} 失败`,
      });
    }
  };

  const handleCancel = () => {
    // useSync.syncDocuments is a single POST; no real cancel channel exists.
    // Document intent + log; full cancel requires P5 server SSE/SSE channel.
    toast.push({
      type: 'info',
      message: '取消请求已记录',
      hint: '当前后端为整批同步，取消能力将在 P5 SSE 改造后生效',
    });
    appLogger.warn('sync-view', 'cancel requested (server not streaming)');
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
    await sync.syncDocuments(retryDocs, { enableLLM, fullSync });
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
    if (sync.syncResult && sync.syncResult.success) {
      setSelectedTokens([]);
    }
  }, [sync.syncResult]);

  return (
    <div className="space-y-3">
      <ChangeListPanel
        rootUrl={memoRootUrl}
        rootUrlError={rootUrlError}
        selectedTokens={selectedTokens}
        onSelectionChange={setSelectedTokens}
        onDiffChange={setDiff}
        onTrash={handleTrash}
        onPurge={handlePurge}
      />

      <SyncControlPanel
        selectedCount={selectedDocs.length}
        enableLLM={enableLLM}
        fullSync={fullSync}
        syncing={syncing}
        channelLabel={channelLabel}
        onEnableLLMChange={setEnableLLM}
        onFullSyncChange={setFullSync}
        onStart={handleStart}
        onCancel={handleCancel}
      />

      <SyncProgress
        syncing={syncing}
        total={selectedDocs.length}
        done={sync.syncResult ? sync.syncResult.syncedDocuments.length + sync.syncResult.failedDocuments.length : 0}
      />

      {sync.error && (
        <div className="p-3 rounded-md border border-seal-2/40 bg-seal-2/5 text-sm text-seal-2">
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
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={() => setTrashOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-ink-soft border border-line rounded-md bg-card-bg hover:bg-paper-2 font-sans-ui transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          回收站
        </button>
        <button
          type="button"
          onClick={() => setLogOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-ink-soft border border-line rounded-md bg-card-bg hover:bg-paper-2 font-sans-ui transition-colors"
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
