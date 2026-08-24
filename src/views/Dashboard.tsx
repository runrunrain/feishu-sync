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

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { GlobalStatusBar } from '../components/GlobalStatusBar';
import { NodeTreeView } from '../components/NodeTreeView';
import { LocalDirTreeView } from '../components/LocalDirTreeView';
import { RecentChanges } from '../components/RecentChanges';
import { NodeDetailCard } from '../components/NodeDetailCard';
import { DocPreviewPanel } from '../components/DocPreviewPanel';
import { ColumnResizer } from '../components/ColumnResizer';
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
  TreeNavTarget,
  WatchedRoot,
} from '../types';

interface DashboardProps {
  onJumpToSync: () => void;
}

type NodeView = 'feishu' | 'local';

// v0.2.9 布局偏好：左栏拖拽宽度 / 右栏收起状态，localStorage 持久化。
const DEFAULT_LEFT_WIDTH = 320;
const LEFT_WIDTH_KEY = 'feishu.layout.leftWidth';
const RIGHT_COLLAPSED_KEY = 'feishu.layout.rightCollapsed';

function readLeftWidth(): number {
  try {
    const raw = localStorage.getItem(LEFT_WIDTH_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= 240 && value <= 560
      ? value
      : DEFAULT_LEFT_WIDTH;
  } catch {
    return DEFAULT_LEFT_WIDTH;
  }
}

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
  // 跳转导航请求（快捷添加/归档管理的「跳转查看」）：nonce 变化触发 NodeTreeView 定位。
  const [focusRequest, setFocusRequest] = useState<
    (TreeNavTarget & { nonce: number }) | null
  >(null);
  const navigateTree = (target: TreeNavTarget) => {
    // 自定义归档/分组树均在飞书视图下渲染，导航前确保视图正确。
    if (view !== 'feishu') setView('feishu');
    setFocusRequest({ ...target, nonce: Date.now() });
  };
  const toast = useToast();

  // v0.2.9 布局偏好：左栏可拖拽宽度 + 右栏可收起（localStorage 持久化）。
  const [leftWidth, setLeftWidth] = useState<number>(readLeftWidth);
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(RIGHT_COLLAPSED_KEY);
      // 默认收起（2026-08 需求）：未表达过偏好时收起右栏，把空间让给预览主区；
      // 一旦用户手动展开/收起，仍以 localStorage 偏好为准。
      return raw === null ? true : raw === '1';
    } catch {
      return true;
    }
  });

  // 右栏展开时左/中栏等比例压缩（2026-08 需求）：左栏保持其在「右栏之外
  // 可用宽度」中的占比，而不是右栏宽度全由中部 flex-1 独自吸收。
  // 以行容器实测宽度换算；仅 lg+ 横向布局生效。
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setRowWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // 右栏展开宽度与 xl 断点联动（lg:w-[320px] xl:w-[340px]），用 matchMedia 保持一致。
  const [isXl, setIsXl] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(min-width: 1280px)').matches
      : false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px)');
    const onChange = () => setIsXl(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 布局常量与下方 JSX 类名保持一致：resizer w-3(12) + 中部 ml-1(4) + 右栏 ml-4(16)。
  const RESIZER_AND_GAP = 16;
  const RIGHT_MARGIN = 16;
  const RIGHT_STRIP_W = 36; // 收起态竖条 w-9
  const rightOpenW = isXl ? 340 : 320;
  let effectiveLeftWidth = leftWidth;
  if (!rightCollapsed && rowWidth >= 1024) {
    const closedAvail = rowWidth - RIGHT_STRIP_W - RIGHT_MARGIN - RESIZER_AND_GAP;
    const openAvail = rowWidth - rightOpenW - RIGHT_MARGIN - RESIZER_AND_GAP;
    if (closedAvail > 0 && openAvail > 0) {
      effectiveLeftWidth = Math.max(
        220,
        Math.min(560, Math.round((leftWidth / closedAvail) * openAvail)),
      );
    }
  }

  useEffect(() => {
    try {
      localStorage.setItem(LEFT_WIDTH_KEY, String(leftWidth));
    } catch {
      /* localStorage 不可用时静默降级 */
    }
  }, [leftWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(RIGHT_COLLAPSED_KEY, rightCollapsed ? '1' : '0');
    } catch {
      /* 同上 */
    }
  }, [rightCollapsed]);

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
        v0.2.9 三栏布局增强（在 v0.2.8 三栏基础上）：
        - 左栏宽度可拖拽调整（ColumnResizer，240-560px，双击复位，localStorage 持久化）；
          通过 CSS 变量 --tree-w 驱动，仅 lg 及以上生效，窄屏仍纵向堆叠
        - 右栏可点击收起为 36px 竖条（PanelRightClose/Open，localStorage 持久化），
          把空间让给中部预览主区域
        lg 及以上三栏等高（100dvh - TopBar56 - main padding32 - 状态条约56 - 间距），
        各栏内部独立滚动。
      */}
      <div ref={rowRef} className="flex min-w-0 flex-col gap-4 lg:h-[calc(100dvh-196px)] lg:min-h-[480px] lg:flex-row lg:gap-0">
        {/* Left: node tree (feishu or local) — width adjustable via resizer；
            右栏展开时按等比例压缩后的 effectiveLeftWidth 渲染 */}
        <div
          className="min-w-0 min-h-[360px] lg:min-h-0 lg:h-full lg:shrink-0 lg:w-[var(--tree-w)]"
          style={{ '--tree-w': `${effectiveLeftWidth}px` } as CSSProperties}
        >
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
              focusRequest={focusRequest}
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

        {/* Divider: drag to adjust left/center width ratio */}
        <ColumnResizer
          width={leftWidth}
          defaultWidth={DEFAULT_LEFT_WIDTH}
          onResize={setLeftWidth}
        />

        {/* Center: document preview (primary content area) */}
        <div className="min-w-0 min-h-[420px] lg:min-h-0 lg:h-full lg:ml-1 flex-1">
          <DocPreviewPanel
            node={selectedNode}
            onOpenFolder={handleOpenFolder}
            className="h-full"
          />
        </div>

        {/* Right: collapsible detail sidebar */}
        {rightCollapsed ? (
          <div className="hidden lg:flex lg:ml-4 lg:w-9 lg:shrink-0 flex-col items-center gap-2 rounded-md border border-line bg-card-bg py-2 shadow-sm">
            <button
              type="button"
              onClick={() => setRightCollapsed(false)}
              title="展开详情栏"
              aria-label="展开详情栏"
              className="rounded-sm p-1.5 text-ink-faint transition-colors hover:bg-paper-2 hover:text-seal"
            >
              <PanelRightOpen className="w-4 h-4" />
            </button>
            <span className="text-[10px] text-ink-faint font-sans-ui [writing-mode:vertical-lr] select-none">
              详情
            </span>
          </div>
        ) : (
          <div className="min-w-0 space-y-3 lg:ml-4 lg:min-h-0 lg:h-full lg:w-[320px] lg:shrink-0 lg:overflow-y-auto lg:scrollbar-thin lg:pr-1 xl:w-[340px]">
            <div className="hidden lg:flex justify-end">
              <button
                type="button"
                onClick={() => setRightCollapsed(true)}
                title="收起详情栏"
                aria-label="收起详情栏"
                className="rounded-sm p-1 text-ink-faint transition-colors hover:bg-paper-2 hover:text-seal"
              >
                <PanelRightClose className="w-4 h-4" />
              </button>
            </div>
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
        )}
      </div>

      <QuickAddDocDialog
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        onNavigate={(target) => {
          setQuickAddOpen(false);
          navigateTree(target);
        }}
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
