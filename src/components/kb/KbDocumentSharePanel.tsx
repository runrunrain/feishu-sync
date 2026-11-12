import { useEffect, useMemo, useState } from 'react';
import { Button } from '../common/Button';
import { useToast } from '../common/Toast';
import { createKbWebShare, downloadKbDocuments, getKbWebShares, resumeKbWebShares, revokeKbWebShare, type KbWebShareStatus } from '../../api/client';
import type { KbTreeNode } from '../../types/agent';
import { writeClipboardText } from '../../utils/clipboard';

interface Props { releaseId: string | null; nodes: KbTreeNode[]; selectedDocId: string | null }
export function KbDocumentSharePanel({ releaseId, nodes, selectedDocId }: Props) {
  const { push } = useToast();
  const docs = useMemo(() => {
    const items: Array<{ id: string; title: string; path: string }> = [];
    const visit = (tree: KbTreeNode[]) => { for (const node of tree) {
      if (node.type === 'doc' && node.docId) items.push({ id: node.docId, title: node.title || node.name, path: node.path });
      if (node.children) visit(node.children);
    } };
    visit(nodes); return items;
  }, [nodes]);
  const [selected, setSelected] = useState<string[]>(selectedDocId ? [selectedDocId] : []);
  const [baseDocId, setBaseDocId] = useState(selectedDocId ?? '');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<KbWebShareStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSelected(selectedDocId ? [selectedDocId] : []); setBaseDocId(selectedDocId ?? '');
  }, [releaseId, selectedDocId]);
  useEffect(() => {
    let live = true;
    void getKbWebShares().then(data => { if (live) setStatus(data); }).catch(cause => { if (live) setError(String(cause)); });
    return () => { live = false; };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const download = (format: 'md' | 'zip') => run(async () => {
    if (!releaseId) return;
    const blob = await downloadKbDocuments({ releaseId, docIds: selected, format });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = format === 'md' ? docs.find(d => d.id === selected[0])!.path.split('/').pop()! : 'standard-documents.zip';
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    push({ type: 'success', message: '已生成 Markdown 下载文件' });
  });
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id];
    setSelected(next); if (!next.includes(baseDocId)) setBaseDocId(next[0] ?? '');
  };
  const visible = docs.filter(d => `${d.title} ${d.path}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="space-y-3 pb-5" aria-label="文档导出与网页分享">
    <h4 className="text-ink font-medium">文档导出与内网分享</h4>
    <p>选择已发布的标准库文档。分享范围内的链接可跳转，每页均可返回基准文档。</p>
    <input aria-label="筛选分享文档" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索文档标题或路径" className="w-full rounded border border-line bg-paper px-2 py-1.5" />
    <div className="flex gap-3 items-center">
      <button type="button" disabled={busy} className="text-jade underline" onClick={() => { setSelected(docs.map(d => d.id)); setBaseDocId(baseDocId || docs[0]?.id || ''); }}>全选</button>
      <button type="button" disabled={busy} className="text-jade underline" onClick={() => { setSelected([]); setBaseDocId(''); }}>清空</button>
      <span>已选 {selected.length} / {docs.length} 篇</span>
    </div>
    <div className="max-h-56 overflow-auto border border-line rounded p-2 space-y-1">
      {visible.map(doc => <label key={doc.id} className="flex gap-2 items-start py-1 cursor-pointer" title={doc.path}>
        <input type="checkbox" disabled={busy} checked={selected.includes(doc.id)} onChange={() => toggle(doc.id)} className="mt-1 shrink-0" />
        <span className="min-w-0 break-words">{doc.title}</span>
      </label>)}
      {!visible.length ? <p className="text-ink-faint">没有可选文档</p> : null}
    </div>
    <div className="flex gap-2 flex-wrap">
      <Button size="sm" variant="secondary" disabled={busy || !releaseId || selected.length !== 1} onClick={() => void download('md')}>导出单篇 .md</Button>
      <Button size="sm" variant="secondary" disabled={busy || !releaseId || !selected.length} onClick={() => void download('zip')}>导出 Markdown 包</Button>
    </div>
    <p className="text-ink-faint">单篇 .md 保留原文链接；Markdown 包保留目录与可用本地图片。需要离线看图时请选择包导出。</p>
    <label className="block space-y-1"><span>分享基准文档</span>
      <select aria-label="分享基准文档" disabled={busy || !selected.length} value={baseDocId} onChange={e => setBaseDocId(e.target.value)} className="w-full rounded border border-line bg-paper p-1.5">
        {!selected.length ? <option value="">请先选择文档</option> : null}
        {docs.filter(d => selected.includes(d.id)).map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
      </select>
    </label>
    <Button size="sm" disabled={busy || !releaseId || !selected.length || !selected.includes(baseDocId)} loading={busy} onClick={() => void run(async () => {
      setStatus(await createKbWebShare({ releaseId: releaseId!, docIds: selected, baseDocId }));
      push({ type: 'success', message: '网页分享已创建，可复制下方链接' });
    })}>创建内网分享</Button>
    <p className="text-ink-faint">链接持有者可在内网阅读所选文档。分享固定当前版本；请保持应用运行，并允许防火墙访问 TCP {status?.port ?? 47393}。停止分享后链接失效。</p>
    {status?.shares.length && !status.running ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => setStatus(await resumeKbWebShares()))}>重新启动分享服务</Button> : null}
    {status?.shares.map(share => <div key={share.id} className="border border-line rounded p-2 space-y-2">
      <p className="text-ink font-medium break-words">{share.title}</p>
      <p className="text-ink-faint">{share.docCount} 篇 · {new Date(share.createdAt).toLocaleString()}</p>
      {share.urls.map(url => <div key={url} className="space-y-1">
        <input aria-label={`${share.title} 的分享链接`} readOnly value={url} className="w-full border border-line rounded bg-paper p-1 text-[10px]" onFocus={e => e.currentTarget.select()} />
        <button type="button" disabled={busy || !status.running} className="text-jade underline" onClick={() => void run(async () => { await writeClipboardText(url); push({ type: 'success', message: '分享链接已复制' }); })}>复制链接</button>
      </div>)}
      <button type="button" disabled={busy} className="text-seal underline" onClick={() => void run(async () => setStatus(await revokeKbWebShare(share.id)))}>停止分享</button>
    </div>)}
    {error ? <p role="alert" className="text-seal-2 break-all">{error}</p> : null}
  </section>;
}
