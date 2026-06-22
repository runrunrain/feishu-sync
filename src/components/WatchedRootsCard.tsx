/**
 * WatchedRootsCard - watchedRoots 配置面板（D4，伏羲 §3.2 + 04 §4.3）
 *
 * 与 KnowledgeSettingsCard 的关系：
 *   - KnowledgeSettingsCard 仍管理 knowledgeBaseRoot / 轮询 / lark-cli 路径
 *     以及 watchedRootUrls 输入框列表（URL 字符串）。
 *   - 本卡片是 watchedRoots 的"状态面板"：读取 _index.json.watched_roots
 *     显示每个 URL 对应的 displayName / localDir / status / childCount。
 *   - 主上可在此添加 / 编辑 / 删除 4 个 watchedRoot（策划 / 技术 / 规范 / 开发指引），
 *     与 KnowledgeSettingsCard 的 URL 列表双向同步（共享 useConfig）。
 *
 * 视觉：
 *   - 每行显示：状态点（synced=jade / missing_in_db=ink-faint / error=seal）+
 *     displayName + URL（截断 + tooltip）+ localDir + childCount。
 *   - 顶部摘要：「N 个 watchedRoot · X 已同步 · Y 待检测」。
 *
 * 数据来源：
 *   - 配置：useConfig().config.watchedRootUrls（写入到后端 config）。
 *   - 状态：getMappingIndex() 返回的 IndexSnapshot.watched_roots（最近一次索引快照）。
 *
 * 状态 vs 配置的区别：
 *   - 配置是用户写在 watchedRootUrls 中的 URL 字符串数组（"应该追踪哪些"）。
 *   - 状态是后端从 documents 表派生的 watchedRoots 结构（"实际追踪到了什么"）。
 *   - 两者解耦：用户可以先配置 URL，等下次 detect / rebuild 后才看到状态。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Database,
  Plus,
  Trash2,
  RefreshCw,
  CloudOff,
  CheckCircle2,
  Circle,
  AlertCircle,
} from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { Button } from './common/Button';
import { Input } from './common/Input';
import { useToast } from './common/Toast';
import { useConfig } from '../hooks/useConfig';
import { getMappingIndex } from '../api/client';
import { normalizeFeishuUrl, normalizeFeishuUrlList } from '../utils/feishu-url';
import { appLogger } from '../utils/appLogger';
import type { Config, IndexSnapshot, WatchedRoot } from '../types';

const DEFAULT_PLACEHOLDER = 'https://xxx.feishu.cn/wiki/<token>';

type WatchedRootStatus = WatchedRoot['status'];

const STATUS_META: Record<
  WatchedRootStatus,
  { icon: typeof CheckCircle2; label: string; dotCls: string; iconCls: string }
> = {
  synced: {
    icon: CheckCircle2,
    label: '已同步',
    dotCls: 'bg-jade',
    iconCls: 'text-jade',
  },
  missing_in_db: {
    icon: Circle,
    label: '未检测到本地文档',
    dotCls: 'bg-ink-faint',
    iconCls: 'text-ink-faint',
  },
  error: {
    icon: AlertCircle,
    label: '同步出错',
    dotCls: 'bg-seal-2',
    iconCls: 'text-seal-2',
  },
};

/**
 * Merge configured URLs with snapshot-derived watchedRoots so every
 * configured URL gets a row, even when the backend hasn't materialised
 * a watchedRoot record for it yet (typical right after first save).
 */
function mergeConfigWithSnapshot(
  configured: string[],
  snapshot: WatchedRoot[] | undefined,
): Array<{ url: string; status: WatchedRootStatus | 'pending'; watchedRoot?: WatchedRoot }> {
  const byUrl = new Map<string, WatchedRoot>();
  if (snapshot) for (const wr of snapshot) byUrl.set(wr.url, wr);
  const seen = new Set<string>();
  const rows: Array<{ url: string; status: WatchedRootStatus | 'pending'; watchedRoot?: WatchedRoot }> = [];
  for (const url of configured) {
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const wr = byUrl.get(url);
    rows.push({ url, status: wr ? wr.status : 'pending', watchedRoot: wr });
  }
  return rows;
}

export function WatchedRootsCard() {
  const { config, saving, updateConfig } = useConfig();
  const toast = useToast();
  const [localUrls, setLocalUrls] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<IndexSnapshot | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);

  useEffect(() => {
    if (config) {
      const urls = (config.watchedRootUrls ?? []).filter(Boolean);
      setLocalUrls(urls.length > 0 ? urls : ['']);
    }
  }, [config]);

  const fetchSnapshot = async () => {
    setLoadingSnapshot(true);
    try {
      const snap = await getMappingIndex();
      setSnapshot(snap);
    } catch (err) {
      // 404 → snapshot not generated yet; not an error worth surfacing.
      appLogger.warn('watched-roots', 'getMappingIndex failed (non-fatal)', err);
      setSnapshot(null);
    } finally {
      setLoadingSnapshot(false);
    }
  };

  useEffect(() => {
    void fetchSnapshot();
  }, []);

  const rows = useMemo(
    () => mergeConfigWithSnapshot(localUrls.filter(Boolean), snapshot?.watched_roots),
    [localUrls, snapshot],
  );

  const summary = useMemo(() => {
    const synced = rows.filter((r) => r.status === 'synced').length;
    const missing = rows.filter((r) => r.status === 'missing_in_db' || r.status === 'pending').length;
    const errored = rows.filter((r) => r.status === 'error').length;
    return { total: rows.length, synced, missing, errored };
  }, [rows]);

  const setUrl = (idx: number, value: string) => {
    setLocalUrls((prev) => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });
  };

  const addUrl = () => {
    setLocalUrls((prev) => [...prev, '']);
  };

  const removeUrl = (idx: number) => {
    setLocalUrls((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    const normalized = normalizeFeishuUrlList(localUrls);
    if (normalized.length === 0) {
      toast.push({
        type: 'warning',
        message: '请至少填写一个飞书根 URL',
        hint: '可在飞书知识空间复制链接后粘贴到此处',
      });
      return;
    }
    try {
      // Only send watchedRootUrls; rest of config untouched. NEVER send llm
      // (useConfig.updateConfig merges into existing config; the merge layer
      // already drops masked apiKey — but we additionally skip llm here).
      const patch: Partial<Config> = { watchedRootUrls: normalized };
      await updateConfig(patch);
      toast.push({
        type: 'success',
        message: `已保存（${normalized.length} 个 watchedRoot）`,
        hint: '下次「立即检测」或「刷新索引」后状态会更新',
      });
    } catch (err) {
      toast.push({
        type: 'error',
        message: '保存 watchedRoots 失败',
        hint: err instanceof Error ? err.message : '',
      });
    }
  };

  const handleBlur = (idx: number, value: string) => {
    if (!value.trim()) return;
    const { canonical, wasModified, isValid } = normalizeFeishuUrl(value);
    if (wasModified && isValid) {
      setUrl(idx, canonical);
      toast.push({
        type: 'info',
        message: 'URL 已规范化',
        hint: canonical,
      });
    } else if (!isValid) {
      toast.push({
        type: 'warning',
        message: '看起来不是有效的飞书 wiki URL',
        hint: '需要包含 /wiki/<token> 片段',
      });
    }
  };

  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <Database className="w-4 h-4 text-seal" />
          <h2 className="text-base font-kai font-medium text-ink">watchedRoots 配置</h2>
          <span className="ml-auto text-xs text-ink-faint font-sans-ui">
            {summary.total} 个 · {summary.synced} 已同步 · {summary.missing} 待检测
            {summary.errored > 0 && ` · ${summary.errored} 错误`}
          </span>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-xs text-ink-faint font-sans-ui">
          飞书知识空间的根节点 URL。每个 URL 在飞书视图中作为一个顶层分组，
          下次「立即检测」或「刷新索引」后状态会更新。
        </p>

        <div className="space-y-2.5">
          {rows.length === 0 && (
            <div className="text-xs text-ink-faint font-sans-ui italic">
              （尚未配置任何 watchedRoot）
            </div>
          )}
          {rows.map((row, idx) => {
            const statusMeta = row.status !== 'pending'
              ? STATUS_META[row.status]
              : { icon: Circle, label: '尚未检测', dotCls: 'bg-ink-faint/40', iconCls: 'text-ink-faint' };
            const StatusIcon = statusMeta.icon;
            const wr = row.watchedRoot;
            const displayName = wr?.displayName || wr?.title || wr?.localDir;
            return (
              <div
                key={`${idx}-${row.url}`}
                className="rounded-md border border-line bg-paper p-3 space-y-2"
              >
                <div className="flex items-start gap-2">
                  <span className={`mt-1.5 inline-block w-2 h-2 rounded-full ${statusMeta.dotCls} shrink-0`} />
                  <div className="flex-1 min-w-0 space-y-1">
                    {displayName && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="text-sm font-medium text-ink"
                          style={{ fontFamily: 'var(--kai)' }}
                        >
                          {displayName}
                        </span>
                        {wr?.localDir && (
                          <span className="text-[11px] text-ink-faint font-mono">
                            {wr.localDir}
                          </span>
                        )}
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] font-sans-ui ${statusMeta.iconCls}`}
                        >
                          <StatusIcon className="w-3 h-3" />
                          {statusMeta.label}
                        </span>
                        {wr && wr.childCount > 0 && (
                          <span className="text-[11px] text-ink-faint font-sans-ui">
                            {wr.childCount} 子节点
                          </span>
                        )}
                        {wr?.diagnostic && (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] text-seal-2 font-sans-ui"
                            title={wr.diagnostic}
                          >
                            <CloudOff className="w-3 h-3" />
                            {wr.diagnostic}
                          </span>
                        )}
                      </div>
                    )}
                    <Input
                      fullWidth
                      type="url"
                      value={localUrls[idx] ?? row.url}
                      onChange={(e) => setUrl(idx, e.target.value)}
                      onBlur={(e) => handleBlur(idx, e.target.value)}
                      placeholder={DEFAULT_PLACEHOLDER}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="md"
                    onClick={() => removeUrl(idx)}
                    title="删除此 watchedRoot"
                    disabled={rows.length === 1}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={addUrl}>
            <Plus className="w-3.5 h-3.5" />
            添加 watchedRoot
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void fetchSnapshot()}
            loading={loadingSnapshot}
            title="从 _index.json 重新读取 watchedRoots 状态"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            刷新状态
          </Button>
          <span className="ml-auto text-xs text-ink-faint font-sans-ui">
            建议 4 个：[规范] 研发规范 · [指引] 开发环境指引 · [技术] 技术开发 · [策划] 策划设计
          </span>
        </div>

        <div className="flex justify-end pt-3 border-t border-line">
          <Button onClick={handleSave} loading={saving}>
            保存 watchedRoots
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
