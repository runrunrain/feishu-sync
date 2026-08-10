/**
 * Durable queue for failures that require a human action in Feishu.
 *
 * Unlike normal sync failures, these rows are intentionally excluded from the
 * added/modified diff until the operator explicitly requests a recovery scan.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Cloud, RotateCw } from 'lucide-react';
import { listFeishuPending } from '../api/client';
import { Card, CardBody, CardHeader } from './common/Card';
import { Button } from './common/Button';
import type { FeishuPendingItem } from '../types';

interface FeishuPendingPanelProps {
  /** Incremented after sync/recheck so the server-backed queue is refreshed. */
  reloadSignal: number;
  rechecking?: boolean;
  onRecheck: (items: FeishuPendingItem[]) => void;
}

function actionLabel(item: FeishuPendingItem): string {
  switch (item.repairAction) {
    case 'grant_access':
      return '等待授权';
    case 'review_deleted':
      return '等待恢复或替换';
    case 'enable_export_adapter':
      return '等待启用导出能力';
    default:
      return '等待飞书侧处理';
  }
}

export function FeishuPendingPanel({
  reloadSignal,
  rechecking = false,
  onRecheck,
}: FeishuPendingPanelProps) {
  const [items, setItems] = useState<FeishuPendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listFeishuPending()
      .then((nextItems) => {
        if (!cancelled) setItems(nextItems);
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : '无法读取飞书侧待处理列表');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadSignal]);

  if (!loading && !error && items.length === 0) return null;

  return (
    <Card variant="sunken" className="border-amber-700/30">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-ink">
            <Cloud className="h-4 w-4 text-seal shrink-0" />
            <h2 className="text-base font-medium">飞书侧待处理{items.length > 0 ? `（${items.length}）` : ''}</h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-ink-faint">
            这些项目已暂停自动检测提示，不会再出现在最近变更；完成飞书侧处理后再重新检测。
          </p>
        </div>
        {items.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            loading={rechecking}
            onClick={() => onRecheck(items)}
            className="shrink-0"
          >
            <RotateCw className="h-3.5 w-3.5" />
            {rechecking ? '正在重新检测…' : '处理后重新检测'}
          </Button>
        )}
      </CardHeader>
      <CardBody className="space-y-3">
        {loading && items.length === 0 && (
          <p className="text-sm text-ink-faint">正在读取待处理项…</p>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-seal/30 bg-seal/5 px-3 py-2 text-sm text-seal-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>读取待处理项失败：{error}</span>
          </div>
        )}
        {items.map((item) => (
          <article key={item.objToken} className="rounded-md border border-line bg-card-bg px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 flex-1 text-sm font-medium text-ink break-words">{item.title || item.objToken}</h3>
              <span className="rounded border border-line bg-paper-2 px-1.5 py-0.5 text-[11px] text-ink-soft">
                {actionLabel(item)}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-ink-faint break-words">原因：{item.error}</p>
            {item.suggestedResolution && (
              <p className="mt-1 text-xs leading-5 text-ink-soft break-words">处理方案：{item.suggestedResolution}</p>
            )}
          </article>
        ))}
      </CardBody>
    </Card>
  );
}

