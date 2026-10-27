import { useEffect, useMemo, useRef, useState } from 'react';
import { getKbSourceTree, setKbSourcesSelection } from '../../api/client';
import type { KbSourceChoice, KbSourceTreeDto } from '../../types/kb-version';
import { sourceTreeRows, subtreeTokens } from '../../utils/kbSourceTree';
import { Button } from '../common/Button';
const LABEL = { added: '新增', changed: '修改', removed: '待移除', unchanged: '', excluded: '已排除' };
function SelectionBox({ included, total, disabled, title, onChange }: { included: number; total: number; disabled: boolean; title: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = included > 0 && included < total; }, [included, total]);
  return <input ref={ref} type="checkbox" aria-label={`参与构建：${title}`} checked={total > 0 && included === total} disabled={disabled || !total} onChange={onChange} className="accent-[#9e2b25] shrink-0" />;
}
export function KbSourceSelector({ running, nonce, onChanged, onOpenSource }: { running: boolean; nonce: number; onChanged: () => void; onOpenSource: (source: KbSourceChoice) => void }) {
  const [data, setData] = useState<KbSourceTreeDto | null>(null);
  const [q, setQ] = useState(''); const [collapsed, setCollapsed] = useState(new Set<string>());
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [scroll, setScroll] = useState(0); const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => { let disposed = false; setLoading(true); setError('');
    void getKbSourceTree().then((value) => { if (!disposed) setData(value); }).catch((err) => { if (!disposed) setError(String(err.message ?? err)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [nonce]);
  const tree = useMemo(() => sourceTreeRows(data?.nodes ?? [], q, collapsed), [data, q, collapsed]);
  const allStats = useMemo(() => sourceTreeRows(data?.nodes ?? [], '', new Set()).stats, [data]);
  const totalIncluded = (data?.nodes ?? []).reduce((sum, node) => sum + (allStats.get(node.id)?.included ?? 0), 0);
  const disabled = running || busy || loading;
  const change = async (tokens: string[], action: 'include' | 'exclude' | 'invert') => {
    if (!data || !tokens.length || disabled) return;
    setBusy(true); setError('');
    try { await setKbSourcesSelection(data.root, tokens, action); setData(await getKbSourceTree()); onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : '保存失败，请刷新后重试'); }
    finally { setBusy(false); }
  };
  const resetScroll = () => { setScroll(0); if (viewport.current) viewport.current.scrollTop = 0; };
  const start = Math.max(0, Math.floor(scroll / 52) - 8); const end = Math.min(tree.rows.length, start + 45);
  return <div>
    <p className="text-xs text-ink-soft mb-3 leading-relaxed">勾选某个层级会同时选择其全部下级文档。取消后保留原文，已参与构建的来源会在下次「按变更更新」时移除其影响。</p>
    <input aria-label="搜索源文档" placeholder="搜索标题、路径或文档标识" value={q} onChange={(e) => { setQ(e.target.value); resetScroll(); }} className="w-full px-3 py-2 mb-3 rounded border border-line bg-card-bg text-sm" />
    <div className="flex flex-wrap items-center gap-2 mb-2">
      <Button size="sm" variant="secondary" disabled={disabled || !tree.targets.length} onClick={() => void change(tree.targets, 'include')}>全选</Button>
      <Button size="sm" variant="secondary" disabled={disabled || !tree.targets.length} onClick={() => void change(tree.targets, 'exclude')}>取消全选</Button>
      <Button size="sm" variant="secondary" disabled={disabled || !tree.targets.length} onClick={() => void change(tree.targets, 'invert')}>反选</Button>
      <Button size="sm" variant="ghost" onClick={() => { setCollapsed(new Set()); resetScroll(); }}>展开全部</Button>
      <Button size="sm" variant="ghost" onClick={() => { setCollapsed(new Set(tree.all.filter((row) => row.node.children.length).map((row) => row.node.id))); resetScroll(); }}>收起全部</Button>
      <span className="text-xs text-ink-faint ml-auto" aria-live="polite">已选 {totalIncluded} / {data?.total ?? 0} 篇{busy ? ' · 保存中…' : ''}</span>
    </div>
    <p className="text-xs text-ink-faint mb-2">{q ? `批量操作作用于筛选出的 ${tree.targets.length} 篇文档；层级复选框始终包含全部下级。` : '批量操作覆盖全部文档，包括收起的层级。'}</p>
    {error ? <p role="alert" className="text-sm text-seal-2 mb-2">{error}</p> : null}
    {loading && !data ? <p className="py-6 text-sm text-ink-faint">正在读取源文档…</p> : <div ref={viewport} onScroll={(e) => setScroll(e.currentTarget.scrollTop)} className="h-[38vh] min-h-[180px] overflow-auto scrollbar-thin border-y border-line" aria-label="源文档层级">
      <div style={{ height: tree.rows.length * 52, position: 'relative' }}>
        {tree.rows.slice(start, end).map(({ node, depth }, index) => {
          const count = tree.stats.get(node.id)!; const expanded = q.trim() || !collapsed.has(node.id);
          return <div key={node.id} style={{ position: 'absolute', top: (start + index) * 52, height: 52, left: 0, right: 0, paddingLeft: Math.min(depth, 12) * 20 + 4 }} className="flex gap-3 items-center border-b border-line/60 pr-2">
            {node.children.length ? <button className="w-5 shrink-0 text-ink-soft" aria-label={`${expanded ? '收起' : '展开'}：${node.title}`} aria-expanded={Boolean(expanded)} onClick={() => setCollapsed((old) => { const next = new Set(old); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })}>{expanded ? '▾' : '▸'}</button> : <span className="w-5 shrink-0" />}
            <SelectionBox included={count.included} total={count.total} disabled={disabled} title={node.title} onChange={() => void change(subtreeTokens([node]), count.included === count.total ? 'exclude' : 'include')} />
            <div className="flex-1 min-w-0"><span className="block text-sm text-ink truncate" title={node.title}>{node.title}</span>{node.source ? <span className="block text-xs text-ink-faint truncate" title={node.source.relPath}>{node.source.relPath}</span> : <span className="text-xs text-ink-faint">文档层级</span>}</div>
            {node.children.length ? <span className="text-xs text-ink-soft shrink-0">{count.included}/{count.total} 篇</span> : null}
            {node.source ? <><span className="text-xs text-ink-faint shrink-0">{LABEL[node.source.pending]}</span><button className="text-xs text-seal shrink-0" onClick={() => onOpenSource(node.source!)} aria-label={`预览：${node.title}`}>预览</button></> : null}
          </div>;
        })}
      </div>
      {!tree.rows.length ? <p className="py-6 text-sm text-ink-faint">没有匹配的本地源文档。</p> : null}
    </div>}
    {running ? <p className="text-xs text-seal mt-2">构建进行中，源选择暂不可更改。</p> : null}
  </div>;
}
