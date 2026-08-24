/**
 * SyncResultList - 同步结果分组（T6，04 §4.2.2 / §7.2 #14）
 *
 * 消费 useSync.syncResult。兼容展示 dry-run 计划和实际 apply 结果，
 * 并清楚区分成功写入与被安全策略阻止的项。
 * 重试 = 重新调起 useSync.syncDocuments 传入失败项。
 */

import { CheckCircle2, XCircle, FolderOpen, RotateCw, Wrench } from 'lucide-react';
import { Card, CardBody } from './common/Card';
import { Button } from './common/Button';
import type { SyncResult, FailedDocument } from '../types';

interface SyncResultListProps {
  result: SyncResult;
  onRetry?: (failed: FailedDocument[]) => void;
  /** Reconcile an incomplete cloud hierarchy, then retry only those entries. */
  onRepairParentChains?: (failed: FailedDocument[]) => void;
  repairingParentChains?: boolean;
  /** Explicit user-confirmed recovery for title-verified legacy exports. */
  onAdoptExistingFiles?: (failed: FailedDocument[]) => void;
  adoptingExistingFiles?: boolean;
  onOpen?: (localMdPath: string) => void;
  onClear?: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function SyncResultList({
  result,
  onRetry,
  onRepairParentChains,
  repairingParentChains = false,
  onAdoptExistingFiles,
  adoptingExistingFiles = false,
  onOpen,
  onClear,
}: SyncResultListProps) {
  const isDryRun = result.mode === 'dry-run';
  const ok = result.success && result.failedDocuments.length === 0;
  const failedCount = result.failedDocuments.length;
  const cloudSideFailures = result.failedDocuments.filter((document) =>
    document.repairAction === 'grant_access'
      || document.repairAction === 'review_deleted'
      || document.repairAction === 'enable_export_adapter',
  );
  // These failures are persisted into the dedicated Feishu queue. Keeping
  // their per-document rows out of this transient result card prevents the
  // same issue being shown here and again in the durable queue.
  const visibleFailures = result.failedDocuments.filter((document) => !cloudSideFailures.includes(document));
  const retryableFailures = visibleFailures.filter((document) => document.retryable);
  const parentChainFailures = result.failedDocuments.filter((document) =>
    document.repairAction === 'rebuild_parent_chain' || document.reasonCode === 'missing_parent_chain',
  );
  const existingFileFailures = result.failedDocuments.filter((document) =>
    document.repairAction === 'adopt_existing_file',
  );
  const plannedDocuments = result.plannedDocuments ?? [];
  const writablePlans = plannedDocuments.filter((document) => document.action !== 'blocked');
  const successCount = isDryRun ? writablePlans.length : result.syncedDocuments.length;
  const issueLabel = isDryRun ? '阻止' : '失败';

  return (
    <Card variant={ok ? 'default' : 'elevated'} className={ok ? 'border-jade/30' : 'border-seal/30'}>
      <CardBody className="space-y-3">
        {/* Header summary */}
        <div className="flex items-center gap-2">
          {ok ? (
            <CheckCircle2 className="w-4 h-4 text-jade" />
          ) : (
            <XCircle className="w-4 h-4 text-seal-2" />
          )}
          <span className="text-sm text-ink font-medium">
            {isDryRun
              ? (ok ? '核验计划已生成' : '核验计划已生成（含阻止项）')
              : (ok ? '同步完成' : '同步完成（含失败项）')}
          </span>
          <span className="text-xs text-ink-faint font-sans-ui">
            {isDryRun
              ? `${successCount} 待写入 / ${failedCount} ${issueLabel}`
              : `${successCount} 成功 / ${failedCount} ${issueLabel}`}
            {' · 用时 '}{formatDuration(result.duration)}
          </span>
        </div>

        {/* Dry-run plan */}
        {isDryRun && writablePlans.length > 0 && (
          <div>
            <p className="text-[11px] text-ink-faint uppercase tracking-wide mb-1.5">
              待明确 apply 的写入计划 ({writablePlans.length})
            </p>
            <ul className="space-y-1">
              {writablePlans.map((document) => (
                <li
                  key={document.objToken}
                  className="flex items-center gap-2 px-2 py-1.5 rounded bg-paper-2/50"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 text-jade shrink-0" />
                  <span className="flex-1 text-sm text-ink truncate">{document.title}</span>
                  <span className="text-[11px] text-ink-faint font-sans-ui">
                    {document.action === 'create' ? '新增' : '替换'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Completed apply results */}
        {!isDryRun && successCount > 0 && (
          <div>
            <p className="text-[11px] text-ink-faint uppercase tracking-wide mb-1.5">
              成功 ({successCount})
            </p>
            <ul className="space-y-1">
              {result.syncedDocuments.map((d) => (
                <li
                  key={d.objToken}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-paper-2"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 text-jade shrink-0" />
                  <span className="flex-1 text-sm text-ink truncate">{d.title}</span>
                  <span className="text-[11px] text-ink-faint font-sans-ui">
                    {d.imagesCount > 0 && `${d.imagesCount} 图 · `}
                    {d.sheetsCount > 0 && `${d.sheetsCount} 表 · `}
                    {Math.max(1, Math.round(d.size / 1024))} KB
                  </span>
                  {onOpen && (
                    <button
                      type="button"
                      onClick={() => onOpen(d.localMdPath)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-ink-soft border border-line rounded bg-card-bg hover:bg-paper-2 font-sans-ui"
                    >
                      <FolderOpen className="w-3 h-3" />
                      打开
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Failed list */}
        {failedCount > 0 && (
          <div>
            <p className="text-[11px] text-seal-2 uppercase tracking-wide mb-1.5">
              {issueLabel} ({failedCount})
            </p>
            {onRepairParentChains && parentChainFailures.length > 0 && (
              <div className="mb-2.5 flex flex-col gap-2 rounded-md border border-seal/30 bg-seal/5 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink">
                    {parentChainFailures.length} 项缺少云端父链，可自动处理
                  </p>
                  <p className="mt-0.5 text-[11px] leading-5 text-ink-faint">
                    将完整遍历受影响的知识库根目录，补齐结构映射后只重试这些文档；过程为串行低速执行，避免飞书 QPS 限流。
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={repairingParentChains}
                  onClick={() => onRepairParentChains(parentChainFailures)}
                  className="shrink-0"
                >
                  <Wrench className="w-3.5 h-3.5" />
                  {repairingParentChains ? '正在补齐结构…' : '自动补齐结构并重试'}
                </Button>
              </div>
            )}
            {onAdoptExistingFiles && existingFileFailures.length > 0 && (
              <div className="mb-2.5 flex flex-col gap-2 rounded-md border border-jade/30 bg-jade/5 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink">
                    {existingFileFailures.length} 项已有同路径的本地旧文件，可安全认领
                  </p>
                  <p className="mt-0.5 text-[11px] leading-5 text-ink-faint">
                    仅当本地 Markdown 的一级标题与飞书标题完全一致时才会建立映射并原子替换；不匹配的文件仍会保留并提示人工处理。
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={adoptingExistingFiles}
                  onClick={() => onAdoptExistingFiles(existingFileFailures)}
                  className="shrink-0"
                >
                  <Wrench className="w-3.5 h-3.5" />
                  {adoptingExistingFiles ? '正在认领并同步…' : '认领本地旧文件并同步'}
                </Button>
              </div>
            )}
            {cloudSideFailures.length > 0 && (
              <div className="mb-2.5 rounded-md border border-line bg-paper-2/50 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink">
                    {cloudSideFailures.length} 项已收入“飞书侧待处理”
                  </p>
                  <p className="mt-0.5 text-[11px] leading-5 text-ink-faint">
                    它们不会再出现在最近变更；完成授权、恢复/替换页面或启用对应导出能力后，请在待处理面板点击“处理后重新检测”。
                  </p>
                </div>
              </div>
            )}
            {visibleFailures.length > 0 && (
              <ul className="space-y-1">
              {visibleFailures.map((d) => (
                <li
                  key={d.objToken}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-paper-2"
                >
                  <XCircle className="w-3.5 h-3.5 text-seal-2 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-ink truncate">{d.title}</p>
                    <p className="text-[11px] text-ink-faint truncate">错误：{d.error}</p>
                    {d.suggestedResolution && (
                      <p className="mt-0.5 text-[11px] leading-5 text-ink-soft">
                        处理方案：{d.suggestedResolution}
                      </p>
                    )}
                  </div>
                  {onRetry && d.retryable && (
                    <button
                      type="button"
                      onClick={() => onRetry([d])}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-seal border border-seal/40 rounded bg-card-bg hover:bg-seal/5 font-sans-ui"
                    >
                      <RotateCw className="w-3 h-3" />
                      重试
                    </button>
                  )}
                </li>
              ))}
              </ul>
            )}
            {onRetry && retryableFailures.length > 1 && (
              <button
                type="button"
                onClick={() => onRetry(retryableFailures)}
                className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 text-xs text-seal border border-seal/40 rounded bg-card-bg hover:bg-seal/5 font-sans-ui"
              >
                <RotateCw className="w-3.5 h-3.5" />
                重试全部可重试项
              </button>
            )}
          </div>
        )}

        <div className="flex items-center justify-end pt-1 border-t border-line">
          {onClear && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              清空结果
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
