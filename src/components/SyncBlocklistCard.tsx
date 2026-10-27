import { useEffect, useMemo, useRef, useState } from 'react';
import { getSyncBlocklist, removeSyncBlocklist } from '../api/client';
import { Button } from './common/Button';
export function SyncBlocklistCard() {
  const [data, setData] = useState<Awaited<ReturnType<typeof getSyncBlocklist>> | null>(null);
  const [selected, setSelected] = useState(new Set<string>()); const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const check = useRef<HTMLInputElement>(null);
  const refresh = async () => { setBusy(true); setError(''); try { const value = await getSyncBlocklist(); setData(value); setSelected((old) => new Set([...old].filter((token) => value.items.some((item) => item.objToken === token)))); } catch (err) { setError(err instanceof Error ? err.message : '读取失败'); } finally { setBusy(false); } };
  useEffect(() => { void refresh(); }, []);
  const items = useMemo(() => data?.items.filter((item) => `${item.title} ${item.objToken}`.toLowerCase().includes(q.trim().toLowerCase())) ?? [], [data, q]);
  const selectedVisible = items.filter((item) => selected.has(item.objToken)).length;
  useEffect(() => { if (check.current) check.current.indeterminate = selectedVisible > 0 && selectedVisible < items.length; }, [selectedVisible, items.length]);
  const remove = async () => {
    if (!data || !selected.size) return;
    setBusy(true); setError(''); setNotice('');
    try { const result = await removeSyncBlocklist(data.root, [...selected]); setNotice(`已移出 ${result.removed} 篇文档，后续可继续检测与同步。`); setSelected(new Set()); setData(await getSyncBlocklist()); }
    catch (err) { setError(err instanceof Error ? err.message : '移出失败'); } finally { setBusy(false); }
  };
  return <div className="rounded border border-line bg-card-bg p-4">
    <h3 className="text-base text-ink mb-2">同步屏蔽名单</h3>
    <p className="text-sm text-ink-soft mb-4">已屏蔽的文档不会进入待同步列表。移出后恢复检测资格；有效上级下的文档可重新同步，其他文档可通过后续检测或重新添加恢复。</p>
    {error ? <p role="alert" className="text-sm text-seal-2 mb-3">{error}</p> : null}
    {notice ? <p role="status" className="text-sm text-jade mb-3">{notice}</p> : null}
    <input aria-label="搜索屏蔽文档" placeholder="搜索文档名或标识" className="w-full rounded border border-line bg-paper p-2 text-sm mb-3" value={q} onChange={(e) => setQ(e.target.value)} />
    <div className="flex flex-wrap items-center gap-3 mb-3"><label className="flex gap-2 items-center text-sm"><input ref={check} type="checkbox" aria-label="全选当前屏蔽结果" disabled={busy || !items.length} checked={items.length > 0 && selectedVisible === items.length} onChange={() => setSelected((old) => { const next = new Set(old); for (const item of items) { if (selectedVisible === items.length) next.delete(item.objToken); else next.add(item.objToken); } return next; })} />全选当前结果</label>
      <span className="text-xs text-ink-faint">已选 {selected.size} / {data?.items.length ?? 0}</span>
      <Button size="sm" disabled={busy || !selected.size} onClick={() => void remove()}>移出屏蔽名单（{selected.size}）</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>刷新</Button>
    </div>
    <div className="max-h-[52vh] overflow-auto">{items.map((item) => <label key={item.objToken} className="flex gap-3 items-center border-t border-line py-3"><input aria-label={`选择屏蔽文档：${item.title}`} type="checkbox" disabled={busy} checked={selected.has(item.objToken)} onChange={() => setSelected((old) => { const next = new Set(old); if (next.has(item.objToken)) next.delete(item.objToken); else next.add(item.objToken); return next; })} /><span className="min-w-0"><span className="block text-sm text-ink">{item.title}</span><span className="block text-xs text-ink-faint break-all">{item.objToken} · {new Date(item.blockedAt).toLocaleString()}</span></span></label>)}{!items.length ? <p className="text-sm text-ink-faint py-6">{busy ? '正在读取…' : '没有匹配的屏蔽文档。'}</p> : null}</div>
  </div>;
}
