/**
 * SyncResultList - 同步结果分组（T6，04 §4.2.2 / §7.2 #14）
 *
 * 消费 useSync.syncResult。成功/失败分组，每项含「打开」「重试」。
 * 重试 = 重新调起 useSync.syncDocuments 传入失败项。
 */

import { CheckCircle2, XCircle, FolderOpen, RotateCw } from 'lucide-react';
import { Card, CardBody } from './common/Card';
import { Button } from './common/Button';
import type { SyncResult, FailedDocument } from '../types';

interface SyncResultListProps {
  result: SyncResult;
  onRetry?: (failed: FailedDocument[]) => void;
  onOpen?: (localMdPath: string) => void;
  onClear?: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function SyncResultList({ result, onRetry, onOpen, onClear }: SyncResultListProps) {
  const ok = result.success && result.failedDocuments.length === 0;
  const failedCount = result.failedDocuments.length;
  const successCount = result.syncedDocuments.length;

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
            {ok ? '同步完成' : '同步完成（含失败项）'}
          </span>
          <span className="text-xs text-ink-faint font-sans-ui">
            {successCount} 成功 / {failedCount} 失败 · 用时 {formatDuration(result.duration)}
          </span>
        </div>

        {/* Success list */}
        {successCount > 0 && (
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
              失败 ({failedCount})
            </p>
            <ul className="space-y-1">
              {result.failedDocuments.map((d) => (
                <li
                  key={d.objToken}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-paper-2"
                >
                  <XCircle className="w-3.5 h-3.5 text-seal-2 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-ink truncate">{d.title}</p>
                    <p className="text-[11px] text-ink-faint truncate">错误：{d.error}</p>
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
            {onRetry && failedCount > 1 && (
              <button
                type="button"
                onClick={() => onRetry(result.failedDocuments)}
                className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 text-xs text-seal border border-seal/40 rounded bg-card-bg hover:bg-seal/5 font-sans-ui"
              >
                <RotateCw className="w-3.5 h-3.5" />
                重试全部失败项
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
