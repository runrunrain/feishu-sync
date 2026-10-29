/**
 * WatchedRootsCard - P2 结构化 watchedRoots 配置面板（v0.2.9 子页侧边栏模式）。
 *
 * A root is an explicit sync authority: wiki token, canonical URL, local
 * directory, layout profile and enabled state travel together. URL-only
 * editing is deliberately kept out of this card so path planning never has
 * to infer a local layout from a remote link.
 *
 * v0.2.9 布局：原"根目录卡片平铺"改为子页侧边栏模式——左侧根目录列表
 * （状态点 + 名称，动态增删、点击切换），右侧仅渲染选中根目录的编辑器。
 * 根目录增多时不再纵向堆叠拉长整页。
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
import { Input, Toggle } from './common/Input';
import { useToast } from './common/Toast';
import { useConfig } from '../hooks/useConfig';
import { useSettingsForm } from '../hooks/settingsDraft';
import { getMappingIndex } from '../api/client';
import { normalizeFeishuUrl, extractWikiRootId } from '../utils/feishu-url';
import { appLogger } from '../utils/appLogger';
import type {
  IndexSnapshot,
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

function createEmptyRoot(): WatchedRootConfig {
  return {
    id: '',
    url: '',
    localDir: '',
    layoutProfile: 'mirror-title-file',
    enabled: true,
  };
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

function rowStatusMeta(row: RootRow) {
  if (!row.root.enabled) {
    return { icon: CloudOff, label: '已停用', dotCls: 'bg-ink-faint/40', iconCls: 'text-ink-faint' };
  }
  if (row.status !== 'pending') return STATUS_META[row.status];
  return { icon: Circle, label: '尚未检测', dotCls: 'bg-ink-faint/40', iconCls: 'text-ink-faint' };
}

function rowDisplayName(row: RootRow): string {
  return (
    row.watchedRoot?.displayName
    || row.watchedRoot?.title
    || row.root.localDir
    || '新的同步根目录'
  );
}

export function WatchedRootsCard() {
  const { config } = useConfig();
  const toast = useToast();
  const [localRoots, setLocalRoots] = useState<WatchedRootConfig[]>([]);
  const [snapshot, setSnapshot] = useState<IndexSnapshot | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  // 子页侧边栏：当前选中的根目录下标（增删后钳位）。
  const [selectedIndex, setSelectedIndex] = useState(0);
  const configuredRoots = config?.watchedRoots;

  useEffect(() => {
    if (configuredRoots) {
      const roots = configuredRoots;
      setLocalRoots(roots.length > 0 ? roots : [createEmptyRoot()]);
      setSelectedIndex(0);
    }
  }, [configuredRoots]);

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

  // 增删后选中下标钳位到有效范围。
  const clampedSelectedIndex = Math.min(
    Math.max(0, selectedIndex),
    Math.max(0, rows.length - 1),
  );
  const selectedRow = rows[clampedSelectedIndex] ?? null;

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

  const addRoot = () => {
    setLocalRoots((previous) => {
      const next = [...previous, createEmptyRoot()];
      // 新增后立即选中它，右侧直接进入编辑。
      setSelectedIndex(next.length - 1);
      return next;
    });
  };

  const removeRoot = (index: number) => {
    setLocalRoots((previous) => {
      const next = previous.filter((_, currentIndex) => currentIndex !== index);
      return next.length > 0 ? next : [createEmptyRoot()];
    });
    // 删除后选中位置前移一项；越界由 clampedSelectedIndex 兜底钳位。
    setSelectedIndex((current) => (current >= index ? Math.max(0, current - 1) : current));
  };

  const handleBlur = (index: number, value: string) => {
    if (!value.trim()) return;
    const { canonical, wasModified, isValid } = normalizeFeishuUrl(value);
    if (wasModified && isValid) {
      updateRoot(index, { url: canonical });
      toast.push({ type: 'info', message: 'URL 已规范化', hint: canonical });
    }
  };

  useSettingsForm('kb-roots', () => {
    const draftRoots = localRoots.filter((root) => root.url.trim() || root.localDir.trim());
    if (!config || JSON.stringify(draftRoots) === JSON.stringify(config.watchedRoots ?? [])) return null;
    const normalizedRoots: WatchedRootConfig[] = [];
    const ids = new Set<string>();

    for (const root of draftRoots) {
      const normalizedUrl = normalizeFeishuUrl(root.url);
      const id = normalizedUrl.isValid ? extractWikiRootId(normalizedUrl.canonical) : null;
      const localDir = root.localDir.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
      if (!id) {
        throw new Error('同步根目录：存在无效的飞书根 URL，必须是 https://<租户>.feishu.cn/wiki/<token>');
      }
      if (localDir && (localDir.startsWith('/') || /^[A-Za-z]:\//.test(localDir) || localDir.split('/').some(
        (segment) => !segment || segment === '.' || segment === '..' || segment.endsWith('.'),
      ))) {
        throw new Error('同步根目录：本地目录必须是知识库根目录下的相对路径');
      }
      if (ids.has(id)) {
        throw new Error('同步根目录：同一个飞书根目录不能重复配置');
      }
      ids.add(id);
      normalizedRoots.push({
        id,
        url: normalizedUrl.canonical,
        localDir,
        layoutProfile: 'mirror-title-file',
        enabled: root.enabled,
      });
    }

    return { watchedRoots: normalizedRoots };
  });

  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Database className="w-4 h-4 text-seal" />
          <h2 className="text-base font-kai font-medium text-ink">同步根目录</h2>
          <span className="ml-auto text-xs text-ink-faint font-sans-ui">
            {summary.total} 个 · {summary.synced} 已同步 · {summary.missing} 待检测
            {summary.disabled > 0 && ` · ${summary.disabled} 已停用`}
            {summary.errored > 0 && ` · ${summary.errored} 错误`}
          </span>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-xs text-ink-faint font-sans-ui">
          每个同步根目录声明飞书根节点与本地对应目录（目录布局固定为镜像标题文件）。停用后会保留历史映射与状态，但不会参与检测、轮询或同步。
        </p>

        {/* 子页侧边栏模式：左根目录列表（动态增删）+ 右选中项编辑器 */}
        <div className="flex flex-col gap-3 xl:flex-row">
          {/* Left: root list sidebar */}
          <aside
            className="flex w-full shrink-0 self-start flex-col xl:w-44 rounded-md border border-line bg-paper-2/60 p-2"
            aria-label="同步根目录列表"
          >
            <div className="flex items-center justify-between px-2 py-1.5 text-xs font-medium text-ink-faint">
              <span>{rows.length} 个根目录</span>
              <button
                type="button"
                onClick={() => void fetchSnapshot()}
                title="从 _index.json 重新读取状态"
                className="rounded-sm p-1 text-ink-faint transition-colors hover:bg-paper hover:text-seal disabled:opacity-50"
                disabled={loadingSnapshot}
              >
                <RefreshCw className={`w-3 h-3 ${loadingSnapshot ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <nav className="flex flex-1 flex-col gap-1 overflow-y-auto scrollbar-thin">
              {rows.map((row, index) => {
                const meta = rowStatusMeta(row);
                const selected = index === clampedSelectedIndex;
                return (
                  <button
                    key={`${row.root.id || 'new'}-${index}`}
                    type="button"
                    onClick={() => setSelectedIndex(index)}
                    aria-current={selected ? 'true' : undefined}
                    title={row.root.url || '未填写 URL'}
                    className={`flex items-center gap-2 rounded px-2.5 py-2 text-left text-sm transition-colors ${
                      selected
                        ? 'bg-card-bg text-seal shadow-sm'
                        : 'text-ink-soft hover:bg-paper hover:text-ink'
                    }`}
                  >
                    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${meta.dotCls}`} />
                    <span className="min-w-0 flex-1 truncate" style={{ fontFamily: 'var(--kai)' }}>
                      {rowDisplayName(row)}
                    </span>
                    {!row.root.enabled && (
                      <CloudOff className="w-3 h-3 shrink-0 text-ink-faint" />
                    )}
                  </button>
                );
              })}
            </nav>

            <div className="mt-1 border-t border-line/60 pt-1.5">
              <button
                type="button"
                onClick={addRoot}
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-xs text-seal transition-colors hover:bg-seal/5 font-sans-ui"
              >
                <Plus className="w-3.5 h-3.5 shrink-0" />
                添加同步根目录
              </button>
            </div>
          </aside>

          {/* Right: selected root editor */}
          <div className="min-w-0 flex-1">
            {selectedRow ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  {(() => {
                    const meta = rowStatusMeta(selectedRow);
                    const StatusIcon = meta.icon;
                    const watchedRoot = selectedRow.watchedRoot;
                    return (
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-ink" style={{ fontFamily: 'var(--kai)' }}>
                            {rowDisplayName(selectedRow)}
                          </span>
                          <span className={`inline-flex items-center gap-1 text-[11px] font-sans-ui ${meta.iconCls}`}>
                            <StatusIcon className="w-3 h-3" />
                            {meta.label}
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
                        {selectedRow.root.id && (
                          <p className="mt-1 text-[11px] text-ink-faint font-mono">根节点：{selectedRow.root.id}</p>
                        )}
                      </div>
                    );
                  })()}
                  <Button
                    variant="ghost"
                    size="md"
                    onClick={() => removeRoot(clampedSelectedIndex)}
                    title="删除此同步根目录"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Input
                    label="飞书根 URL"
                    fullWidth
                    type="url"
                    value={selectedRow.root.url}
                    onChange={(event) => updateRoot(clampedSelectedIndex, { url: event.target.value })}
                    onBlur={(event) => handleBlur(clampedSelectedIndex, event.target.value)}
                    placeholder={DEFAULT_PLACEHOLDER}
                  />
                  <Input
                    label="本地目录（相对知识库根目录）"
                    fullWidth
                    value={selectedRow.root.localDir}
                    onChange={(event) => updateRoot(clampedSelectedIndex, { localDir: event.target.value })}
                    placeholder="留空自动按根节点标题命名，例如：技术 - Dev"
                  />
                  <div className="rounded-md border border-line bg-card-bg px-3 py-2 md:col-span-2">
                    <Toggle
                      label="启用此同步根目录"
                      checked={selectedRow.root.enabled}
                      onChange={(enabled) => updateRoot(clampedSelectedIndex, { enabled })}
                      helperText="停用后不遍历、不检测，也不写入本地文件。"
                    />
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

      </CardBody>
    </Card>
  );
}
