/**
 * SyncView - 同步主区（T2/T4，04 §4.2）
 *
 * 本 Task（P4-1）：建核心可见成果 = ChangeListPanel（三状态）+ LogDrawer 入口。
 * 完整 SyncControlPanel/SyncProgress/SyncResultList/TrashDrawer 留 P4-2
 * （已在 04 §7.2 #12/#13/#14/#18 设计，本 Task 不实现以免与 P3 集成冲突）。
 *
 * selectedTokens 由本视图持有（不再跨 Tab 钻取，04 §10.3 G2.5 配合点）。
 */

import { useMemo, useState } from 'react';
import { ScrollText, Trash2 } from 'lucide-react';
import { ChangeListPanel } from '../components/ChangeListPanel';
import { LogDrawer } from '../components/LogDrawer';
import { useConfig } from '../hooks/useConfig';
import { useToast } from '../components/common/Toast';
import { isUsableWikiUrl, pickFirstValidWikiUrl } from '../utils/wikiUrl';

export function SyncView() {
  const { config } = useConfig();
  const toast = useToast();
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);

  const activeRootUrl = pickFirstValidWikiUrl(config?.watchedRootUrls);
  const rootUrlError = !activeRootUrl
    ? (config?.watchedRootUrls?.length ?? 0) === 0
      ? '请先在设置中配置飞书根 URL（形如 https://xxx.feishu.cn/wiki/<token>）'
      : '配置的飞书根 URL 格式无效，请在设置中改为形如 https://xxx.feishu.cn/wiki/<token> 的地址'
    : null;

  const handleTrash = (objToken: string) => {
    // TrashDrawer lands in P4-2; surface intent via toast + log.
    toast.push({
      type: 'info',
      message: '回收站抽屉将在 P4-2 落地',
      hint: `objToken: ${objToken}`,
    });
  };

  const handlePurge = (objToken: string) => {
    toast.push({
      type: 'warning',
      message: '永久清理入口将在 P4-2 接入',
      hint: `objToken: ${objToken}`,
    });
  };

  const memoRootUrl = useMemo(() => (isUsableWikiUrl(activeRootUrl) ? activeRootUrl : null), [activeRootUrl]);

  return (
    <div className="space-y-3">
      {/* Action row: log + trash entry stubs */}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setLogOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-ink-soft border border-line rounded-md bg-card-bg hover:bg-paper-2 font-sans-ui transition-colors"
        >
          <ScrollText className="w-3.5 h-3.5" />
          查看完整日志
        </button>
        <button
          type="button"
          onClick={() =>
            toast.push({
              type: 'info',
              message: '回收站抽屉将在 P4-2 落地',
            })
          }
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-ink-soft border border-line rounded-md bg-card-bg hover:bg-paper-2 font-sans-ui transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          回收站
        </button>
      </div>

      <ChangeListPanel
        rootUrl={memoRootUrl}
        rootUrlError={rootUrlError}
        selectedTokens={selectedTokens}
        onSelectionChange={setSelectedTokens}
        onTrash={handleTrash}
        onPurge={handlePurge}
      />

      <LogDrawer open={logOpen} onClose={() => setLogOpen(false)} />
    </div>
  );
}
