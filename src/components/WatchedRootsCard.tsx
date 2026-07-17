/**
 * WatchedRootsCard - P2 结构化 watchedRoots 配置面板。
 *
 * A root is an explicit sync authority: wiki token, canonical URL, local
 * directory, layout profile and enabled state travel together. URL-only
 * editing is deliberately kept out of this card so path planning never has
 * to infer a local layout from a remote link.
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
import { Input, Select, Toggle } from './common/Input';
import { useToast } from './common/Toast';
import { useConfig } from '../hooks/useConfig';
import { getMappingIndex } from '../api/client';
import { normalizeFeishuUrl } from '../utils/feishu-url';
import { appLogger } from '../utils/appLogger';
import type {
  Config,
  IndexSnapshot,
  LayoutProfile,
  WatchedRoot,
  WatchedRootConfig,
} from '../types';

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

const LAYOUT_OPTIONS = [
  { value: 'directory-readme', label: '目录 + README.md' },
  { value: 'mirror-title-file', label: '镜像标题文件' },
];

function createEmptyRoot(): WatchedRootConfig {
  return {
    id: '',
    url: '',
    localDir: '',
    layoutProfile: 'directory-readme',
    enabled: true,
  };
}

function extractRootId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/wiki\/([A-Za-z0-9]+)$/);
    if (parsed.protocol !== 'https:' || !/\.feishu\.cn$/i.test(parsed.hostname) || !match) {
      return null;
    }
    return match[1];
  } catch {
    return null;
  }
}

type RootRow = {
  root: WatchedRootConfig;
  status: WatchedRootStatus | 'pending';
  watchedRoot?: WatchedRoot;
};

/** Join config roots to snapshot status by stable root id first, then URL. */
function mergeConfigWithSnapshot(
  configured: WatchedRootConfig[],
  snapshot: WatchedRoot[] | undefined,
): RootRow[] {
  const byId = new Map<string, WatchedRoot>();
  const byUrl = new Map<string, WatchedRoot>();
  for (const root of snapshot ?? []) {
    byId.set(root.nodeToken, root);
    byUrl.set(root.url, root);
  }
  return configured.map((root) => {
    const watchedRoot = byId.get(root.id) ?? byUrl.get(root.url);
    return {
      root,
      status: watchedRoot?.status ?? 'pending',
      watchedRoot,
    };
  });
}

export function WatchedRootsCard() {
  const { config, saving, updateConfig } = useConfig();
  const toast = useToast();
  const [localRoots, setLocalRoots] = useState<WatchedRootConfig[]>([]);
  const [snapshot, setSnapshot] = useState<IndexSnapshot | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);

  useEffect(() => {
    if (config) {
      const roots = config.watchedRoots ?? [];
      setLocalRoots(roots.length > 0 ? roots : [createEmptyRoot()]);
    }
  }, [config]);

  const fetchSnapshot = async () => {
    setLoadingSnapshot(true);
    try {
      setSnapshot(await getMappingIndex());
    } catch (err) {
      // Snapshot is generated after detection/indexing; absent on first run.
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
    () => mergeConfigWithSnapshot(localRoots, snapshot?.watched_roots),
    [localRoots, snapshot],
  );

  const summary = useMemo(() => {
    const configured = rows.filter((row) => row.root.url.trim().length > 0);
    const synced = configured.filter((row) => row.status === 'synced' && row.root.enabled).length;
    const missing = configured.filter(
      (row) => row.root.enabled && (row.status === 'missing_in_db' || row.status === 'pending'),
    ).length;
    const disabled = configured.filter((row) => !row.root.enabled).length;
    const errored = configured.filter((row) => row.status === 'error' && row.root.enabled).length;
    return { total: configured.length, synced, missing, disabled, errored };
  }, [rows]);

  const updateRoot = (index: number, patch: Partial<WatchedRootConfig>) => {
    setLocalRoots((previous) => previous.map((root, currentIndex) => (
      currentIndex === index ? { ...root, ...patch } : root
    )));
  };

  const addRoot = () => setLocalRoots((previous) => [...previous, createEmptyRoot()]);

  const removeRoot = (index: number) => {
    setLocalRoots((previous) => {
      const next = previous.filter((_, currentIndex) => currentIndex !== index);
      return next.length > 0 ? next : [createEmptyRoot()];
    });
  };

  const handleBlur = (index: number, value: string) => {
    if (!value.trim()) return;
    const { canonical, wasModified, isValid } = normalizeFeishuUrl(value);
    if (wasModified && isValid) {
      updateRoot(index, { url: canonical });
      toast.push({ type: 'info', message: 'URL 已规范化', hint: canonical });
    }
  };

  const handleSave = async () => {
    const draftRoots = localRoots.filter((root) => root.url.trim() || root.localDir.trim());
    const normalizedRoots: WatchedRootConfig[] = [];
    const ids = new Set<string>();

    for (const root of draftRoots) {
      const normalizedUrl = normalizeFeishuUrl(root.url);
      const id = normalizedUrl.isValid ? extractRootId(normalizedUrl.canonical) : null;
      const localDir = root.localDir.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
      if (!id) {
        toast.push({
          type: 'warning',
          message: '存在无效的飞书根 URL',
          hint: '必须是 https://<租户>.feishu.cn/wiki/<token>，且每行都需要有效 URL。',
        });
        return;
      }
      if (!localDir || localDir.startsWith('/') || /^[A-Za-z]:\//.test(localDir) || localDir.split('/').some(
        (segment) => !segment || segment === '.' || segment === '..',
      )) {
        toast.push({
          type: 'warning',
          message: '本地目录必须是知识库根目录下的相对路径',
          hint: '例如“技术 - Dev”；不能使用绝对路径或 ..。',
        });
        return;
      }
      if (ids.has(id)) {
        toast.push({ type: 'warning', message: '同一个飞书根目录不能重复配置', hint: id });
        return;
      }
      ids.add(id);
      normalizedRoots.push({
        id,
        url: normalizedUrl.canonical,
        localDir,
        layoutProfile: root.layoutProfile as LayoutProfile,
        enabled: root.enabled,
      });
    }

    try {
      // Never resend `llm`: GET returns a masked api key. Structured roots
      // are validated again by ConfigManager before anything is persisted.
      const patch: Partial<Config> = { watchedRoots: normalizedRoots };
      await updateConfig(patch);
      setLocalRoots(normalizedRoots.length > 0 ? normalizedRoots : [createEmptyRoot()]);
      toast.push({
        type: 'success',
        message: `已保存（${normalizedRoots.length} 个 watchedRoot）`,
        hint: '启用的根目录会在下次「立即检测」或轮询时参与同步。',
      });
    } catch (err) {
      toast.push({
        type: 'error',
        message: '保存 watchedRoots 失败',
        hint: err instanceof Error ? err.message : '',
      });
    }
  };

  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <Database className="w-4 h-4 text-seal" />
          <h2 className="text-base font-kai font-medium text-ink">同步根目录与布局</h2>
          <span className="ml-auto text-xs text-ink-faint font-sans-ui">
            {summary.total} 个 · {summary.synced} 已同步 · {summary.missing} 待检测
            {summary.disabled > 0 && ` · ${summary.disabled} 已停用`}
            {summary.errored > 0 && ` · ${summary.errored} 错误`}
          </span>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-xs text-ink-faint font-sans-ui">
          每个同步根目录同时声明飞书节点、本地目录和目录布局。停用后会保留历史映射与状态，但不会参与检测、轮询或同步。
        </p>

        <div className="space-y-3">
          {rows.map((row, index) => {
            const statusMeta = !row.root.enabled
              ? { icon: CloudOff, label: '已停用', dotCls: 'bg-ink-faint/40', iconCls: 'text-ink-faint' }
              : row.status !== 'pending'
                ? STATUS_META[row.status]
                : { icon: Circle, label: '尚未检测', dotCls: 'bg-ink-faint/40', iconCls: 'text-ink-faint' };
            const StatusIcon = statusMeta.icon;
            const watchedRoot = row.watchedRoot;
            const displayName = watchedRoot?.displayName || watchedRoot?.title || row.root.localDir;
            return (
              <div
                key={`${row.root.id || 'new'}-${index}`}
                className="rounded-md border border-line bg-paper p-3 space-y-3"
              >
                <div className="flex items-start gap-2">
                  <span className={`mt-1.5 inline-block w-2 h-2 rounded-full ${statusMeta.dotCls} shrink-0`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-ink" style={{ fontFamily: 'var(--kai)' }}>
                        {displayName || '新的同步根目录'}
                      </span>
                      <span className={`inline-flex items-center gap-1 text-[11px] font-sans-ui ${statusMeta.iconCls}`}>
                        <StatusIcon className="w-3 h-3" />
                        {statusMeta.label}
                      </span>
                      {watchedRoot && watchedRoot.childCount > 0 && (
                        <span className="text-[11px] text-ink-faint font-sans-ui">{watchedRoot.childCount} 子节点</span>
                      )}
                      {watchedRoot?.diagnostic && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-seal-2 font-sans-ui" title={watchedRoot.diagnostic}>
                          <AlertCircle className="w-3 h-3" />
                          {watchedRoot.diagnostic}
                        </span>
                      )}
                    </div>
                    {row.root.id && <p className="mt-1 text-[11px] text-ink-faint font-mono">根节点：{row.root.id}</p>}
                  </div>
                  <Button variant="ghost" size="md" onClick={() => removeRoot(index)} title="删除此同步根目录">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Input
                    label="飞书根 URL"
                    fullWidth
                    type="url"
                    value={row.root.url}
                    onChange={(event) => updateRoot(index, { url: event.target.value })}
                    onBlur={(event) => handleBlur(index, event.target.value)}
                    placeholder={DEFAULT_PLACEHOLDER}
                  />
                  <Input
                    label="本地目录（相对知识库根目录）"
                    fullWidth
                    value={row.root.localDir}
                    onChange={(event) => updateRoot(index, { localDir: event.target.value })}
                    placeholder="例如：技术 - Dev"
                  />
                  <Select
                    label="目录布局"
                    value={row.root.layoutProfile}
                    options={LAYOUT_OPTIONS}
                    onChange={(event) => updateRoot(index, {
                      layoutProfile: event.target.value as LayoutProfile,
                    })}
                  />
                  <div className="self-end rounded-md border border-line bg-card-bg px-3 py-2">
                    <Toggle
                      label="启用此同步根目录"
                      checked={row.root.enabled}
                      onChange={(enabled) => updateRoot(index, { enabled })}
                      helperText="停用后不遍历、不检测，也不写入本地文件。"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={addRoot}>
            <Plus className="w-3.5 h-3.5" />
            添加同步根目录
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void fetchSnapshot()}
            loading={loadingSnapshot}
            title="从 _index.json 重新读取状态"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            刷新状态
          </Button>
        </div>

        <div className="flex justify-end pt-3 border-t border-line">
          <Button onClick={handleSave} loading={saving}>保存同步根目录</Button>
        </div>
      </CardBody>
    </Card>
  );
}
