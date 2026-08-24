/**
 * SyncView - 同步主区（T2/T4/T6/T10，04 §4.2）
 *
 * P4-2 完整版：
 *   - ChangeListPanel（三状态）
 *   - SyncControlPanel（选中数 + 已确认的选中项同步）
 *   - SyncProgress（同步中显示）
 *   - SyncResultList（同步结果分组）
 *   - TrashDrawer（决策2 抽屉形态，入口在底部"回收站"按钮）
 *   - LogDrawer（入口在底部"查看完整日志"按钮）
 *
 * 安全边界：本视图只同步用户明确选中的文档；服务端会在写入前规划，
 * 对未映射同名文件、未知类型和删除项继续保持阻止状态。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollText, Trash2 } from 'lucide-react';
import { ChangeListPanel } from '../components/ChangeListPanel';
import { SyncControlPanel } from '../components/SyncControlPanel';
import { SyncProgress } from '../components/SyncProgress';
import { SyncResultList } from '../components/SyncResultList';
import { FeishuPendingPanel } from '../components/FeishuPendingPanel';
import { LogDrawer } from '../components/LogDrawer';
import { TrashDrawer } from '../components/TrashDrawer';
import { useConfig } from '../hooks/useConfig';
import { useSync } from '../hooks/useSync';
import { useToast } from '../components/common/Toast';
import { appLogger } from '../utils/appLogger';
import { isUsableWikiUrl, pickFirstValidWikiUrl } from '../utils/wikiUrl';
import { detectChanges, requestFeishuPendingRecheck } from '../api/client';
import type { ChangedDocument, DiffReport, FailedDocument, FeishuPendingItem } from '../types';

export function SyncView() {
  const { config } = useConfig();
  const toast = useToast();
  const sync = useSync();
  const contentAdaptationEnabled = config?.llm.contentAdaptationEnabled === true;

  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [diff, setDiff] = useState<DiffReport | null>(null);
  const [repairingParentChains, setRepairingParentChains] = useState(false);
  const [adoptingExistingFiles, setAdoptingExistingFiles] = useState(false);
  const [recheckingFailures, setRecheckingFailures] = useState(false);
  const [diffRefreshSignal, setDiffRefreshSignal] = useState(0);
  // State updates are asynchronous; keep an immediate lock so two rapid
  // clicks cannot launch duplicate full traversals against Feishu.
  const feishuRecheckInFlight = useRef(false);

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

    const confirmed = typeof window === 'undefined' || window.confirm(
      `将把 ${selectedDocs.length} 项已选文档写入本地知识库。\n\n` +
      '已有映射的文件会原子替换；同名但未映射的本地文件不会被覆盖。' +
      (contentAdaptationEnabled
        ? `\n\n已启用文档整理：会通过当前 LLM 通道处理正文；失败时保留确定性原始转换结果。`
        : '') +
      '\n\n是否继续？',
    );
    if (!confirmed) return;

    appLogger.info('sync-view', 'starting confirmed selected-document sync', { count: selectedDocs.length });
    const result = await sync.syncDocuments(selectedDocs, { enableLLM: contentAdaptationEnabled });
    // A sync may have moved non-retryable cloud failures into the durable
    // Feishu queue. Refresh both the normal cached diff and that queue.
    setDiffRefreshSignal((value) => value + 1);
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
    const retryDocs: ChangedDocument[] = failed.map((f) => {
      const orig = allChanges.find((c) => c.objToken === f.objToken);
      return orig ?? {
        objToken: f.objToken,
        objType: 'unknown',
        title: f.title,
        changeType: 'modified' as const,
        cloudModifiedTime: new Date().toISOString(),
        localSyncedTime: null,
        localMdPath: null,
        watchedRootId: f.watchedRootId ?? null,
      };
    });
    if (retryDocs.length === 0) {
      toast.push({ type: 'warning', message: '无原始文档信息可重试' });
      return;
    }
    await sync.syncDocuments(retryDocs, { enableLLM: contentAdaptationEnabled });
    setDiffRefreshSignal((value) => value + 1);
  };

  /**
   * Structural recovery deliberately uses a full traversal only for roots
   * that own the failed entries. It does not fall back to a root README path,
   * and it never retries permission-denied/deleted/unsupported documents.
   */
  const handleRepairParentChains = async (failed: FailedDocument[]) => {
    const targets = failed.filter((item) =>
      item.repairAction === 'rebuild_parent_chain' || item.reasonCode === 'missing_parent_chain',
    );
    if (targets.length === 0 || repairingParentChains) return;

    const confirmed = typeof window === 'undefined' || window.confirm(
      `将完整遍历 ${targets.length} 项所在的飞书知识库根目录，补齐父链后自动同步可安全写入的文档。\n\n` +
      '检测和重试均会串行、低速执行；无权限、已删除和不支持的对象不会被绕过。是否继续？',
    );
    if (!confirmed) return;

    const targetTokens = new Set(targets.map((item) => item.objToken));
    const configuredRoots = (config?.watchedRoots ?? []).filter((root) => root.enabled);
    const requestedRootIds = new Set(
      targets
        .map((item) => item.watchedRootId)
        .filter((id): id is string => Boolean(id)),
    );
    const roots = requestedRootIds.size > 0
      ? configuredRoots.filter((root) => requestedRootIds.has(root.id))
      : configuredRoots;

    if (roots.length === 0) {
      toast.push({
        type: 'warning',
        message: '无法定位受影响的知识库根目录',
        hint: '请在设置中确认 watched root 配置后重新检测。',
      });
      return;
    }

    setRepairingParentChains(true);
    try {
      const recovered = new Map<string, ChangedDocument>();
      const incompleteRoots: string[] = [];

      // Keep roots serial: each full traversal may issue hierarchy lookups;
      // concurrent recovery would defeat the lark-cli global QPS guard.
      for (const root of roots) {
        try {
          const result = await detectChanges(root.url, { mode: 'full' });
          if (result.traversalComplete === false) {
            incompleteRoots.push(root.localDir || root.id);
            continue;
          }
          for (const document of result.changedDocuments) {
            const hierarchyReady = document.isWatchedRootNode === true
              || Array.isArray(document.parentChainTitles);
            if (targetTokens.has(document.objToken) && hierarchyReady) {
              recovered.set(document.objToken, document);
            }
          }
        } catch (error) {
          incompleteRoots.push(root.localDir || root.id);
          appLogger.warn('sync-view', 'parent-chain recovery detect failed', { rootId: root.id, error });
        }
      }

      setDiffRefreshSignal((value) => value + 1);
      if (recovered.size === 0) {
        toast.push({
          type: 'warning',
          message: '未能安全补齐父链，尚未重试写入',
          hint: incompleteRoots.length > 0
            ? `${incompleteRoots.join('、')} 的完整遍历未完成，请稍后重试。`
            : '请先在飞书确认这些节点仍位于已配置的知识库根目录下。',
        });
        return;
      }

      const result = await sync.syncDocuments(
        Array.from(recovered.values()),
        {
          enableLLM: contentAdaptationEnabled,
          // The user has explicitly selected one-click recovery. The server
          // still permits adoption only for profile-path files whose H1
          // exactly matches the cloud title.
          adoptExistingProfileTargets: true,
        },
      );
      setDiffRefreshSignal((value) => value + 1);
      const notRecovered = targets.length - recovered.size;
      toast.push({
        type: result?.success ? 'success' : 'warning',
        message: result?.success ? '结构修复并同步完成' : '结构修复后同步完成（含失败项）',
        hint: `${recovered.size} 项已重试${notRecovered > 0 ? `；${notRecovered} 项仍需后续处理` : ''}`,
      });
    } finally {
      setRepairingParentChains(false);
    }
  };

  const handleAdoptExistingFiles = async (failed: FailedDocument[]) => {
    if (failed.length === 0 || adoptingExistingFiles) return;
    const confirmed = typeof window === 'undefined' || window.confirm(
      `将认领并同步 ${failed.length} 项本地旧文件。\n\n` +
      '系统仅会在文件位于规范路径且 Markdown 一级标题与飞书标题完全一致时覆盖；其他文件会保持不变。是否继续？',
    );
    if (!confirmed) return;

    const documents = failed.map((item) => {
      const current = allChanges.find((document) => document.objToken === item.objToken);
      return current ?? {
        objToken: item.objToken,
        objType: 'unknown' as const,
        title: item.title,
        changeType: 'modified' as const,
        cloudModifiedTime: new Date().toISOString(),
        localSyncedTime: null,
        localMdPath: null,
        watchedRootId: item.watchedRootId ?? null,
      };
    });

    setAdoptingExistingFiles(true);
    try {
      const result = await sync.syncDocuments(documents, {
        enableLLM: contentAdaptationEnabled,
        adoptExistingProfileTargets: true,
      });
      setDiffRefreshSignal((value) => value + 1);
      toast.push({
        type: result?.success ? 'success' : 'warning',
        message: result?.success ? '本地旧文件已认领并同步' : '认领并同步完成（含未处理项）',
        hint: result
          ? `${result.syncedDocuments.length} 成功 / ${result.failedDocuments.length} 未处理`
          : '请求未完成，请查看同步结果。',
      });
    } finally {
      setAdoptingExistingFiles(false);
    }
  };

  /**
   * Permission and remote-deletion repairs happen in Feishu, not locally.
   * Once the operator has fixed them, re-traverse only the owning roots so a
   * stale result cannot make the user manually hunt through every change.
   */
  const handleRecheckFeishuPending = async (items: FeishuPendingItem[]) => {
    if (items.length === 0 || recheckingFailures || feishuRecheckInFlight.current) return;

    const configuredRoots = (config?.watchedRoots ?? []).filter((root) => root.enabled);
    const requestedRootIds = new Set(
      items
        .map((item) => item.watchedRootId)
        .filter((id): id is string => Boolean(id)),
    );
    const roots = requestedRootIds.size > 0
      ? configuredRoots.filter((root) => requestedRootIds.has(root.id))
      : configuredRoots;

    if (roots.length === 0) {
      toast.push({
        type: 'warning',
        message: '无法定位待重新检测的知识库根目录',
        hint: '请在设置中检查 watched root 配置后再试。',
      });
      return;
    }

    feishuRecheckInFlight.current = true;
    setRecheckingFailures(true);
    try {
      // Explicitly release queue suppression *before* the recovery traversal.
      // If Feishu is still inaccessible, LocalMapStore keeps the row queued;
      // a normal detector poll can never release it on its own.
      await requestFeishuPendingRecheck(
        requestedRootIds.size > 0 ? Array.from(requestedRootIds) : undefined,
      );
      const failedRoots: string[] = [];
      // Keep this serial. A permission repair often entails a full traversal,
      // and concurrent refreshes would unnecessarily consume the QPS budget.
      for (const root of roots) {
        try {
          await detectChanges(root.url, { mode: 'full' });
        } catch (error) {
          failedRoots.push(root.localDir || root.id);
          appLogger.warn('sync-view', 'cloud-failure recheck failed', { rootId: root.id, error });
        }
      }
      setDiffRefreshSignal((value) => value + 1);
      toast.push({
        type: failedRoots.length === 0 ? 'success' : 'warning',
        message: failedRoots.length === 0 ? '飞书侧待处理项已重新检测' : '部分根目录重新检测失败',
        hint: failedRoots.length === 0
          ? '已恢复可读的项目会回到变更列表；仍不可读的项目会继续保留在飞书侧待处理。'
          : `${failedRoots.join('、')} 仍不可检测，请确认飞书权限或网络。`,
      });
    } finally {
      feishuRecheckInFlight.current = false;
      setRecheckingFailures(false);
    }
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
    <div className="space-y-5">
      {/*
        同步区布局重构（v0.2.9）：
        原单列长堆叠（变更列表 → 操作面板 → 进度 → 结果）在全宽主区下
        列表过宽、操作面板被挤到屏外。改为：
        - 左栏（flex-1 主区域）：变更列表 + 飞书侧待处理
        - 右栏（340px 操作侧栏，xl 起 sticky 跟随滚动）：同步操作面板 +
          进度 + 回收站/日志入口，「开始同步」始终触手可及
        - 同步结果报告出现时全宽展示在两栏之下（长报告需要横向空间）
        「批量同步」按钮经 onBatchSync 直接复用本视图的 handleStart 流程。
      */}
      <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* Left: change list + feishu pending */}
        <div className="min-w-0 space-y-5">
          <ChangeListPanel
            rootUrl={memoRootUrl}
            rootUrlError={rootUrlError}
            selectedTokens={selectedTokens}
            onSelectionChange={setSelectedTokens}
            onDiffChange={setDiff}
            onTrash={handleTrash}
            onPurge={handlePurge}
            watchedRootUrls={config?.watchedRootUrls}
            reloadSignal={diffRefreshSignal}
            onBatchSync={() => {
              void handleStart();
            }}
          />

          <FeishuPendingPanel
            reloadSignal={diffRefreshSignal}
            rechecking={recheckingFailures}
            onRecheck={handleRecheckFeishuPending}
          />
        </div>

        {/* Right: sync operation sidebar (sticky on xl) */}
        <div className="min-w-0 space-y-4 xl:sticky xl:top-4 xl:self-start">
          <SyncControlPanel
            selectedCount={selectedDocs.length}
            syncing={syncing}
            contentAdaptationEnabled={contentAdaptationEnabled}
            onStart={handleStart}
          />

          <SyncProgress
            syncing={syncing}
            total={sync.total > 0 ? sync.total : selectedDocs.length}
            done={sync.syncResult ? sync.syncResult.syncedDocuments.length + sync.syncResult.failedDocuments.length : 0}
          />

          {sync.error && (
            <div className="p-4 rounded-md border border-seal-2/40 bg-seal-2/5 text-sm text-seal-2">
              同步错误：{sync.error}
            </div>
          )}

          {/* Trash + log entries live in the operation sidebar */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setTrashOpen(true)}
              className="inline-flex flex-1 items-center justify-center gap-2 px-3.5 py-2 text-xs text-ink-soft border border-line rounded-md bg-card-bg hover:bg-paper-2 font-sans-ui transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              回收站
            </button>
            <button
              type="button"
              onClick={() => setLogOpen(true)}
              className="inline-flex flex-1 items-center justify-center gap-2 px-3.5 py-2 text-xs text-ink-soft border border-line rounded-md bg-card-bg hover:bg-paper-2 font-sans-ui transition-colors"
            >
              <ScrollText className="w-3.5 h-3.5" />
              完整日志
            </button>
          </div>
        </div>
      </div>

      {sync.syncResult && (
        <SyncResultList
          result={sync.syncResult}
          onRetry={handleRetry}
          onRepairParentChains={handleRepairParentChains}
          repairingParentChains={repairingParentChains}
          onAdoptExistingFiles={handleAdoptExistingFiles}
          adoptingExistingFiles={adoptingExistingFiles}
          onOpen={handleOpenMd}
          onClear={handleClearResult}
        />
      )}

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
