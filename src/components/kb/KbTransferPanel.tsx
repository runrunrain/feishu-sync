import { useEffect, useState } from 'react';
import { Download, FolderOpen, RotateCcw, Upload } from 'lucide-react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { useToast } from '../common/Toast';
import {
  exportPortableKb, getPortableKbRestore, importPortableKb,
  previewPortableKb, restorePreviousLocalKb, type PortableKbPreview,
} from '../../api/client';

interface Props {
  releaseId: string | null;
  activeBuild: boolean;
  onChanged: () => void;
}

const sizeLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败';

export function KbTransferPanel({ releaseId, activeBuild, onChanged }: Props) {
  const { push: pushToast } = useToast();
  const [busy, setBusy] = useState<'export' | 'preview' | 'import' | 'restore' | null>(null);
  const [preview, setPreview] = useState<{ path: string; data: PortableKbPreview } | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [previousReleaseId, setPreviousReleaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canPick = typeof window !== 'undefined' && Boolean(window.desktop?.chooseKbExportPath && window.desktop?.chooseKbImportPath);

  useEffect(() => {
    let live = true;
    void getPortableKbRestore().then((data) => { if (live) setPreviousReleaseId(data.previousReleaseId); })
      .catch(() => { if (live) setPreviousReleaseId(null); });
    return () => { live = false; };
  }, [releaseId]);

  const exportBundle = async () => {
    if (!window.desktop?.chooseKbExportPath || !releaseId) return;
    const path = await window.desktop.chooseKbExportPath(`FeishuSync-standard-kb-${releaseId}.fskb`);
    if (!path) return;
    setBusy('export'); setError(null); setExportedPath(null);
    try {
      // A returned native SaveDialog path includes its replacement confirmation.
      const result = await exportPortableKb(path, { overwrite: true });
      setExportedPath(result.path);
      pushToast({ type: 'success', message: `标准库已导出：${result.docCount} 篇文档` });
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(null); }
  };

  const chooseImport = async () => {
    if (!window.desktop?.chooseKbImportPath) return;
    const path = await window.desktop.chooseKbImportPath();
    if (!path) return;
    setBusy('preview'); setError(null); setPreview(null);
    try { setPreview({ path, data: await previewPortableKb(path) }); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(null); }
  };

  const commitImport = async () => {
    if (!preview) return;
    setBusy('import'); setError(null);
    try {
      const result = await importPortableKb(preview.path, preview.data.currentReleaseId);
      setPreview(null);
      onChanged();
      setPreviousReleaseId(result.previousReleaseId && result.previousReleaseId !== result.releaseId ? result.previousReleaseId : null);
      pushToast({ type: 'success', message: `标准库已导入：${result.docCount} 篇文档` });
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(null); }
  };

  const restore = async () => {
    setBusy('restore'); setError(null);
    try {
      const result = await restorePreviousLocalKb();
      setPreviousReleaseId(null);
      onChanged();
      pushToast({ type: 'success', message: `已恢复导入前版本：${result.releaseId}` });
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(null); }
  };

  return <>
    <section className="space-y-2 border-t border-line pt-3" data-testid="kb-transfer-panel">
      <h4 className="text-ink font-medium">本地共享与迁移</h4>
      <p className="leading-relaxed">导出当前正式标准库的文档、目录、检索知识、来源快照、证据图片和治理记录。共享包可能包含原始资料，请只交给有权阅读的人。</p>
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" variant="secondary" onClick={() => void exportBundle()} disabled={!canPick || !releaseId || Boolean(busy)} loading={busy === 'export'}>
          <Download className="w-3.5 h-3.5" />导出标准库
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void chooseImport()} disabled={!canPick || Boolean(busy)} loading={busy === 'preview'}>
          <Upload className="w-3.5 h-3.5" />导入共享包
        </Button>
      </div>
      {!canPick ? <p className="text-seal-2">请在桌面应用中使用导入导出。</p> : null}
      {activeBuild ? <p className="text-ink-faint">构建期间可以导出当前正式版本；导入需等待构建结束。</p> : null}
      {previousReleaseId ? <Button size="sm" variant="ghost" onClick={() => void restore()} disabled={activeBuild || Boolean(busy)} loading={busy === 'restore'}>
        <RotateCcw className="w-3.5 h-3.5" />恢复导入前版本
      </Button> : null}
      {exportedPath ? <button type="button" className="flex items-center gap-1 text-jade underline break-all text-left" onClick={() => void window.desktop?.revealInFolder(exportedPath)}>
        <FolderOpen className="w-3.5 h-3.5 shrink-0" />在文件夹中查看共享包
      </button> : null}
      {error && !preview ? <p role="alert" className="text-seal-2 break-all">{error}</p> : null}
    </section>

    <Modal open={Boolean(preview)} title="导入标准库共享包" onClose={busy === 'import' ? undefined : () => { setPreview(null); setError(null); }} zIndexClass="z-[400]">
      {preview ? <div className="space-y-3 text-sm text-ink-soft">
        <p className="break-all text-xs text-ink-faint">{preview.path}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>版本</dt><dd className="font-mono break-all">{preview.data.releaseId}</dd>
          <dt>正式文档</dt><dd>{preview.data.docCount} 篇</dd>
          <dt>来源快照</dt><dd>{preview.data.sourceCount} 份</dd>
          <dt>共享包</dt><dd>{sizeLabel(preview.data.archiveBytes)}</dd>
          <dt>当前本机版本</dt><dd className="font-mono break-all">{preview.data.currentReleaseId ?? '无'}</dd>
        </dl>
        <p className="text-xs leading-relaxed">导入会逐文件校验共享包，然后切换本机正式标准库。原有版本会保留，可从此处恢复。原始同步文档、飞书账号和构建设置不会从包中导入。</p>
        {preview.data.alreadyInstalled ? <p className="text-xs text-jade">本机已有同名版本；内容完全一致时可直接切换。</p> : null}
        {activeBuild ? <p className="text-xs text-seal-2">构建进行中，结束后可导入。</p> : null}
        {error ? <p role="alert" className="text-xs text-seal-2">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="secondary" onClick={() => { setPreview(null); setError(null); }} disabled={busy === 'import'}>取消</Button>
          <Button size="sm" onClick={() => void commitImport()} disabled={activeBuild || Boolean(busy)} loading={busy === 'import'}>校验并导入</Button>
        </div>
      </div> : null}
    </Modal>
  </>;
}
