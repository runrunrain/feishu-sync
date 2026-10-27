/**
 * KbTreePanel —— 标准库目录树 + 搜索（KnowledgeView 左栏）
 *
 * 数据：GET /api/kb/tree（KbTreeNode 递归结构，服务端已排好序）。
 * 交互：目录展开/折叠（默认全展开）、文档选中（父级联动高亮）、
 * 搜索（GET /api/kb/search，防抖 300ms，Enter 立即）。
 * 状态：加载骨架 / 未发布（由父级空状态承接，本组件只在有树时渲染）/
 * 搜索空结果（保留树 + 结果区提示）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, Loader2, Search, X } from 'lucide-react';
import { searchKb, APIError } from '../../api/client';
import type { KbSearchResult, KbTreeNode } from '../../types/agent';

interface KbTreePanelProps {
  nodes: KbTreeNode[];
  selectedDocId: string | null;
  onSelectDoc: (docId: string) => void;
  /** 树刷新信号（发布完成后父级递增以重置展开态）。 */
  releaseId: string;
  loading?: boolean;
}

export function KbTreePanel({
  nodes,
  selectedDocId,
  onSelectDoc,
  releaseId,
  loading = false,
}: KbTreePanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KbSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const debounceRef = useRef<number>(0);

  // 发布切换后重置局部状态。
  useEffect(() => {
    setCollapsed(new Set());
    setResults(null);
    setQuery('');
  }, [releaseId]);

  // 防抖搜索：≥2 字符触发；清空即回树。
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    if (q.length < 2) return;
    debounceRef.current = window.setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      searchKb(q)
        .then((data) => setResults(data.results ?? []))
        .catch((err) => {
          setResults([]);
          setSearchError(err instanceof APIError ? err.message : '搜索失败');
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(debounceRef.current);
  }, [query]);

  const renderNode = (node: KbTreeNode, depth: number): React.ReactNode => {
    const isDir = node.type === 'dir';
    const isOpen = !collapsed.has(node.path);
    const selected = !isDir && node.docId === selectedDocId;
    if (isDir) {
      return (
        <div key={node.path}>
          <button
            type="button"
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
            className="w-full flex items-center gap-1 py-1 pr-2 text-left rounded-sm hover:bg-paper transition-colors"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            aria-expanded={isOpen}
          >
            {isOpen ? (
              <ChevronDown className="w-3.5 h-3.5 shrink-0 text-ink-faint" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 shrink-0 text-ink-faint" />
            )}
            <Folder className="w-3.5 h-3.5 shrink-0 text-jade" />
            <span className="truncate text-xs font-medium text-ink-soft">{node.name}</span>
          </button>
          {isOpen && node.children?.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    return (
      <button
        key={node.path}
        type="button"
        onClick={() => node.docId && onSelectDoc(node.docId)}
        className={`w-full flex items-center gap-1.5 py-1 pr-2 text-left rounded-sm transition-colors ${
          selected ? 'bg-[rgba(158,43,37,0.08)] text-seal' : 'hover:bg-paper text-ink-soft'
        }`}
        style={{ paddingLeft: `${8 + depth * 14 + 16}px` }}
        aria-current={selected ? 'true' : undefined}
      >
        <FileText className={`w-3.5 h-3.5 shrink-0 ${selected ? 'text-seal' : 'text-ink-faint'}`} />
        <span className="truncate text-xs">{node.title ?? node.name}</span>
      </button>
    );
  };

  const totalDocs = useMemo(() => {
    let count = 0;
    const walk = (list: KbTreeNode[]) => {
      for (const n of list) {
        if (n.type === 'doc') count += 1;
        if (n.children) walk(n.children);
      }
    };
    walk(nodes);
    return count;
  }, [nodes]);

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-3 border-b border-line/60">
          <div className="h-8 rounded-md bg-paper-2 animate-pulse" />
        </div>
        <div className="p-3 space-y-2" aria-busy="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-4 rounded bg-paper-2 animate-pulse" style={{ width: `${50 + ((i * 13) % 40)}%` }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-3 border-b border-line/60 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标准库文档…"
            className="w-full h-8 pl-8 pr-7 text-xs rounded-md border border-line bg-card-bg text-ink placeholder:text-ink-faint focus:outline-none focus:border-seal/50"
            aria-label="搜索标准库文档"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
              aria-label="清除搜索"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {results !== null ? (
        <div className="flex-1 min-h-0 overflow-auto scrollbar-thin p-2">
          <div className="px-1 pb-2 text-[11px] text-ink-faint">
            {searching ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> 搜索中…
              </span>
            ) : searchError ? (
              <span className="text-seal-2">{searchError}</span>
            ) : results.length > 0 ? (
              `${results.length} 条结果`
            ) : (
              '无匹配文档'
            )}
          </div>
          {results.map((r) => (
            <button
              key={r.docId}
              type="button"
              onClick={() => onSelectDoc(r.docId)}
              className={`w-full text-left px-2 py-1.5 rounded-sm transition-colors ${
                r.docId === selectedDocId ? 'bg-[rgba(158,43,37,0.08)]' : 'hover:bg-paper'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 shrink-0 text-jade" />
                <span className="truncate text-xs font-medium text-ink">{r.title}</span>
              </div>
              <div className="pl-5 text-[11px] text-ink-faint truncate">{r.path}</div>
              {r.snippet ? (
                <div className="pl-5 mt-0.5 text-[11px] text-ink-soft line-clamp-2 leading-snug">{r.snippet}</div>
              ) : null}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto scrollbar-thin py-2" role="tree">
          {nodes.map((n) => renderNode(n, 0))}
          <div className="px-3 pt-3 pb-1 text-[11px] text-ink-faint">共 {totalDocs} 篇文档</div>
        </div>
      )}
    </div>
  );
}
