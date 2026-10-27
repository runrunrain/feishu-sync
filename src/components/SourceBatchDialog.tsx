import { useEffect, useMemo, useState } from 'react';
import { applySourceBatch, previewSourceBatch } from '../api/client';
import type { SourceBatchPreview } from '../types/source-batch';
import { Modal } from './common/Modal';
import { Button } from './common/Button';
export function SourceBatchDialog({ root, tokens, action, onClose, onComplete }: { root: string; tokens: string[]; action: 'delete' | 'block'; onClose: () => void; onComplete: (processed: number, processedTokens: string[]) => void }) {
  const [children, setChildren] = useState(false); const [deleteFiles, setDeleteFiles] = useState(true); const [block, setBlock] = useState(false);
  const [preview, setPreview] = useState<SourceBatchPreview | null>(null); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [nonce, setNonce] = useState(0);
  const request = useMemo(() => ({ root, tokens, action, includeDescendants: children, deleteFiles: action === 'delete' && deleteFiles, block: action === 'block' || block }), [root, tokens, action, children, deleteFiles, block]);
  useEffect(() => { let disposed = false; setLoading(true); setPreview(null); setError('');
    void previewSourceBatch(request).then((value) => { if (!disposed) setPreview(value); }).catch((err) => { if (!disposed) setError(err instanceof Error ? err.message : '读取清单失败'); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [request, nonce]);
  const apply = async () => { if (!preview || busy || loading) return; setBusy(true); setError('');
    try { const result = await applySourceBatch(request, preview.revision); onComplete(result.processed, preview.items.map((item) => item.objToken)); }
    catch (err) { setPreview(null); setError(err instanceof Error ? err.message : '操作失败，请刷新清单'); }
    finally { setBusy(false); }
  };
  const counts = { pending: 0, blocked: 0, removed: 0 }; preview?.items.forEach((item) => counts[item.effect]++);
  return <Modal open title={action === 'delete' ? '确认批量删除源文档' : '确认批量移入屏蔽名单'} onClose={() => { if (!busy) onClose(); }} contentClassName="max-w-3xl">
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm mb-3">
      <label className="flex gap-2 items-center"><input type="checkbox" aria-label="补全所选文档的全部子文档" checked={children} disabled={busy} onChange={(e) => setChildren(e.target.checked)} />补全所选文档的全部子文档</label>
      {action === 'delete' ? <><label className="flex gap-2 items-center"><input type="checkbox" aria-label="批量删除本地源文件" checked={deleteFiles} disabled={busy} onChange={(e) => setDeleteFiles(e.target.checked)} />本地源文件移入回收目录</label><label className="flex gap-2 items-center"><input type="checkbox" aria-label="批量删除并屏蔽" checked={block} disabled={busy} onChange={(e) => setBlock(e.target.checked)} />同时移入屏蔽名单</label></> : null}
    </div>
    <p className="text-xs text-ink-soft leading-relaxed mb-3">{action === 'block' ? '仅屏蔽同步检测，本地文件、成功基线和标准库内容保留。可在同步屏蔽名单中多选移出。' : '按以下清单处理，未列出的文档保留。有效上级下的未屏蔽文档会转为待同步；屏蔽文档不会进入待同步列表。标准库已有内容通过下次按变更更新处理，云端原文和历史版本保留。'}</p>
    {error ? <p role="alert" className="text-sm text-seal-2 mb-3">{error}</p> : null}
    {loading ? <p className="text-sm text-ink-faint py-5">正在计算具体清单与影响范围…</p> : preview ? <>
      <p className="text-sm text-ink mb-2">共 {preview.items.length} 篇 · 直接选择 {preview.directCount} 篇 · 自动追加子文档 {preview.descendantCount} 篇</p>
      <p className="text-xs text-ink-soft mb-3">{counts.pending} 篇转为待同步 · {counts.blocked} 篇屏蔽 · {counts.removed} 篇移除索引 · {preview.files.length} 个本地文件回收 · {preview.affectedStandardDocs.length} 篇标准文档受影响</p>
      <div className="max-h-[30vh] overflow-auto border-y border-line mb-3" aria-label="批量处理文档清单">{preview.items.map((item) => <div key={item.objToken} className="py-2 border-b border-line/50 flex items-start gap-3"><div className="min-w-0 flex-1"><span className="block text-sm text-ink">{item.title}</span><span className="block text-xs text-ink-faint break-all">{item.path}</span></div><span className="text-xs text-seal shrink-0">{{ blocked: '屏蔽', pending: '待同步', removed: '移除索引' }[item.effect]}</span></div>)}</div>
      {preview.files.length ? <details className="text-xs text-ink-soft mb-2"><summary className="cursor-pointer">查看将回收的 {preview.files.length} 个本地文件</summary><ul className="max-h-28 overflow-auto mt-2 space-y-1">{preview.files.map((file) => <li key={file.path} className="break-all">{file.path} · {file.size} 字节</li>)}</ul></details> : null}
      {preview.affectedStandardDocs.length ? <details className="text-xs text-ink-soft mb-2"><summary className="cursor-pointer">查看受影响的标准文档</summary><ul className="max-h-24 overflow-auto mt-2">{preview.affectedStandardDocs.map((doc) => <li key={doc.docId}>{doc.title}</li>)}</ul></details> : null}
    </> : null}
    <div className="flex gap-3 justify-end pt-3"><Button size="sm" variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button size="sm" variant="secondary" disabled={busy || loading} onClick={() => setNonce((n) => n + 1)}>刷新清单</Button><Button size="sm" variant="danger" disabled={busy || loading || !preview} onClick={() => void apply()}>{busy ? '正在处理…' : action === 'block' ? '确认屏蔽' : '确认批量删除'}</Button></div>
  </Modal>;
}
