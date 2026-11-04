import { useEffect, useState } from 'react';
import { Download, FileText, ImageIcon, Loader2, X } from 'lucide-react';
import { getAgentAttachmentBlob } from '../../api/client';
import type { AgentAttachmentDto } from '../../types/agent';
import { Modal } from '../common/Modal';

export function ChatAttachmentCards({ sessionId, attachments }: { sessionId: string; attachments: AgentAttachmentDto[] }) {
  return <div className="flex flex-wrap gap-2 mb-2" aria-label="消息附件">
    {attachments.map((attachment) => <AttachmentCard key={attachment.id} sessionId={sessionId} attachment={attachment} />)}
  </div>;
}

function AttachmentCard({ sessionId, attachment }: { sessionId: string; attachment: AgentAttachmentDto }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (attachment.kind !== 'image') return;
    const controller = new AbortController();
    let url: string | undefined;
    void getAgentAttachmentBlob(sessionId, attachment.id, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob); setPreview(url);
    }).catch((error) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '图片加载失败'); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [sessionId, attachment.id, attachment.kind]);

  const download = async () => {
    setBusy(true); setError('');
    try {
      const blob = await getAgentAttachmentBlob(sessionId, attachment.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = attachment.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setError(error instanceof Error ? error.message : '附件下载失败'); }
    finally { setBusy(false); }
  };
  return <div className="w-48 max-w-full rounded-lg border border-line bg-card-bg px-2.5 py-2">
    {attachment.kind === 'image' ? <button type="button" className="w-full flex justify-center rounded bg-paper mb-1.5 min-h-20" aria-label={`预览图片 ${attachment.name}`} onClick={() => { if (preview) setOpen(true); }}>
      {preview ? <img className="max-h-32 max-w-full object-contain rounded" src={preview} alt={attachment.name} /> : <ImageIcon className="h-8 w-8 m-5 text-ink-faint" />}
    </button> : <FileText className="h-6 w-6 mb-1.5 text-seal" />}
    <p className="text-xs text-ink truncate" title={attachment.name}>{attachment.name}</p>
    <div className="flex items-center justify-between mt-1">
      <span className="text-[10px] text-ink-faint">{Math.max(1, Math.round(attachment.size / 1024))} KB</span>
      <button type="button" disabled={busy} className="text-ink-faint hover:text-seal p-1" onClick={() => void download()} aria-label={`下载附件 ${attachment.name}`}>
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
      </button>
    </div>
    {error ? <p className="text-[10px] text-seal-2 mt-1" role="alert">{error}</p> : null}
    <Modal open={open} title={attachment.name} onClose={() => setOpen(false)} contentClassName="max-w-5xl">
      <div className="flex justify-end mb-2"><button type="button" onClick={() => setOpen(false)} aria-label="关闭图片预览" className="p-1 text-ink-soft"><X className="w-4 h-4" /></button></div>
      {preview ? <img src={preview} alt={attachment.name} className="max-w-full max-h-[75vh] object-contain mx-auto" /> : null}
    </Modal>
  </div>;
}
