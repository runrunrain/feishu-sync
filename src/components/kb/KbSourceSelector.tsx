import { useEffect, useMemo, useRef, useState } from 'react';
import { cleanupKbSources, getKbSourceTree, setKbSourcesSelection } from '../../api/client';
import type { KbSourceChoice, KbSourceTreeDto } from '../../types/kb-version';
import { sourceTreeRows, subtreeTokens } from '../../utils/kbSourceTree';
import { Button } from '../common/Button';
import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';
const ROW_HEIGHT = 32;
const LABEL = { added: '新增', changed: '修改', removed: '待移除', unchanged: '', excluded: '已排除' };
function SelectionBox({ included, total, disabled, title, onChange, cleanup = false }: { included: number; total: number; disabled: boolean; title: string; onChange: () => void; cleanup?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = included > 0 && included < total; }, [included, total]);
  return <input ref={ref} type="checkbox" aria-label={`${cleanup ? '选择清理' : '参与构建'}：${title}`} checked={total > 0 && included === total} disabled={disabled || !total} onChange={onChange} className="accent-[#9e2b25] shrink-0" />;
}
export function KbSourceSelector({ running, nonce, onChanged, onOpenSource, canBuild, onBuild }: { running: boolean; nonce: number; onChanged: () => void; onOpenSource: (source: KbSourceChoice) => void; canBuild: boolean; onBuild: (count: number) => void }) {
  const [data, setData] = useState<KbSourceTreeDto | null>(null);
  const [cleanupMode, setCleanupMode] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [confirmation, setConfirmation] = useState<KbSourceChoice[] | null>(null);
  const [notice, setNotice] = useState('');
  const [q, setQ] = useState(''); const [collapsed, setCollapsed] = useState(new Set<string>());
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [scroll, setScroll] = useState(0); const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => { let disposed = false; setLoading(true); setError('');
    void getKbSourceTree().then((value) => { if (!disposed) setData(value); }).catch((err) => { if (!disposed) setError(String(err.message ?? err)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [nonce]);
  const tree = useMemo(() => sourceTreeRows(data?.nodes ?? [], q, collapsed, cleanupMode ? selected : undefined), [data, q, collapsed, cleanupMode, selected]);
  const allStats = useMemo(() => sourceTreeRows(data?.nodes ?? [], '', new Set(), cleanupMode ? selected : undefined).stats, [data, cleanupMode, selected]);
  const totalIncluded = (data?.nodes ?? []).reduce((sum, node) => sum + (allStats.get(node.id)?.included ?? 0), 0);
  const disabled = running || busy || loading;
  const change = async (tokens: string[], action: 'include' | 'exclude' | 'invert') => {
    if (!data || !tokens.length || disabled) return;
    if (cleanupMode) { setSelected((old) => { const next = new Set(old); for (const token of tokens) { if (action === 'include' || (action === 'invert' && !old.has(token))) next.add(token); else next.delete(token); } return next; }); return; }
    setBusy(true); setError('');
    try { await setKbSourcesSelection(data.root, tokens, action); setData(await getKbSourceTree()); onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : '保存失败，请刷新后重试'); }
    finally { setBusy(false); }
  };
  const requestCleanup = (tokens: string[]) => {
    const wanted = new Set(tokens);
    setError(''); setNotice('');
    setConfirmation(tree.all.flatMap(({ node }) => node.source && wanted.has(node.source.objToken) ? [node.source] : []));
  };
  const confirmCleanup = async () => {
    if (!data || !confirmation?.length || disabled) return;
    setBusy(true); setError('');
    try {
      const result = await cleanupKbSources(data.root, confirmation.map(({ objToken, relPath }) => ({ objToken, relPath })));
      setConfirmation(null); setSelected(new Set()); resetScroll();
      setNotice(`已清理 ${result.cleaned} 篇源文档及对应索引。回收位置：${result.trashDir}。正文可从 files 移回原位置后重建索引；表格附件映射可重新同步恢复，原映射保存在 cleanup.json。`);
      onChanged(); setData(await getKbSourceTree());
    } catch (err) { setError(err instanceof Error ? err.message : '清理失败'); }
    finally { setBusy(false); }
  };
  const resetScroll = () => { setScroll(0); if (viewport.current) viewport.current.scrollTop = 0; };
  const start = Math.max(0, Math.floor(scroll / ROW_HEIGHT) - 8); const end = Math.min(tree.rows.length, start + Math.ceil((viewport.current?.clientHeight || 600) / ROW_HEIGHT) + 16);
  if (confirmation) return <div className="h-full overflow-auto scrollbar-thin">
    <h4 className="text-base text-ink mb-3">确认清理 {confirmation.length} 篇源文档</h4>
    <p className="text-sm text-ink-soft leading-relaxed mb-3">将以下本地正文和已登记的表格附件移入原始库的回收目录，并清除对应索引。飞书云端原文保留；下次检测可能重新列为待同步，勾选同步后会下载回来。标准库中的已有内容会在下次「按变更更新」时处理，历史版本保留。</p>
    <div className="max-h-[34vh] overflow-auto border-y border-line mb-4">{confirmation.map((source) => <div key={source.objToken} className="py-2 text-sm text-ink">{source.title}<span className="block text-xs text-ink-faint break-all">{source.relPath}</span></div>)}</div>
    {error ? <p role="alert" className="text-sm text-seal-2 mb-3">{error}</p> : null}
    <div className="flex gap-3 justify-end"><Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmation(null)}>取消清理</Button><Button size="sm" disabled={disabled} onClick={() => void confirmCleanup()}>{busy ? '正在清理…' : '确认移入回收区'}</Button></div>
  </div>;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 max-h-[45%] overflow-y-auto scrollbar-thin">
    {!cleanupMode ? <p className="text-xs text-ink-soft mb-3 leading-relaxed">勾选某个层级会同时选择其全部下级文档。取消后保留原文，已参与构建的来源会在下次「按变更更新」时移除其影响。</p> : null}
    {cleanupMode ? <p role="status" className="text-sm text-seal mb-3">清理选择模式：请勾选要移入回收区的文档，再点击「清理所选」。</p> : null}
    {notice ? <p role="status" className="text-xs text-jade break-all mb-3">{notice}</p> : null}
    <input aria-label="搜索源文档" placeholder="搜索标题、路径或文档标识" value={q} onChange={(e) => { setQ(e.target.value); resetScroll(); }} className="w-full px-3 py-2 mb-3 rounded border border-line bg-card-bg text-sm" />
    <div className="flex flex-wrap items-center gap-2 mb-2">
      <Button size="sm" variant="secondary" disabled={disabled || !tree.targets.length} onClick={() => void change(tree.targets, 'include')}>全选</Button>
      <Button size="sm" variant="secondary" disabled={disabled || !tree.targets.length} onClick={() => void change(tree.targets, 'exclude')}>取消全选</Button>
      <Button size="sm" variant="secondary" disabled={disabled || !tree.targets.length} onClick={() => void change(tree.targets, 'invert')}>反选</Button>
      <Button size="sm" variant="ghost" onClick={() => { setCollapsed(new Set()); resetScroll(); }}>展开全部</Button>
      <Button size="sm" variant="ghost" onClick={() => { setCollapsed(new Set(tree.all.filter((row) => row.node.children.length).map((row) => row.node.id))); resetScroll(); }}>收起全部</Button>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => { setCleanupMode(!cleanupMode); setSelected(new Set()); }}>{cleanupMode ? '退出清理模式' : '选择文档清理'}</Button>
      {cleanupMode ? <Button size="sm" disabled={disabled || !selected.size} onClick={() => requestCleanup([...selected])}>清理所选（{selected.size}）</Button> : null}
      <span className="text-xs text-ink-faint ml-auto" aria-live="polite">{cleanupMode ? '待清理' : '已选'} {totalIncluded} / {data?.total ?? 0} 篇{busy ? ' · 保存中…' : ''}</span>
    </div>
    <p className="text-xs text-ink-faint mb-2">{q ? `批量操作作用于筛选出的 ${tree.targets.length} 篇文档；层级复选框始终包含全部下级。` : '批量操作覆盖全部文档，包括收起的层级。'}</p>
    {error ? <p role="alert" className="text-sm text-seal-2 mb-2">{error}</p> : null}
    </div>
    {loading && !data ? <p className="flex-1 py-6 text-sm text-ink-faint">正在读取源文档…</p> : <div ref={viewport} onScroll={(e) => setScroll(e.currentTarget.scrollTop)} className="flex-1 min-h-0 overflow-auto scrollbar-thin border-y border-line" aria-label="源文档层级">
      <div style={{ height: tree.rows.length * ROW_HEIGHT, position: 'relative' }}>
        {tree.rows.slice(start, end).map(({ node, depth }, index) => {
          const count = tree.stats.get(node.id)!; const expanded = q.trim() || !collapsed.has(node.id);
          return <div key={node.id} style={{ position: 'absolute', top: (start + index) * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0, paddingLeft: Math.min(depth, 6) * 12 + 4 }} className="flex gap-1 items-center min-w-0 rounded hover:bg-paper-2 pr-1">
            {node.children.length ? <button className="w-4 shrink-0 text-ink-faint" aria-label={`${expanded ? '收起' : '展开'}：${node.title}`} aria-expanded={Boolean(expanded)} onClick={() => setCollapsed((old) => { const next = new Set(old); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })}>{expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</button> : <span className="w-4 shrink-0" />}
            <SelectionBox cleanup={cleanupMode} included={count.included} total={count.total} disabled={disabled} title={node.title} onChange={() => void change(subtreeTokens([node]), count.included === count.total ? 'exclude' : 'include')} />
            {node.children.length || !node.source ? <Folder className="w-4 h-4 shrink-0 text-ink-soft" /> : <FileText className="w-4 h-4 shrink-0 text-ink-faint" />}
            <div className="flex-1 min-w-0"><span className="block text-sm text-ink truncate" title={node.source?.relPath ?? node.title}>{node.title}</span></div>
            {node.children.length ? <span className="text-xs text-ink-soft shrink-0">{count.included}/{count.total} 篇</span> : null}
            {node.sourceUnavailable ? <span className="text-xs text-ink-faint shrink-0" title="该节点是一份云文档，目前没有可确认的本地正文；同步成功或恢复本地版本后可参与构建">源不可用</span> : null}
            {node.source ? <>{node.source.recovered ? <span className="text-xs text-jade shrink-0" title="按文档标识找到的本地历史版本，云端同步状态未变">本地</span> : null}<span className="text-xs text-ink-faint shrink-0">{LABEL[node.source.pending]}</span><button className="text-xs text-seal shrink-0" onClick={() => onOpenSource(node.source!)} aria-label={`预览：${node.title}`}>预览</button></> : null}
            <button className="text-xs text-seal shrink-0 disabled:opacity-40" disabled={disabled} aria-label={`清理${node.children.length ? '层级' : '文档'}：${node.title}`} onClick={() => requestCleanup(subtreeTokens([node]))}>清理</button>
          </div>;
        })}
      </div>
      {!tree.rows.length ? <p className="py-6 text-sm text-ink-faint">没有匹配的本地源文档。</p> : null}
    </div>}
    {running ? <p className="text-xs text-seal mt-2">构建进行中，源选择暂不可更改。</p> : null}
    {!cleanupMode ? <div className="mt-3 flex shrink-0 flex-wrap items-center justify-end gap-3">
      <span className="text-xs text-ink-faint">将重新构建已选的 {totalIncluded} 篇源文档</span>
      <Button size="sm" disabled={disabled || !canBuild || totalIncluded === 0} onClick={() => onBuild(totalIncluded)}>构建所选文档</Button>
    </div> : null}
  </div>;
}
