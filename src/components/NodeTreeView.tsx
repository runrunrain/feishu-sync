/**
 * NodeTreeView - 节点树视图（T3 R2.2/R2.2bis/R2.5-AC4 P0 核心）
 *
 * 数据源 GET /api/mapping/tree（P2-T7 已有），按 parent_node_token
 * 在前端重建树。
 *
 * 决策5（同级拖拽）：HTML5 DnD。松开后向 POST /api/mapping/reorder
 * 发送该父节点下完整新顺序；跨父拖拽拒绝 + Toast 提示。
 *
 * 决策1：业务标记 [T][D][R] 作为独立小标签展示（不嵌入标题）。
 *
 * 搜索：标题模糊匹配；命中节点高亮 + 自动展开父级路径。
 * 过滤：全部 / 仅变更 / 仅错误 / 仅孤儿（孤儿基于 _index.json.orphan_files，
 *       由父组件通过 orphanPaths prop 注入；详见 P1-1 修复说明）。
 *
 * v0.2.0 structure-align Phase D（D1）：
 *   - 新增 view toggle「飞书视图 / 本地视图」（伏羲 S1 + S5）。
 *   - 飞书视图：按 watchedRoot 分组顶层节点（filter wiki_node_token != null）。
 *     由父组件通过 `watchedRoots` + `nodes`（已经过 server-side filter）注入。
 *   - 本地视图：由父组件改为渲染 LocalDirTreeView（本组件不再兼任）；
 *     `view`/`onViewChange` 由父组件管理，NodeTreeView 仅渲染 toggle + 飞书树体。
 *   - 默认飞书视图（C5）。
 *
 * 向后兼容：未传 view/onViewChange 时退化为单视图（不渲染 toggle），
 *           行为与 P4 完全一致，避免破坏其他调用点。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Filter, RefreshCw, AlertTriangle, Cloud, FolderTree } from 'lucide-react';
import { Card, CardBody } from './common/Card';
import { TreeNode } from './TreeNode';
import { EmptyState } from './common/EmptyState';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';
import { getMappingTree, reorderMapping } from '../api/client';
import type { MappingNode, WatchedRoot } from '../types';

type TreeFilter = 'all' | 'changed' | 'error' | 'orphan';

const FILTER_LABEL: Record<TreeFilter, string> = {
  all: '全部',
  changed: '仅变更',
  error: '仅错误',
  orphan: '仅孤儿',
};

interface NodeTreeViewProps {
  /** Optional parent-supplied nodes (else fetch on mount). */
  nodes?: MappingNode[];
  selectedToken: string | null;
  onSelect: (objToken: string) => void;
  onRefreshed?: () => void;
  /** Business marks keyed by obj_token (e.g. parsed from title or rules). */
  businessMarksByToken?: Record<string, string[]>;
  /**
   * P1-1 fix (谛听): set of local_path strings that are orphans per
   * `_index.json.orphan_files`. The "仅孤儿" filter now matches this set
   * instead of the unreliable `local_path.includes('orphan')` heuristic
   * (MappingNode has no orphan marker field, and `/api/mapping/tree`
   * excludes true orphans because they have no obj_token).
   *
   * When empty, the "仅孤儿" filter renders an empty list (which is
   * accurate: no orphans found). The OrphanFileAlert (T11) is the
   * dedicated UI surface for surfacing orphan_files.
   */
  orphanPaths?: Set<string>;
  /** ClassName override for embedding in narrow layouts. */
  className?: string;
  /**
   * v0.2.0 structure-align Phase D (D1): when provided, the tree renders a
   * 「飞书视图 / 本地视图」toggle at the top. The parent owns the state
   * and swaps NodeTreeView ↔ LocalDirTreeView on change.
   */
  view?: 'feishu' | 'local';
  onViewChange?: (view: 'feishu' | 'local') => void;
  /**
   * v0.2.0 structure-align Phase D (D1): watchedRoots for top-level
   * grouping. When provided, roots without parent_node_token are grouped
   * under their watchedRoot's display_name; when absent, the legacy flat
   * root list is used.
   */
  watchedRoots?: WatchedRoot[];
}

interface TreeBucket {
  // parent_node_token (wiki_node_token form) → children sorted by sortOrder/title.
  // 飞书节点的 parent_node_token 指向父节点的 wiki_node_token（非 obj_token），
  // 因此 childrenByParent 的 key 必须按 parent_node_token 聚合，renderNode
  // 查子节点时也必须用 wiki_node_token 查（而非 obj_token）。
  childrenByParent: Map<string | null, MappingNode[]>;
  // obj_token → node (lookup)。供 DnD / expanded / selectedToken 等
  // 以 obj_token 为标识的查找使用（这些场景不依赖父子关系）。
  nodeByToken: Map<string, MappingNode>;
  // wiki_node_token → node (lookup)。飞书父子链专用索引：
  // parent_node_token 指向的就是父节点的 wiki_node_token。
  // 本地节点（wiki_node_token=null）不入此索引，其父子关系
  // 在飞书视图中无意义（飞书视图 server 已 filter wiki_node_token IS NOT NULL）。
  nodeByWikiToken: Map<string, MappingNode>;
}

function buildTree(nodes: MappingNode[]): TreeBucket {
  const nodeByToken = new Map<string, MappingNode>();
  const nodeByWikiToken = new Map<string, MappingNode>();
  for (const n of nodes) {
    nodeByToken.set(n.obj_token, n);
    if (n.wiki_node_token != null) {
      nodeByWikiToken.set(n.wiki_node_token, n);
    }
  }

  const childrenByParent = new Map<string | null, MappingNode[]>();
  for (const n of nodes) {
    const key = n.parent_node_token ?? null;
    const arr = childrenByParent.get(key) ?? [];
    arr.push(n);
    childrenByParent.set(key, arr);
  }
  // Sort: sortOrder asc (non-null first), fallback by title.
  for (const [k, arr] of childrenByParent) {
    arr.sort((a, b) => {
      const sa = a.sortOrder;
      const sb = b.sortOrder;
      if (sa != null && sb != null) return sa - sb;
      if (sa != null) return -1;
      if (sb != null) return 1;
      // Fallback: obj_edit_time desc as approximation of Feishu order
      const ta = a.obj_edit_time ?? 0;
      const tb = b.obj_edit_time ?? 0;
      if (ta !== tb) return tb - ta;
      return a.title.localeCompare(b.title, 'zh-CN');
    });
    childrenByParent.set(k, arr);
  }
  return { childrenByParent, nodeByToken, nodeByWikiToken };
}

export function NodeTreeView({
  nodes: nodesProp,
  selectedToken,
  onSelect,
  onRefreshed,
  businessMarksByToken,
  orphanPaths,
  className = '',
  view,
  onViewChange,
  watchedRoots,
}: NodeTreeViewProps) {
  const [nodes, setNodes] = useState<MappingNode[]>(nodesProp ?? []);
  const [loading, setLoading] = useState<boolean>(!nodesProp);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TreeFilter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toast = useToast();
  const dragState = useRef<{ dragged: MappingNode | null }>({ dragged: null });
  const [dragOver, setDragOver] = useState<{ objToken: string; position: 'before' | 'after' } | null>(null);
  const [draggingToken, setDraggingToken] = useState<string | null>(null);

  const fetchTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getMappingTree();
      setNodes(data);
      onRefreshed?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载节点树失败';
      setError(msg);
      appLogger.error('node-tree', 'getMappingTree failed', err);
      toast.push({ type: 'error', message: '节点树加载失败', hint: msg });
    } finally {
      setLoading(false);
    }
  }, [toast, onRefreshed]);

  // Initial fetch (only when no props supplied).
  useEffect(() => {
    if (nodesProp === undefined) {
      void fetchTree();
    }
  }, [nodesProp, fetchTree]);

  // Keep nodes synced when parent supplies them.
  useEffect(() => {
    if (nodesProp !== undefined) setNodes(nodesProp);
  }, [nodesProp]);

  const tree = useMemo(() => buildTree(nodes), [nodes]);

  // Default expand root level (parent_node_token null) and any node with
  // changed/error status up to depth 2 so changed nodes are visible.
  useEffect(() => {
    setExpanded((prev) => {
      if (prev.size > 0) return prev; // user already toggled; don't override
      const next = new Set<string>();
      const roots = tree.childrenByParent.get(null) ?? [];
      for (const r of roots) {
        if (r.has_child) next.add(r.obj_token);
      }
      // Also expand parents that contain changed/error children.
      for (const n of nodes) {
        if (n.status === 'changed' || n.status === 'error' || n.cloud_deleted === 1) {
          // expand the immediate parent.
          // parent_node_token is the parent's wiki_node_token (feishu form),
          // so look up via nodeByWikiToken. Fall back to nodeByToken for
          // legacy callers that still pass obj_token as parent identifier.
          let p = n.parent_node_token;
          // walk up two levels max
          let depth = 0;
          while (p && depth < 2) {
            const parent = tree.nodeByWikiToken.get(p) ?? tree.nodeByToken.get(p);
            if (!parent) break;
            // expanded set is keyed by obj_token (see renderNode), so add
            // the parent's obj_token — NOT its wiki_node_token. Earlier code
            // added the raw parent_node_token (wiki form), which never
            // matched expanded.has(node.obj_token) and silently no-op'd.
            next.add(parent.obj_token);
            p = parent.parent_node_token ?? null;
            depth++;
          }
        }
      }
      return next;
    });
  }, [nodes, tree]);

  // Filter + search match set
  const matchedTokens = useMemo(() => {
    const result = new Set<string>();
    const q = search.trim().toLowerCase();
    for (const n of nodes) {
      // Filter
      if (filter === 'changed' && !(n.status === 'changed' || n.cloud_deleted === 1)) continue;
      if (filter === 'error' && n.status !== 'error') continue;
      // P1-1 fix: orphan filter previously matched `local_path.includes('orphan')`
      // or `status === 'placeholder'`, both unreliable. The true source of truth
      // is `_index.json.orphan_files` (surfaced via the OrphanFileAlert component
      // and passed in here as `orphanPaths`). Nodes in the tree generally have a
      // valid obj_token (orphans are excluded from /api/mapping/tree), so this
      // filter is mostly informational; the dedicated OrphanFileAlert is the
      // authoritative UI for listing orphan files.
      if (filter === 'orphan') {
        if (!orphanPaths || orphanPaths.size === 0) continue;
        if (!orphanPaths.has(n.local_path)) continue;
      }
      // Search
      if (q && !n.title.toLowerCase().includes(q)) continue;
      result.add(n.obj_token);
      // Auto-expand ancestor path on search match.
      if (q) {
        let p = n.parent_node_token;
        while (p) {
          // parent_node_token is wiki_node_token form; resolve to the actual
          // parent node to add its obj_token (expanded set is keyed by obj_token).
          const parent = tree.nodeByWikiToken.get(p) ?? tree.nodeByToken.get(p);
          if (!parent) break;
          result.add(`__expand__${parent.obj_token}`);
          p = parent.parent_node_token ?? null;
        }
      }
    }
    return result;
  }, [nodes, filter, search, tree, orphanPaths]);

  useEffect(() => {
    if (search.trim()) {
      const toExpand = new Set<string>();
      for (const t of matchedTokens) {
        if (t.startsWith('__expand__')) toExpand.add(t.slice('__expand__'.length));
      }
      if (toExpand.size > 0) {
        setExpanded((prev) => {
          const next = new Set(prev);
          for (const t of toExpand) next.add(t);
          return next;
        });
      }
    }
  }, [search, matchedTokens]);

  const handleToggle = (objToken: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(objToken)) next.delete(objToken);
      else next.add(objToken);
      return next;
    });
  };

  // ---- Drag handlers (decision 5) ----
  const handleDragStart = (e: React.DragEvent, node: MappingNode) => {
    dragState.current.dragged = node;
    setDraggingToken(node.obj_token);
    e.dataTransfer.effectAllowed = 'move';
    // Required for Firefox to start DnD.
    e.dataTransfer.setData('text/plain', node.obj_token);
  };

  const handleDragOver = (e: React.DragEvent, node: MappingNode) => {
    const dragged = dragState.current.dragged;
    if (!dragged || dragged.obj_token === node.obj_token) return;
    // Same-parent check (decision 5: cross-parent rejected).
    if ((dragged.parent_node_token ?? null) !== (node.parent_node_token ?? null)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // Determine before/after by midpoint.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offset = e.clientY - rect.top;
    const position: 'before' | 'after' = offset < rect.height / 2 ? 'before' : 'after';
    setDragOver({ objToken: node.obj_token, position });
  };

  const handleDragLeave = (_e: React.DragEvent, node: MappingNode) => {
    setDragOver((cur) => (cur?.objToken === node.obj_token ? null : cur));
  };

  const handleDrop = async (e: React.DragEvent, node: MappingNode) => {
    e.preventDefault();
    const dragged = dragState.current.dragged;
    setDragOver(null);
    setDraggingToken(null);
    dragState.current.dragged = null;
    if (!dragged || dragged.obj_token === node.obj_token) return;

    // Decision 5: cross-parent rejected.
    if ((dragged.parent_node_token ?? null) !== (node.parent_node_token ?? null)) {
      toast.push({
        type: 'warning',
        message: '仅支持同级拖拽排序',
        hint: '跨父节点移动与飞书结构绑定，已拒绝',
      });
      return;
    }

    // Compute the new ordering of this sibling set.
    const parent = node.parent_node_token ?? null;
    const siblings = tree.childrenByParent.get(parent) ?? [];
    const ordered = siblings.filter((s) => s.obj_token !== dragged.obj_token);
    const dropIdx = ordered.findIndex((s) => s.obj_token === node.obj_token);
    if (dropIdx < 0) return;
    const insertAt = dragOver?.position === 'after' ? dropIdx + 1 : dropIdx;
    ordered.splice(insertAt, 0, dragged);

    // Optimistic local reorder (immediate UI feedback).
    const reorderedTokens = ordered.map((s) => s.obj_token);
    setNodes((prev) => {
      // Apply sortOrder = index within same-parent group.
      const next = prev.map((n) => {
        if ((n.parent_node_token ?? null) !== parent) return n;
        const idx = reorderedTokens.indexOf(n.obj_token);
        if (idx < 0) return n;
        return { ...n, sortOrder: idx };
      });
      return next;
    });

    try {
      await reorderMapping({
        parent_node_token: parent,
        ordered_obj_tokens: reorderedTokens,
      });
      toast.push({
        type: 'info',
        message: '已调整本地展示顺序',
        hint: '不影响飞书节点结构',
      });
      appLogger.info('node-tree', 'reorder ok', { parent, count: reorderedTokens.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '调整顺序失败';
      appLogger.error('node-tree', 'reorder failed', err);
      toast.push({ type: 'error', message: '调整顺序失败', hint: msg });
      // Rollback by refetching.
      void fetchTree();
    }
  };

  // ---- Recursive render ----
  const renderNode = (node: MappingNode, level: number): React.ReactNode => {
    // Feishu parent-child chain uses wiki_node_token as the key:
    // a child's parent_node_token points to the parent's wiki_node_token
    // (NOT obj_token). For local-only nodes (wiki_node_token null), there
    // is no feishu-side parent linkage, so they can only be roots.
    const childKey = node.wiki_node_token ?? null;
    const children = tree.childrenByParent.get(childKey) ?? [];
    const hasChildren = node.has_child || children.length > 0;
    const isExpanded = expanded.has(node.obj_token);
    const marks = businessMarksByToken?.[node.obj_token];

    return (
      <div key={node.obj_token}>
        <TreeNode
          node={node}
          level={level}
          expanded={isExpanded}
          selected={selectedToken === node.obj_token}
          hasChildren={hasChildren}
          businessMarks={marks}
          onToggle={handleToggle}
          onSelect={onSelect}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          isDragging={draggingToken === node.obj_token}
          isDropTargetBefore={dragOver?.objToken === node.obj_token && dragOver.position === 'before'}
          isDropTargetAfter={dragOver?.objToken === node.obj_token && dragOver.position === 'after'}
        />
        {hasChildren && isExpanded && (
          <div>{children.map((c) => renderNode(c, level + 1))}</div>
        )}
      </div>
    );
  };

  const roots = tree.childrenByParent.get(null) ?? [];

  // v0.2.0 structure-align Phase D (D1): group roots by watchedRoot when
  // watchedRoots are provided. Roots that have a watched_root_url are
  // rendered under their watchedRoot's display_name header; roots without
  // a watched_root_url fall through to an "未分类" group at the end.
  const groupedRoots = useMemo(() => {
    if (!watchedRoots || watchedRoots.length === 0) {
      return null;
    }
    const byUrl = new Map<string, MappingNode[]>();
    const unclassified: MappingNode[] = [];
    for (const r of roots) {
      const url = (r as MappingNode & { watched_root_url?: string | null }).watched_root_url;
      if (url) {
        const arr = byUrl.get(url) ?? [];
        arr.push(r);
        byUrl.set(url, arr);
      } else {
        unclassified.push(r);
      }
    }
    const groups = watchedRoots
      .map((wr) => ({
        watchedRoot: wr,
        nodes: byUrl.get(wr.url) ?? [],
      }))
      .filter((g) => g.nodes.length > 0);
    return { groups, unclassified };
  }, [roots, watchedRoots]);

  // ----- Loading / error / empty states -----
  let body: React.ReactNode;
  if (loading && nodes.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-2 py-10">
        <RefreshCw className="w-6 h-6 text-seal animate-spin" />
        <p className="text-sm text-ink-soft">加载节点树…</p>
      </div>
    );
  } else if (error && nodes.length === 0) {
    body = (
      <EmptyState
        icon={<AlertTriangle className="w-8 h-8 text-seal-2" />}
        title="节点树加载失败"
        description={error}
        action={{ label: '重试', onClick: fetchTree }}
      />
    );
  } else if (roots.length === 0) {
    body = (
      <EmptyState
        icon={<AlertTriangle className="w-8 h-8 text-ink-faint" />}
        title="知识库尚未索引"
        description="请先在设置中配置本地根目录与飞书根 URL，然后点击「刷新索引」。"
      />
    );
  } else {
    const changedCount = nodes.filter(
      (n) => n.status === 'changed' || n.cloud_deleted === 1,
    ).length;
    body = (
      <>
        <div className="max-h-full overflow-auto scrollbar-thin pr-1">
          {groupedRoots ? (
            <>
              {groupedRoots.groups.map((g) => (
                <div key={g.watchedRoot.url} className="mb-2">
                  <div className="sticky top-0 z-10 bg-card-bg/95 backdrop-blur-sm px-2 py-1.5 border-b border-line/60 flex items-center gap-2">
                    <Cloud className="w-3.5 h-3.5 text-seal shrink-0" />
                    <span
                      className="text-xs font-medium text-ink truncate"
                      style={{ fontFamily: 'var(--kai)' }}
                      title={g.watchedRoot.url}
                    >
                      {g.watchedRoot.displayName || g.watchedRoot.title || g.watchedRoot.localDir}
                    </span>
                    <span className="ml-auto text-[10px] text-ink-faint font-sans-ui shrink-0">
                      {g.nodes.length} 项
                    </span>
                  </div>
                  {g.nodes.map((r) => renderNode(r, 0))}
                </div>
              ))}
              {groupedRoots.unclassified.length > 0 && (
                <div className="mt-3">
                  <div className="px-2 py-1.5 text-[11px] text-ink-faint font-sans-ui border-b border-line/40">
                    未分类（未绑定 watchedRoot）
                  </div>
                  {groupedRoots.unclassified.map((r) => renderNode(r, 0))}
                </div>
              )}
            </>
          ) : (
            roots.map((r) => renderNode(r, 0))
          )}
        </div>
        <div className="mt-3 pt-3 border-t border-line text-xs text-ink-faint font-sans-ui flex items-center justify-between">
          <span>{nodes.length} 节点 · {roots.length} 顶层 · {changedCount} 变更</span>
          <button
            type="button"
            onClick={fetchTree}
            className="inline-flex items-center gap-1 text-ink-soft hover:text-seal"
          >
            <RefreshCw className="w-3 h-3" />
            刷新
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-faint font-sans-ui">
          同级拖拽仅调整本地展示顺序 · 不影响飞书结构
        </p>
      </>
    );
  }

  return (
    <Card variant="default" className={`flex flex-col ${className}`}>
      {/*
        节点树容器布局重构（2026-06-19）：
        - 搜索栏 px-3 py-2→px-4 py-3，与 Card 内边距一致
        - 搜索栏内部 gap-2→gap-2.5，搜索框与过滤器拉开
        - CardBody flex-1 + overflow，保持节点滚动而不挤压头部
        - v0.2.0 structure-align Phase D (D1)：view toggle 嵌入搜索栏之上
      */}
      {view && onViewChange && (
        <div className="px-4 pt-3 pb-2 border-b border-line">
          <div
            role="tablist"
            aria-label="节点树视图"
            className="inline-flex items-center rounded-md border border-line bg-paper p-0.5 text-xs font-sans-ui"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === 'feishu'}
              onClick={() => onViewChange('feishu')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[5px] transition-colors ${
                view === 'feishu'
                  ? 'bg-seal text-white shadow-sm'
                  : 'text-ink-soft hover:text-ink'
              }`}
            >
              <Cloud className="w-3.5 h-3.5" />
              飞书视图
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'local'}
              onClick={() => onViewChange('local')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[5px] transition-colors ${
                view === 'local'
                  ? 'bg-seal text-white shadow-sm'
                  : 'text-ink-soft hover:text-ink'
              }`}
            >
              <FolderTree className="w-3.5 h-3.5" />
              本地视图
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-ink-faint font-sans-ui">
            {view === 'feishu'
              ? '按飞书节点结构组织（过滤本地独有文件）'
              : '按本地文件系统路径组织（含本地独有）'}
          </p>
        </div>
      )}
      <div className="px-4 py-3 border-b border-line flex items-center gap-2.5">
        <div className="flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-line bg-paper focus-within:border-seal">
          <Search className="w-3.5 h-3.5 text-ink-faint" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索节点…"
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none font-sans-ui"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Filter className="w-3.5 h-3.5 text-ink-faint" />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as TreeFilter)}
            className="text-xs text-ink-soft bg-paper border border-line rounded-md px-2 py-1.5 font-sans-ui focus:outline-none focus:border-seal"
          >
            {(Object.keys(FILTER_LABEL) as TreeFilter[]).map((f) => (
              <option key={f} value={f}>{FILTER_LABEL[f]}</option>
            ))}
          </select>
        </div>
      </div>
      <CardBody className="flex-1 overflow-hidden flex flex-col">{body}</CardBody>
    </Card>
  );
}
