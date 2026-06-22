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
import { OrphanFileAlert } from '../components/OrphanFileAlert';
import { useConfig } from '../hooks/useConfig';
import { useToast } from '../components/common/Toast';
import {
  getMappingDiff,
  getMappingIndex,
  getMappingTreeDetailed,
} from '../api/client';
import { appLogger } from '../utils/appLogger';
import { pickFirstValidWikiUrl } from '../utils/wikiUrl';
import type {
  MappingNode,
  ChangedDocument,
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

  // diff + snapshot always loaded (shared across views).
  useEffect(() => {
    let cancelled = false;
    if (!rootUrl) return;
    (async () => {
      try {
        const diff: DiffReport = await getMappingDiff(rootUrl);
        if (cancelled) return;
        setChanges([...diff.added, ...diff.modified, ...diff.deleted]);
      } catch (err) {
        // diff may legitimately 400 if rootUrl is invalid; log + soft warning.
        appLogger.warn('dashboard', 'getMappingDiff failed (non-fatal)', err);
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

  const selectedNode = useMemo(
    () => activeNodes.find((n) => n.obj_token === selectedToken) ?? null,
    [activeNodes, selectedToken],
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

  return (
    <div className="space-y-6">
      <GlobalStatusBar />

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        {/* Left: node tree (feishu or local) */}
        <div className="lg:h-[calc(100vh-220px)] min-h-[360px]">
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
              onRefreshed={loadFeishu}
              className="h-full"
            />
          ) : (
            <LocalDirTreeView
              envelope={localEnv ?? undefined}
              selectedToken={selectedToken}
              onSelect={setSelectedToken}
              onRefreshed={loadLocal}
              className="h-full"
            />
          )}
        </div>

        {/* Right: orphan alert + recent + detail */}
        <div className="space-y-5">
          <OrphanFileAlert orphans={orphans} />
          <RecentChanges changes={changes} onJumpToSync={onJumpToSync} />
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
            onOpenFolder={() => {
              if (typeof window !== 'undefined' && window.desktop) {
                window.desktop.openDataDirectory().catch((err) => {
                  appLogger.error('dashboard', 'openDataDirectory failed', err);
                });
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
