/**
 * Dashboard - 总览主区（T2/T11/T12，04 §4.1）
 *
 * 结构：
 *   - 顶部 GlobalStatusBar（认证/上次/下次/立即检测/刷新索引）
 *   - 左 260px：NodeTreeView（飞书视图）或 LocalDirTreeView（本地视图）
 *     + D1 view toggle（伏羲 S1/S5，默认飞书）
 *   - 右 flex：OrphanFileAlert（仅 orphan_files.length>0 渲染）+ RecentChanges
 *     + NodeDetailCard（点击联动，D3 增强）
 *
 * v0.2.0 structure-align Phase D (D1/D2/D3)：
 *   - view 状态由 Dashboard 管理，切换时重新拉对应 API
 *   - 飞书视图：GET /api/mapping/tree?view=feishu → watchedRoots 分组 + filter
 *   - 本地视图：GET /api/mapping/tree?view=local  → LocalDirTreeView 重建目录
 *   - NodeDetailCard.allNodes 传入完整 nodes 数组以解析父节点/子节点
 *
 * P1-1 修复：孤儿数据从 _index.json.orphan_files 拉取，同时驱动：
 *   (a) OrphanFileAlert（T11，主孤儿 UI 入口）
 *   (b) NodeTreeView.orphanPaths（节点树"仅孤儿"过滤器，不再用 local_path 字符串匹配）
 *
 * GlobalStatusBar 内部已处理 B4 修复（立即检测取 watchedRootUrls[0]）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { GlobalStatusBar } from '../components/GlobalStatusBar';
import { NodeTreeView } from '../components/NodeTreeView';
import { LocalDirTreeView } from '../components/LocalDirTreeView';
import { RecentChanges } from '../components/RecentChanges';
import { NodeDetailCard } from '../components/NodeDetailCard';
import { DocPreviewPanel } from '../components/DocPreviewPanel';
import { OrphanFileAlert } from '../components/OrphanFileAlert';
import { QuickAddDocDialog } from '../components/QuickAddDocDialog';
import { useConfig } from '../hooks/useConfig';
import { useToast } from '../components/common/Toast';
import {
  getStoredMappingDiff,
  getMappingIndex,
  getMappingTreeDetailed,
  listCustomFolders,
} from '../api/client';
import { appLogger } from '../utils/appLogger';
import { pickFirstValidWikiUrl } from '../utils/wikiUrl';
import type {
  MappingNode,
  ChangedDocument,
  CustomFolder,
  DiffReport,
  OrphanFile,
  TreeResponse,
  WatchedRoot,
} from '../types';

interface DashboardProps {
  onJumpToSync: () => void;
}

type NodeView = 'feishu' | 'local';

export function Dashboard({ onJumpToSync }: DashboardProps) {
  const { config } = useConfig();
  // Single envelope per view; refreshed on view switch or manual refresh.
  const [view, setView] = useState<NodeView>('feishu');
  const [feishuEnv, setFeishuEnv] = useState<TreeResponse | null>(null);
  const [localEnv, setLocalEnv] = useState<TreeResponse | null>(null);
  const [changes, setChanges] = useState<ChangedDocument[]>([]);
  const [orphans, setOrphans] = useState<OrphanFile[]>([]);
  const [snapshot, setSnapshot] = useState<
    | (Pick<TreeResponse, 'orphan_files'> & {
        watched_roots?: WatchedRoot[];
      })
    | null
  >(null);
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  // 自定义归档文件夹（GET /api/custom-folders）；快捷添加对话框的显隐。
  const [customFolders, setCustomFolders] = useState<CustomFolder[]>([]);
  const [customFoldersLoading, setCustomFoldersLoading] = useState(true);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const toast = useToast();

  // Load diff + snapshot once root URL is ready.
  const rootUrl = pickFirstValidWikiUrl(config?.watchedRootUrls);

  const loadFeishu = useCallback(async () => {
    try {
      const env = await getMappingTreeDetailed('feishu', { includeOrphans: false });
      setFeishuEnv(env);
    } catch (err) {
      appLogger.error('dashboard', 'getMappingTreeDetailed(feishu) failed', err);
      toast.push({
        type: 'error',
        message: '飞书视图加载失败',
        hint: err instanceof Error ? err.message : '',
      });
    }
  }, [toast]);

  const loadLocal = useCallback(async () => {
    try {
      const env = await getMappingTreeDetailed('local', { includeOrphans: true });
      setLocalEnv(env);
    } catch (err) {
      appLogger.error('dashboard', 'getMappingTreeDetailed(local) failed', err);
      toast.push({
        type: 'error',
        message: '本地视图加载失败',
        hint: err instanceof Error ? err.message : '',
      });
    }
  }, [toast]);

  // Load feishu view by default.
  useEffect(() => {
    if (!rootUrl) return;
    void loadFeishu();
  }, [rootUrl, loadFeishu]);

  // Lazy-load local view on first switch (D1).
  useEffect(() => {
    if (view === 'local' && !localEnv && rootUrl) {
      void loadLocal();
    }
  }, [view, localEnv, rootUrl, loadLocal]);

  // 自定义归档文件夹列表：挂载即加载（与 watchedRoot 配置无关，
  // 归档文档 watched_root_url 为 NULL，天然不在结构检测范围内）。
  const loadCustomFolders = useCallback(async () => {
    setCustomFoldersLoading(true);
    try {
      const folders = await listCustomFolders();
      setCustomFolders(folders);
    } catch (err) {
      appLogger.error('dashboard', 'listCustomFolders failed', err);
      toast.push({
        type: 'error',
        message: '自定义归档加载失败',
        hint: err instanceof Error ? err.message : '',
      });
    } finally {
      setCustomFoldersLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadCustomFolders();
  }, [loadCustomFolders]);

  // diff + snapshot always loaded (shared across views).
  useEffect(() => {
    let cancelled = false;
    if (!rootUrl) return;
    (async () => {
      try {
        const diff: DiffReport = await getStoredMappingDiff(rootUrl);
        if (cancelled) return;
        setChanges([...diff.added, ...diff.modified, ...diff.deleted]);
      } catch (err) {
        // diff may legitimately 400 if rootUrl is invalid; log + soft warning.
        appLogger.warn('dashboard', 'getStoredMappingDiff failed (non-fatal)', err);
      }
      try {
        const snap = await getMappingIndex();
        if (cancelled) return;
        setOrphans(snap?.orphan_files ?? []);
        setSnapshot(snap ?? null);
      } catch (err) {
        // 404 when snapshot not generated yet; soft-log only.
        appLogger.warn('dashboard', 'getMappingIndex failed (non-fatal)', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootUrl]);

  // The active node list depends on the view.
  const activeNodes: MappingNode[] = useMemo(() => {
    if (view === 'local') return localEnv?.nodes ?? [];
    return feishuEnv?.nodes ?? [];
  }, [view, feishuEnv, localEnv]);

  const watchedRoots: WatchedRoot[] = useMemo(
    () => feishuEnv?.watched_roots ?? snapshot?.watched_roots ?? [],
    [feishuEnv, snapshot],
  );

  // 自定义归档文档 → 伪 MappingNode，用于点击归档文档时联动详情卡。
  // 归档文档不在飞书结构树内（watched_root_url 为 NULL），不进 NodeTreeView
  // 的 nodes 数组，仅作详情卡解析用；字段按 documents 表约定填充
  // （sync_state/cloud_match/status 均为 synced）。
  const customDocNodes: MappingNode[] = useMemo(
    () =>
      customFolders.flatMap((f) =>
        f.docs.map((d) => ({
          obj_token: d.objToken,
          wiki_node_token: null,
          space_id: null,
          obj_type: (d.objType as MappingNode['obj_type']) || 'unknown',
          title: d.title,
          local_path: d.localRelPath,
          parent_node_token: null,
          has_child: false,
          obj_edit_time: null,
          last_synced_modify_time: '',
          last_synced_at: '',
          last_seen_at: null,
          status: 'synced' as const,
          cloud_deleted: 0,
          sortOrder: null,
          original_link: d.originalLink,
          cloud_match: 'synced' as const,
          watched_root_url: null,
        })),
      ),
    [customFolders],
  );

  const selectedNode = useMemo(
    () =>
      activeNodes.find((n) => n.obj_token === selectedToken) ??
      customDocNodes.find((n) => n.obj_token === selectedToken) ??
      null,
    [activeNodes, customDocNodes, selectedToken],
  );

  // Build a set of orphan local paths to drive NodeTreeView's "仅孤儿" filter.
  const orphanPaths = useMemo(() => new Set(orphans.map((o) => o.path)), [orphans]);

  // Best-effort business marks: parse from title using (X) pattern at end.
  const businessMarksByToken = useMemo(() => {
    const map: Record<string, string[]> = {};
    const re = /(?:[（(]([TDRTDRTDR]+)[）)])\s*$/;
    for (const n of activeNodes) {
      const m = n.title.match(re);
      if (m) {
        map[n.obj_token] = m[1].toUpperCase().split('');
      }
    }
    return map;
  }, [activeNodes]);

  const handleViewChange = (next: NodeView) => {
    if (next === view) return;
    setView(next);
    // Reset selection when switching views so the detail card doesn't show
    // a stale node that may not exist in the other view.
    setSelectedToken(null);
  };

  const handleOpenFolder = () => {
    if (typeof window !== 'undefined' && window.desktop) {
      window.desktop.openDataDirectory().catch((err) => {
        appLogger.error('dashboard', 'openDataDirectory failed', err);
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <GlobalStatusBar />

      {/*
        v0.2.8 三栏布局（替代原"左树 340px + 右栏纵向堆叠"）：
        - 左栏 300/320px：节点树（飞书/本地），主导航
        - 中栏 flex-1：DocPreviewPanel 文档预览（主内容区，占最大面积）
        - 右栏 320/340px：详情侧栏（孤儿提醒 + 节点详情 + 最近变更）
        lg 及以上三栏等高（100dvh - TopBar56 - main padding32 - 状态条约56 - 间距），
        各栏内部独立滚动；窄屏退化为纵向堆叠。
      */}
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:h-[calc(100dvh-196px)] lg:min-h-[480px] lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)_minmax(0,320px)] xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)_minmax(0,340px)]">
        {/* Left: node tree (feishu or local) */}
        <div className="min-w-0 min-h-[360px] lg:min-h-0 lg:h-full">
          {view === 'feishu' ? (
            <NodeTreeView
              nodes={feishuEnv?.nodes}
              selectedToken={selectedToken}
              onSelect={setSelectedToken}
              businessMarksByToken={businessMarksByToken}
              orphanPaths={orphanPaths}
              view={view}
              onViewChange={handleViewChange}
              watchedRoots={watchedRoots}
              customFolders={customFolders}
              onQuickAdd={() => setQuickAddOpen(true)}
              onRefreshed={loadFeishu}
              className="h-full"
            />
          ) : (
            <LocalDirTreeView
              envelope={localEnv ?? undefined}
              selectedToken={selectedToken}
              onSelect={setSelectedToken}
              onRefreshed={loadLocal}
              view={view}
              onViewChange={handleViewChange}
              className="h-full"
            />
          )}
        </div>

        {/* Center: document preview (primary content area) */}
        <div className="min-w-0 min-h-[420px] lg:min-h-0 lg:h-full">
          <DocPreviewPanel
            node={selectedNode}
            onOpenFolder={handleOpenFolder}
            className="h-full"
          />
        </div>

        {/* Right: detail sidebar (orphan alert + node detail + recent changes) */}
        <div className="min-w-0 space-y-4 lg:min-h-0 lg:h-full lg:overflow-y-auto lg:scrollbar-thin lg:pr-1">
          <OrphanFileAlert orphans={orphans} />
          <NodeDetailCard
            node={selectedNode}
            businessMarks={selectedNode ? businessMarksByToken[selectedNode.obj_token] : undefined}
            allNodes={activeNodes}
            watchedRoots={watchedRoots}
            onSelectNode={setSelectedToken}
            onSyncNode={() => {
              toast.push({
                type: 'info',
                message: '请前往「贰 同步」主区同步该节点',
              });
              onJumpToSync();
            }}
            onOpenFolder={handleOpenFolder}
          />
          <RecentChanges changes={changes} onJumpToSync={onJumpToSync} />
        </div>
      </div>

      <QuickAddDocDialog
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        folders={customFolders}
        foldersLoading={customFoldersLoading}
        onChanged={() => {
          void loadCustomFolders();
          void loadFeishu();
        }}
      />
    </div>
  );
}
