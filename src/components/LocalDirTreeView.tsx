/**
 * LocalDirTreeView - 本地目录树视图（D2，伏羲 §3.1.4）
 *
 * 数据源：GET /api/mapping/tree?view=local（含 documents 行 + orphan_files）
 *
 * 重建算法：
 *   1. 遍历 documents.local_path（snake_case 后端字段，前端类型沿用）
 *   2. 按 POSIX '/' split，逐段补齐目录节点
 *   3. 最后一段为文件节点（带 docRecord + cloud_match）
 *   4. orphan_files 追加为 local_only 文件节点
 *
 * 视觉（04 §3.2）：
 *   - 目录用 Folder 图标，文件用 FileText
 *   - cloud_match 徽章颜色：synced=jade / restricted=seal / unknown=ink-faint / local_only=ink-faint
 *   - 折叠/展开、搜索、联动 onSelect（选中后由父组件驱动 NodeDetailCard）
 *
 * 设计决策：
 *   - 树重建在前端做（不依赖 server 端 localDirs 表），降低后端依赖
 *   - orphan_files 与 documents 行混合在同一棵树中（按路径自然落位）
 *   - cloud_match='local_only' 文件用 FileQuestion 图标，与 synced 区分
 */

import { useMemo, useState, useEffect, useCallback } from 'react';
import {
  Folder,
  FolderOpen,
  FileText,
  FileQuestion,
  ChevronRight,
  RefreshCw,
  AlertTriangle,
  Search,
} from 'lucide-react';
import { Card, CardBody } from './common/Card';
import { EmptyState } from './common/EmptyState';
import { TreeViewModeToggle, type TreeViewMode } from './TreeViewModeToggle';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';
import { getMappingTreeDetailed } from '../api/client';
import type { LocalDirTreeNode, MappingNode, OrphanFile, TreeResponse } from '../types';

interface LocalDirTreeViewProps {
  /** Optional pre-fetched envelope. When undefined the component fetches. */
  envelope?: TreeResponse;
  /** Pre-fetched nodes (alternative to envelope). */
  nodes?: MappingNode[];
  /** Pre-fetched orphans (alternative to envelope). */
  orphans?: OrphanFile[];
  /** Selected obj_token (file node). */
  selectedToken: string | null;
  /** Fired when a file node is clicked; parent shows NodeDetailCard. */
  onSelect: (objToken: string) => void;
  /** Notify parent after a successful refresh. */
  onRefreshed?: () => void;
  /** Dashboard-owned selector; shown here too so local mode is not a dead end. */
  view?: TreeViewMode;
  onViewChange?: (view: TreeViewMode) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Tree rebuild (伏羲 §3.1.4)
// ---------------------------------------------------------------------------

const SEP = '/';

/**
 * Split a POSIX-style relative path into segments, ignoring empty parts.
 * We accept both '/' and Windows '\' (defensive; the server normalises
 * to POSIX but historical rows may have backslashes).
 */
function splitPath(path: string): string[] {
  if (!path) return [];
  return path.replace(/\\/g, SEP).split(SEP).filter(Boolean);
}

/**
 * Build a LocalDirTreeNode forest from documents + orphans.
 *
 * Roots are the first path segment (top-level directory). watched_root_url
 * is propagated to children for grouping/filtering by watchedRoot.
 */
function buildLocalTree(
  docs: MappingNode[],
  orphans: OrphanFile[],
): LocalDirTreeNode[] {
  const root: LocalDirTreeNode = { type: 'dir', name: '', path: '', children: [] };
  const dirMap = new Map<string, LocalDirTreeNode>();
  dirMap.set('', root);

  const ensureDir = (segments: string[], watchedRootUrl: string | null): LocalDirTreeNode => {
    let currentPath = '';
    let parent = root;
    for (const seg of segments) {
      currentPath = currentPath ? `${currentPath}${SEP}${seg}` : seg;
      let dir = dirMap.get(currentPath);
      if (!dir) {
        dir = {
          type: 'dir',
          name: seg,
          path: currentPath,
          children: [],
          watched_root_url: watchedRootUrl,
        };
        parent.children!.push(dir);
        dirMap.set(currentPath, dir);
      }
      parent = dir;
    }
    return parent;
  };

  // 1. documents rows
  for (const doc of docs) {
    if (!doc.local_path) continue;
    const segments = splitPath(doc.local_path);
    if (segments.length === 0) continue;
    const dirSegments = segments.slice(0, -1);
    const fileName = segments[segments.length - 1];
    const parent = ensureDir(dirSegments, doc.watched_root_url ?? null);
    // Avoid duplicate file entries (same path) — last one wins.
    const existingIdx = parent.children!.findIndex(
      (c) => c.type === 'file' && c.path === doc.local_path,
    );
    const fileNode: LocalDirTreeNode = {
      type: 'file',
      name: fileName,
      path: doc.local_path,
      docRecord: doc,
      cloud_match: doc.cloud_match,
      original_link: doc.original_link,
      watched_root_url: doc.watched_root_url ?? null,
      is_orphan: false,
    };
    if (existingIdx >= 0) parent.children![existingIdx] = fileNode;
    else parent.children!.push(fileNode);
  }

  // 2. orphan_files
  for (const orphan of orphans) {
    if (!orphan.path) continue;
    const segments = splitPath(orphan.path);
    if (segments.length === 0) continue;
    const dirSegments = segments.slice(0, -1);
    const fileName = segments[segments.length - 1];
    const parent = ensureDir(dirSegments, null);
    if (parent.children!.some((c) => c.type === 'file' && c.path === orphan.path)) continue;
    parent.children!.push({
      type: 'file',
      name: fileName,
      path: orphan.path,
      cloud_match: orphan.cloud_match === 'unknown' ? 'unknown' : 'local_only',
      is_orphan: true,
    });
  }

  // Sort: dirs first, then files; alphabetical within group (zh-CN locale).
  const sortRecursive = (node: LocalDirTreeNode) => {
    if (!node.children || node.children.length === 0) return;
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    for (const c of node.children) sortRecursive(c);
  };
  sortRecursive(root);

  return root.children ?? [];
}

// ---------------------------------------------------------------------------
// Sub-tree renderer (recursive)
// ---------------------------------------------------------------------------

interface RenderNodeProps {
  node: LocalDirTreeNode;
  level: number;
  expanded: Set<string>;
  matched: Set<string>;
  selectedToken: string | null;
  onToggle: (path: string) => void;
  onSelect: (objToken: string) => void;
}

function fileIconFor(node: LocalDirTreeNode) {
  if (node.is_orphan || node.cloud_match === 'local_only') return FileQuestion;
  return FileText;
}

function cloudMatchLabel(cm?: LocalDirTreeNode['cloud_match']): {
  text: string;
  cls: string;
} | null {
  if (!cm) return null;
  switch (cm) {
    case 'synced':
      return { text: '已对应', cls: 'bg-jade/10 text-jade' };
    case 'restricted':
      return { text: '受限', cls: 'bg-seal/10 text-seal' };
    case 'local_only':
      return { text: '本地独有', cls: 'bg-ink-faint/10 text-ink-faint' };
    case 'unknown':
    default:
      return { text: '未分类', cls: 'bg-ink-faint/10 text-ink-faint' };
  }
}

function LocalNodeRenderer({
  node,
  level,
  expanded,
  matched,
  selectedToken,
  onToggle,
  onSelect,
}: RenderNodeProps) {
  const isDir = node.type === 'dir';
  const isExpanded = expanded.has(node.path);
  const isMatched = matched.size === 0 || matched.has(node.path);
  if (!isMatched) return null;

  // Auto-expand dirs that contain matched descendants when searching.
  const childMatched = (n: LocalDirTreeNode): boolean => {
    if (matched.has(n.path)) return true;
    return (n.children ?? []).some(childMatched);
  };

  const Icon = isDir ? (isExpanded ? FolderOpen : Folder) : fileIconFor(node);
  const cmLabel = !isDir ? cloudMatchLabel(node.cloud_match) : null;
  const doc = node.docRecord;

  // For directories: only render if not filtered out.
  if (isDir && matched.size > 0 && !childMatched(node)) return null;

  return (
    <div>
      <div
        role="treeitem"
        aria-expanded={isDir ? isExpanded : undefined}
        aria-selected={!isDir && doc ? selectedToken === doc.obj_token : undefined}
        className={`relative group flex min-w-0 items-center gap-2 h-8 overflow-hidden pr-2.5 rounded-sm cursor-pointer transition-colors ${
          !isDir && doc && selectedToken === doc.obj_token
            ? 'bg-[rgba(158,43,37,0.04)] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 before:bg-seal'
            : 'hover:bg-paper-2'
        }`}
        style={{ paddingLeft: Math.min(8 + level * 10, 48) }}
        onClick={() => {
          if (isDir) onToggle(node.path);
          else if (doc) onSelect(doc.obj_token);
        }}
      >
        {/* Expand arrow (dirs only) */}
        <span className="shrink-0 w-3.5">
          {isDir ? (
            <ChevronRight
              className={`w-3.5 h-3.5 text-ink-faint transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            />
          ) : null}
        </span>
        <Icon className={`w-4 h-4 shrink-0 ${isDir ? 'text-ink-soft' : 'text-ink-soft'}`} />
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${
            doc?.cloud_deleted === 1 ? 'text-ink-faint line-through' : 'text-ink'
          }`}
          style={{ fontFamily: 'var(--serif)' }}
          title={node.path}
        >
          {node.name}
        </span>
        {cmLabel && (
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-sans-ui ${cmLabel.cls}`}
          >
            {cmLabel.text}
          </span>
        )}
        {!isDir && doc?.status === 'changed' && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-sans-ui bg-seal/10 text-seal">
            变更
          </span>
        )}
      </div>
      {isDir && isExpanded && node.children && node.children.length > 0 && (
        <div>
          {node.children.map((c) => (
            <LocalNodeRenderer
              key={c.path}
              node={c}
              level={level + 1}
              expanded={expanded}
              matched={matched}
              selectedToken={selectedToken}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LocalDirTreeView({
  envelope,
  nodes,
  orphans,
  selectedToken,
  onSelect,
  onRefreshed,
  view,
  onViewChange,
  className = '',
}: LocalDirTreeViewProps) {
  const [internalEnv, setInternalEnv] = useState<TreeResponse | null>(envelope ?? null);
  const [loading, setLoading] = useState<boolean>(!envelope && !nodes);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toast = useToast();

  const fetchTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getMappingTreeDetailed('local', { includeOrphans: true });
      setInternalEnv(data);
      onRefreshed?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载本地视图失败';
      setError(msg);
      appLogger.error('local-tree', 'getMappingTreeDetailed(local) failed', err);
      toast.push({ type: 'error', message: '本地视图加载失败', hint: msg });
    } finally {
      setLoading(false);
    }
  }, [toast, onRefreshed]);

  useEffect(() => {
    if (envelope) {
      setInternalEnv(envelope);
      setLoading(false);
    } else if (!nodes) {
      void fetchTree();
    } else {
      // Synthesise an envelope from props (legacy callers).
      setInternalEnv({
        view: 'local',
        nodes,
        watched_roots: [],
        orphan_files: orphans ?? [],
        stats: {
          total_nodes: nodes.length,
          watched_root_count: 0,
          cloud_match_distribution: {},
        },
      });
      setLoading(false);
    }
  }, [envelope, nodes, orphans, fetchTree]);

  // Build the forest whenever the data source changes.
  const forest = useMemo(() => {
    if (!internalEnv) return [];
    return buildLocalTree(internalEnv.nodes, internalEnv.orphan_files);
  }, [internalEnv]);

  // Default-expand the first two levels so users see structure immediately.
  useEffect(() => {
    setExpanded((prev) => {
      if (prev.size > 0) return prev;
      const next = new Set<string>();
      const walk = (nodes: LocalDirTreeNode[], depth: number) => {
        for (const n of nodes) {
          if (n.type === 'dir' && depth < 2) {
            next.add(n.path);
            if (n.children) walk(n.children, depth + 1);
          }
        }
      };
      walk(forest, 0);
      return next;
    });
  }, [forest]);

  // Search match set — empty means "all match".
  const matched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return new Set<string>();
    const result = new Set<string>();
    const walk = (n: LocalDirTreeNode) => {
      const hit = n.name.toLowerCase().includes(q);
      if (hit) {
        // mark this node + all ancestors (so ancestors render)
        result.add(n.path);
      }
      if (n.children) for (const c of n.children) walk(c);
    };
    for (const r of forest) walk(r);
    // Expand ancestors of matched nodes.
    const toExpand = new Set<string>();
    for (const path of result) {
      const segs = path.split(SEP);
      let cur = '';
      for (let i = 0; i < segs.length - 1; i++) {
        cur = cur ? `${cur}${SEP}${segs[i]}` : segs[i];
        toExpand.add(cur);
      }
    }
    if (toExpand.size > 0) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const p of toExpand) next.add(p);
        return next;
      });
    }
    return result;
  }, [search, forest]);

  const handleToggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // ----- Loading / error / empty states -----
  let body: React.ReactNode;
  const fileCount = internalEnv?.nodes.length ?? 0;
  const orphanCount = internalEnv?.orphan_files.length ?? 0;

  if (loading && !internalEnv) {
    body = (
      <div className="flex flex-col items-center gap-2 py-10">
        <RefreshCw className="w-6 h-6 text-seal animate-spin" />
        <p className="text-sm text-ink-soft">加载本地视图…</p>
      </div>
    );
  } else if (error && !internalEnv) {
    body = (
      <EmptyState
        icon={<AlertTriangle className="w-8 h-8 text-seal-2" />}
        title="本地视图加载失败"
        description={error}
        action={{ label: '重试', onClick: fetchTree }}
      />
    );
  } else if (forest.length === 0) {
    body = (
      <EmptyState
        icon={<AlertTriangle className="w-8 h-8 text-ink-faint" />}
        title="本地尚未索引"
        description="请先在「设置」中配置本地根目录与飞书根 URL，然后点击「刷新索引」。"
      />
    );
  } else {
    body = (
      <>
        <div className="max-h-full overflow-x-hidden overflow-y-auto scrollbar-thin pr-1">
          {forest.map((r) => (
            <LocalNodeRenderer
              key={r.path}
              node={r}
              level={0}
              expanded={expanded}
              matched={matched}
              selectedToken={selectedToken}
              onToggle={handleToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
        <div className="mt-3 pt-3 border-t border-line text-xs text-ink-faint font-sans-ui flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate">
            {fileCount} 文档 · {orphanCount} 本地独有 · {forest.length} 顶层
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
          本地视图按 local_md_path 重建 · 含 csv-data / images / attachments 子目录
        </p>
      </>
    );
  }

  return (
    <Card variant="default" className={`min-w-0 flex flex-col ${className}`}>
      {view && onViewChange && (
        <div className="px-4 pt-3 pb-2 border-b border-line">
          <TreeViewModeToggle view={view} onViewChange={onViewChange} />
          <p className="mt-1.5 text-[11px] text-ink-faint font-sans-ui">
            按本地文件系统路径组织（含本地独有）
          </p>
        </div>
      )}
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-paper px-2.5 py-1.5 focus-within:border-seal">
          <Search className="w-3.5 h-3.5 text-ink-faint" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索本地路径…"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none font-sans-ui"
          />
        </div>
      </div>
      <CardBody className="flex-1 overflow-hidden flex flex-col">{body}</CardBody>
    </Card>
  );
}
