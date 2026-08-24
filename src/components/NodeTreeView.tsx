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
import { Search, Filter, RefreshCw, AlertTriangle, Cloud, ChevronRight, Plus, FolderArchive, Folder, FileText, Table, FileType } from 'lucide-react';
import { Card, CardBody } from './common/Card';
import { TreeNode } from './TreeNode';
import { EmptyState } from './common/EmptyState';
import { TreeViewModeToggle } from './TreeViewModeToggle';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';
import { getMappingTree, reorderMapping } from '../api/client';
import type { CustomFolder, MappingNode, WatchedRoot } from '../types';

type TreeFilter = 'all' | 'changed' | 'error' | 'orphan';

/** 未分类分组的折叠 key（不与任何 watchedRoot.url 冲突）。 */
const UNCLASSIFIED_KEY = '__unclassified__';

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
  /**
   * 自定义归档文件夹（数据源 GET /api/custom-folders，由父组件注入）。
   * 渲染在 watchedRoot 分组下方「自定义归档」区块：每个文件夹可收起/展开
   * （复用 watchedRoot 分组折叠交互），其下渲染文档行，点击 onSelect(objToken)
   * 联动详情卡。
   */
  customFolders?: CustomFolder[];
  /** 提供时在搜索行旁渲染「快捷添加云文档」+ 按钮（由父组件打开对话框）。 */
  onQuickAdd?: () => void;
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

function compareTreeNodes(a: MappingNode, b: MappingNode): number {
  const sa = a.sortOrder;
  const sb = b.sortOrder;
  if (sa != null && sb != null) return sa - sb;
  if (sa != null) return -1;
  if (sb != null) return 1;
  // Fallback: obj_edit_time desc as approximation of Feishu order.
  const ta = a.obj_edit_time ?? 0;
  const tb = b.obj_edit_time ?? 0;
  if (ta !== tb) return tb - ta;
  return a.title.localeCompare(b.title, 'zh-CN');
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
    arr.sort(compareTreeNodes);
    childrenByParent.set(k, arr);
  }
  return { childrenByParent, nodeByToken, nodeByWikiToken };
}

/**
 * A configured watched root can itself have a parent outside the subtree
 * returned by the API. Rendering only `parent_node_token === null` silently
 * hid that entire root and all its descendants. Treat an unavailable parent
 * as a logical root while preserving normal in-subtree hierarchy.
 */
export function findRenderableRoots(nodes: MappingNode[]): MappingNode[] {
  const knownWikiNodeTokens = new Set(
    nodes
      .map((node) => node.wiki_node_token)
      .filter((token): token is string => Boolean(token)),
  );
  return nodes
    .filter((node) => {
      const parentToken = node.parent_node_token;
      return !parentToken || !knownWikiNodeTokens.has(parentToken);
    })
    .sort(compareTreeNodes);
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
  customFolders,
  onQuickAdd,
}: NodeTreeViewProps) {
  const [nodes, setNodes] = useState<MappingNode[]>(nodesProp ?? []);
  const [loading, setLoading] = useState<boolean>(!nodesProp);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TreeFilter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // v0.2.4: watchedRoot 分组（根目录）可收起；key 为 watchedRoot.url。默认展开，点击分组标题切换。
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toast = useToast();
  const dragState = useRef<{ dragged: MappingNode | null }>({ dragged: null });
  // v0.2.9：常驻挂载可见性门控用的根元素引用（见键盘导航 effect）。
  const rootRef = useRef<HTMLDivElement>(null);
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
  const roots = useMemo(() => findRenderableRoots(nodes), [nodes]);

  // Default expand logical roots and any node with changed/error status up to
  // depth 2 so changed nodes are visible.
  useEffect(() => {
    setExpanded((prev) => {
      if (prev.size > 0) return prev; // user already toggled; don't override
      const next = new Set<string>();
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
      // 过滤态（包括仅过滤器、无搜索词）同样记录祖先链（__expand__ 前缀），
      // 供下方 visibleTokens 渲染层级路径；自动展开 effect 仍以 search 非空
      // 为门槛，因此「搜索命中自动展开祖先」的现有行为不变。
      if (q || filter !== 'all') {
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

  // 是否处于过滤态：搜索词非空，或选择了非「全部」过滤器。
  const isFiltering = search.trim() !== '' || filter !== 'all';

  // 可见性集合（renderNode / watchedRoot 分组渲染 / 底部统计行共用的唯一
  // 可见性判定；后续键盘上下键导航也应以此计算可见节点）：
  // - 返回 null：未处于过滤态（search 为空且 filter==='all'），所有节点可见；
  // - 否则为「匹配节点 + 其祖先链」的 obj_token 集合。matchedTokens 中无前缀
  //   条目为匹配节点，`__expand__` 前缀条目为匹配节点的祖先（祖先仅用于
  //   展示层级路径）。不在集合中的节点整行跳过，其子树一并隐藏。
  const visibleTokens = useMemo<Set<string> | null>(() => {
    if (!isFiltering) return null;
    const set = new Set<string>();
    for (const t of matchedTokens) {
      set.add(t.startsWith('__expand__') ? t.slice('__expand__'.length) : t);
    }
    return set;
  }, [isFiltering, matchedTokens]);

  // 过滤态下的匹配节点数（不含祖先链），用于底部统计行。
  const matchCount = useMemo(() => {
    if (!isFiltering) return nodes.length;
    let count = 0;
    for (const t of matchedTokens) {
      if (!t.startsWith('__expand__')) count++;
    }
    return count;
  }, [isFiltering, matchedTokens, nodes.length]);

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
    // 过滤态：不在可见集合（匹配节点 + 祖先链）中的节点整行跳过，
    // 其子树也不再渲染（可见子级过滤见下方 visibleChildren）。
    if (visibleTokens !== null && !visibleTokens.has(node.obj_token)) return null;
    // Feishu parent-child chain uses wiki_node_token as the key:
    // a child's parent_node_token points to the parent's wiki_node_token
    // (NOT obj_token). For local-only nodes (wiki_node_token null), there
    // is no feishu-side parent linkage, so they can only be roots.
    const childKey = node.wiki_node_token ?? null;
    const children = tree.childrenByParent.get(childKey) ?? [];
    // 过滤态下只递归可见子级；非过滤态与原逻辑一致（渲染全部子级）。
    const visibleChildren =
      visibleTokens === null
        ? children
        : children.filter((c) => visibleTokens.has(c.obj_token));
    // 过滤态下以可见子级数决定展开箭头，避免出现「展开后为空」的误导；
    // 非过滤态保持原判定（node.has_child || children.length > 0）。
    const hasChildren =
      visibleTokens === null
        ? node.has_child || children.length > 0
        : visibleChildren.length > 0;
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
          <div>{visibleChildren.map((c) => renderNode(c, level + 1))}</div>
        )}
      </div>
    );
  };

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

  // ------------------------------------------------------------------
  // 键盘上下键导航（v0.2.8）：按渲染顺序前序 DFS 收集「当前可见且已
  // 渲染」的节点行（折叠节点的后代、被 visibleTokens 隐藏的节点都跳过），
  // ArrowUp/ArrowDown 在其中移动选中项，选中变化联动中部预览面板。
  // 自定义归档文档行不在导航序列内（其 DOM 在树之后、数据源不同）。
  // ------------------------------------------------------------------
  const navigableTokens = useMemo(() => {
    const out: string[] = [];
    const isVisible = (n: MappingNode) =>
      visibleTokens === null || visibleTokens.has(n.obj_token);
    const walk = (n: MappingNode) => {
      if (!isVisible(n)) return;
      out.push(n.obj_token);
      if (!expanded.has(n.obj_token)) return;
      const childKey = n.wiki_node_token ?? null;
      const children = tree.childrenByParent.get(childKey) ?? [];
      for (const c of children) walk(c);
    };
    if (groupedRoots) {
      for (const g of groupedRoots.groups) {
        if (collapsedGroups.has(g.watchedRoot.url)) continue;
        for (const r of g.nodes) walk(r);
      }
      if (!collapsedGroups.has(UNCLASSIFIED_KEY)) {
        for (const r of groupedRoots.unclassified) walk(r);
      }
    } else {
      for (const r of roots) walk(r);
    }
    return out;
  }, [groupedRoots, roots, tree, expanded, collapsedGroups, visibleTokens]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      // v0.2.9 常驻挂载门控：主区切换后本组件只是被 hidden（不卸载），
      // 隐藏状态下 offsetParent 为 null，此时不得后台响应方向键。
      if (rootRef.current && rootRef.current.offsetParent === null) return;
      // 输入框 / 下拉框 / 可编辑区域内不劫持方向键。
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (navigableTokens.length === 0) return;
      e.preventDefault();
      const idx = selectedToken ? navigableTokens.indexOf(selectedToken) : -1;
      const nextIdx =
        e.key === 'ArrowDown'
          ? idx < 0
            ? 0
            : Math.min(idx + 1, navigableTokens.length - 1)
          : idx < 0
            ? 0
            : Math.max(idx - 1, 0);
      const token = navigableTokens[nextIdx];
      if (token && token !== selectedToken) {
        onSelect(token);
        // 等选中态渲染后把目标行滚入可视区。
        requestAnimationFrame(() => {
          document
            .querySelector(`[data-node-token="${CSS.escape(token)}"]`)
            ?.scrollIntoView({ block: 'nearest' });
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigableTokens, selectedToken, onSelect]);

  // 自定义归档文档行的类型图标（与 TreeNode 同一映射，视觉一致）。
  const CUSTOM_DOC_ICON: Record<string, typeof FileText> = {
    docx: FileText,
    sheet: Table,
    slides: FileType,
    unknown: FileType,
  };

  // 自定义归档分组：按搜索词过滤文档（与树搜索行为一致）。
  const customQuery = search.trim().toLowerCase();
  const renderCustomArchive = () => {
    if (!customFolders || customFolders.length === 0) return null;
    return (
      <div className="mt-3">
        <div className="px-2 py-1.5 text-[11px] text-ink-faint font-sans-ui border-b border-line/40 flex items-center gap-1.5">
          <FolderArchive className="w-3 h-3 text-ink-faint shrink-0" />
          自定义归档
        </div>
        {customFolders.map((folder) => {
          const groupKey = `custom:${folder.id}`;
          const groupCollapsed = collapsedGroups.has(groupKey);
          const visibleDocs = customQuery
            ? folder.docs.filter((d) => d.title.toLowerCase().includes(customQuery))
            : folder.docs;
          return (
            <div key={folder.id} className="mb-1">
              <div
                role="button"
                tabIndex={0}
                aria-expanded={!groupCollapsed}
                onClick={() => toggleGroup(groupKey)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleGroup(groupKey);
                  }
                }}
                className="px-2 py-1.5 border-b border-line/40 flex items-center gap-2 cursor-pointer select-none hover:bg-paper-2/60"
              >
                <ChevronRight
                  className={`w-3.5 h-3.5 text-ink-faint shrink-0 transition-transform ${groupCollapsed ? '' : 'rotate-90'}`}
                />
                <Folder className="w-4 h-4 text-seal shrink-0" />
                <span
                  className="min-w-0 flex-1 text-sm font-medium text-ink truncate"
                  style={{ fontFamily: 'var(--kai)' }}
                  title={folder.localRelPath}
                >
                  {folder.name}
                </span>
                <span className="ml-auto text-[10px] text-ink-faint font-sans-ui shrink-0">
                  {folder.docs.length} 篇
                </span>
              </div>
              {!groupCollapsed && (
                <div>
                  {visibleDocs.length === 0 ? (
                    <p className="px-8 py-1.5 text-[11px] text-ink-faint font-sans-ui">
                      {customQuery ? '无匹配文档' : '（空文件夹）'}
                    </p>
                  ) : (
                    visibleDocs.map((doc) => {
                      const TypeIcon = CUSTOM_DOC_ICON[doc.objType] ?? FileType;
                      const selected = selectedToken === doc.objToken;
                      return (
                        <div
                          key={doc.objToken}
                          role="treeitem"
                          aria-selected={selected}
                          tabIndex={0}
                          onClick={() => onSelect(doc.objToken)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onSelect(doc.objToken);
                            }
                          }}
                          className={`relative flex min-w-0 items-center gap-2 h-8 overflow-hidden pr-2.5 rounded-sm cursor-pointer transition-colors ${
                            selected ? 'bg-[rgba(158,43,37,0.04)]' : 'hover:bg-paper-2'
                          } focus:outline-none focus-visible:ring-1 focus-visible:ring-seal/50 ${selected ? 'before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 before:bg-seal' : ''}`}
                          style={{ paddingLeft: 16 }}
                        >
                          <TypeIcon className="w-3.5 h-3.5 text-ink-soft shrink-0" />
                          <span
                            className="min-w-0 flex-1 truncate text-[12px] text-ink"
                            style={{ fontFamily: 'var(--serif)' }}
                            title={doc.title}
                          >
                            {doc.title}
                          </span>
                          <a
                            href={doc.originalLink}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            aria-label="在飞书中打开"
                            className="shrink-0 text-[10px] text-ink-faint hover:text-seal font-sans-ui"
                          >
                            原文
                          </a>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // ----- Loading / error / empty states -----
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
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
  } else if (roots.length === 0 && (!customFolders || customFolders.length === 0)) {
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
    // 过滤态下，「未分类」区块同样只保留可见根节点（无可见节点则整体隐藏）；
    // 非过滤态为 groupedRoots.unclassified 原数组，行为不变。
    const visibleUnclassified =
      groupedRoots === null || visibleTokens === null
        ? (groupedRoots?.unclassified ?? [])
        : groupedRoots.unclassified.filter((r) => visibleTokens.has(r.obj_token));
    body = (
      <>
        <div className="max-h-full overflow-x-hidden overflow-y-auto scrollbar-thin pr-1">
          {isFiltering && matchCount === 0 && (
            <p className="px-2 py-6 text-center text-xs text-ink-faint font-sans-ui">
              无匹配节点
            </p>
          )}
          {groupedRoots ? (
            <>
              {groupedRoots.groups.map((g) => {
                const groupKey = g.watchedRoot.url;
                const groupCollapsed = collapsedGroups.has(groupKey);
                // 过滤态下只保留可见根节点（匹配节点 + 祖先链）；
                // 无任何可见节点的分组整体隐藏，避免空分组误导。
                const visibleGroupNodes =
                  visibleTokens === null
                    ? g.nodes
                    : g.nodes.filter((r) => visibleTokens.has(r.obj_token));
                if (visibleGroupNodes.length === 0) return null;
                return (
                  <div key={groupKey} className="mb-2">
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={!groupCollapsed}
                      onClick={() => toggleGroup(groupKey)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleGroup(groupKey);
                        }
                      }}
                      className="sticky top-0 z-10 min-w-0 bg-card-bg/95 backdrop-blur-sm px-2 py-1.5 border-b border-line/60 flex items-center gap-2 cursor-pointer select-none"
                    >
                      <ChevronRight
                        className={`w-3.5 h-3.5 text-ink-faint shrink-0 transition-transform ${groupCollapsed ? '' : 'rotate-90'}`}
                      />
                      <Cloud className="w-4 h-4 text-seal shrink-0" />
                      <span
                        className="min-w-0 flex-1 text-sm font-medium text-ink truncate"
                        style={{ fontFamily: 'var(--kai)' }}
                        title={g.watchedRoot.url}
                      >
                        {g.watchedRoot.displayName || g.watchedRoot.title || g.watchedRoot.localDir}
                      </span>
                      <span className="ml-auto text-[10px] text-ink-faint font-sans-ui shrink-0">
                        {visibleGroupNodes.length} 项
                      </span>
                    </div>
                    {!groupCollapsed && visibleGroupNodes.map((r) => renderNode(r, 0))}
                  </div>
                );
              })}
              {visibleUnclassified.length > 0 && (
                <div className="mt-3">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={!collapsedGroups.has(UNCLASSIFIED_KEY)}
                    onClick={() => toggleGroup(UNCLASSIFIED_KEY)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleGroup(UNCLASSIFIED_KEY);
                      }
                    }}
                    className="px-2 py-1.5 text-[11px] text-ink-faint font-sans-ui border-b border-line/40 flex items-center gap-1.5 cursor-pointer select-none"
                  >
                    <ChevronRight
                      className={`w-3 h-3 text-ink-faint shrink-0 transition-transform ${collapsedGroups.has(UNCLASSIFIED_KEY) ? '' : 'rotate-90'}`}
                    />
                    未分类（未绑定 watchedRoot）
                  </div>
                  {!collapsedGroups.has(UNCLASSIFIED_KEY) &&
                    visibleUnclassified.map((r) => renderNode(r, 0))}
                </div>
              )}
            </>
          ) : (
            roots.map((r) => renderNode(r, 0))
          )}
          {renderCustomArchive()}
        </div>
        <div className="mt-3 pt-3 border-t border-line text-xs text-ink-faint font-sans-ui flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate">
            {isFiltering
              ? `匹配 ${matchCount} / ${nodes.length} 节点 · ${changedCount} 变更`
              : `${nodes.length} 节点 · ${roots.length} 顶层 · ${changedCount} 变更`}
          </span>
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
          同级拖拽仅调整本地展示顺序 · 不影响飞书结构 · ↑↓ 键切换节点并预览
        </p>
      </>
    );
  }

  return (
    <div ref={rootRef} className="min-h-0 min-w-0 h-full">
      <Card variant="default" className={`min-w-0 flex flex-col ${className}`}>
      {/*
        节点树容器布局重构（2026-06-19）：
        - 搜索栏 px-3 py-2→px-4 py-3，与 Card 内边距一致
        - 搜索栏内部 gap-2→gap-2.5，搜索框与过滤器拉开
        - CardBody flex-1 + overflow，保持节点滚动而不挤压头部
        - v0.2.0 structure-align Phase D (D1)：view toggle 嵌入搜索栏之上
      */}
      {view && onViewChange && (
        <div className="px-4 pt-3 pb-2 border-b border-line">
          <TreeViewModeToggle view={view} onViewChange={onViewChange} />
          <p className="mt-1.5 text-[11px] text-ink-faint font-sans-ui">
            {view === 'feishu'
              ? '按飞书节点结构组织（过滤本地独有文件）'
              : '按本地文件系统路径组织（含本地独有）'}
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div className="flex min-w-0 flex-1 basis-[120px] items-center gap-2 rounded-md border border-line bg-paper px-2.5 py-1.5 focus-within:border-seal">
          <Search className="w-3.5 h-3.5 text-ink-faint" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索节点…"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none font-sans-ui"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Filter className="w-3.5 h-3.5 text-ink-faint" />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as TreeFilter)}
            className="max-w-[72px] text-xs text-ink-soft bg-paper border border-line rounded-md px-2 py-1.5 font-sans-ui focus:outline-none focus:border-seal"
          >
            {(Object.keys(FILTER_LABEL) as TreeFilter[]).map((f) => (
              <option key={f} value={f}>{FILTER_LABEL[f]}</option>
            ))}
          </select>
          {onQuickAdd && (
            <button
              type="button"
              onClick={onQuickAdd}
              aria-label="快捷添加云文档"
              title="快捷添加云文档到自定义归档"
              className="inline-flex items-center gap-1 text-xs text-seal bg-paper border border-seal/40 rounded-md px-2 py-1.5 font-sans-ui hover:bg-seal hover:text-white transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              添加
            </button>
          )}
        </div>
      </div>
      <CardBody className="flex-1 overflow-hidden flex flex-col">{body}</CardBody>
      </Card>
    </div>
  );
}
