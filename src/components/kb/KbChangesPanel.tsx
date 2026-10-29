import { useEffect, useState } from 'react';
import { ImageIcon } from 'lucide-react';
import { KbSourceSelector } from './KbSourceSelector';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { getKbChanges, getKbVersion, listKbVersions } from '../../api/client';
import { formatDateTime } from '../../utils/agentReadiness';
import type { KbChangePreview, KbFileChange, KbSourceChoice, KbVersionDto } from '../../types/kb-version';

export type KbChangeTab = 'sources' | 'pending' | 'history';
const LABEL = { added: '新增', changed: '修改', removed: '移除', unchanged: '无变化', excluded: '已排除' };

/** S3/S5：待处理源的图片计数提示（/api/kb/changes 的 images 维度）。导出供单测锚定。 */
export function KbPendingImagesHint({ images }: { images: { total: number; uncached: number } }) {
  if (images.total <= 0) return null;
  return (
    <p className="flex items-start gap-1.5 text-xs text-ink-soft mb-3" data-testid="kb-pending-images">
      <ImageIcon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-faint" />
      <span>
        待处理源引用图片约 {images.total} 张
        {images.uncached > 0
          ? `，其中 ${images.uncached} 张尚未缓存——未启用图片理解时，构建会在图片处插入「未理解」标记（可在设置 → Agent 开启「图片理解」）。`
          : '，均已有缓存描述。'}
      </span>
    </p>
  );
}

export function KbChangesPanel({ tab, onTab, onClose, onChanged, onUpdate, onBuildSelected, onOpenSource, running, canUpdate }: {
  tab: KbChangeTab | null;
  onTab: (tab: KbChangeTab) => void;
  onClose: () => void;
  onChanged: () => void;
  onUpdate: () => void;
  onBuildSelected: (count: number) => void;
  onOpenSource: (source: KbSourceChoice) => void;
  running: boolean;
  canUpdate: boolean;
}) {
  const [preview, setPreview] = useState<KbChangePreview | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof listKbVersions>> | null>(null);
  const [versionId, setVersionId] = useState('');
  const [version, setVersion] = useState<KbVersionDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [versionLoading, setVersionLoading] = useState(false);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!tab || tab === 'sources') { setLoading(false); setError(''); return; }
    let disposed = false;
    setLoading(true); setError('');
    void (async () => {
      try {
        if (tab === 'pending') {
          const data = await getKbChanges();
          if (!disposed) setPreview(data);
        } else {
          const data = await listKbVersions();
          if (!disposed) {
            setHistory(data);
            setVersionId((id) => data.versions.some((v) => v.releaseId === id) ? id : data.versions[0]?.releaseId ?? '');
          }
        }
      } catch (err) { if (!disposed) setError(err instanceof Error ? err.message : '读取失败'); }
      finally { if (!disposed) setLoading(false); }
    })();
    return () => { disposed = true; };
  }, [tab, nonce]);

  useEffect(() => {
    if (tab !== 'history' || !versionId) { setVersion(null); return; }
    let disposed = false;
    setVersion(null); setVersionLoading(true);
    void getKbVersion(versionId).then((data) => { if (!disposed) setVersion(data); })
      .catch((err) => { if (!disposed) setError(err instanceof Error ? err.message : '版本读取失败'); })
      .finally(() => { if (!disposed) setVersionLoading(false); });
    return () => { disposed = true; };
  }, [tab, versionId, nonce]);

  return <Modal open={tab !== null} title="源文档与变更记录" onClose={onClose} contentClassName="max-w-5xl h-[min(760px,calc(100dvh-32px))]" bodyClassName="flex flex-1 flex-col overflow-hidden">
    <div className="flex shrink-0 flex-wrap gap-2 border-b border-line pb-3 mb-3" role="tablist" aria-label="变更管理">
      {(['sources', 'pending', 'history'] as const).map((value) => <Button key={value} size="sm"
        role="tab" aria-selected={tab === value} variant={tab === value ? 'primary' : 'secondary'} onClick={() => onTab(value)}>
        {{ sources: '源文档', pending: '待更新差异', history: '版本记录' }[value]}
      </Button>)}
      <div className="flex-1" />
      <Button size="sm" variant="ghost" onClick={() => setNonce((n) => n + 1)}>刷新</Button>
      <Button size="sm" variant="secondary" onClick={onClose}>关闭</Button>
    </div>
    {error ? <p role="alert" className="text-sm text-seal-2 mb-3">{error}</p> : null}
    <div className={`flex-1 min-h-0 ${tab === 'sources' ? 'overflow-hidden' : 'overflow-auto scrollbar-thin'}`}>
      {tab === 'sources' ? <KbSourceSelector nonce={nonce} running={running} canBuild={canUpdate} onBuild={onBuildSelected} onChanged={onChanged} onOpenSource={onOpenSource} /> : tab === 'pending' ? <>
        <p className="text-xs text-ink-soft mb-3">比较当前参与构建的原始源与最近发布的源快照。差异用于更新判断，正文会重新写成完整说明。</p>
        {loading ? <p className="text-xs text-ink-faint">正在计算差异…</p> : preview ? <>
          <p className="text-sm text-ink mb-2">{preview.sources.length} 个源变更 · {preview.affectedDocs.length} 篇已有标准文档受影响</p>
          {preview.images ? <KbPendingImagesHint images={preview.images} /> : null}
          {preview.affectedDocs.length ? <p className="text-xs text-ink-faint mb-3">受影响：{preview.affectedDocs.map((doc) => doc.title).join('、')}</p> : null}
          <ChangeList changes={preview.sources} />
          {!preview.sources.length ? <p className="text-sm text-ink-faint py-6">没有待更新的源变更。</p> : null}
        </> : null}
      </> : <>
        <p className="text-xs text-ink-soft mb-3">每次成功发布保存独立版本，记录其父版本、源差异与标准正文差异。保留最近 {history?.retainReleases ?? '—'} 个版本；旧版本清理后，保留版本的差异仍可查看。</p>
        {loading ? <p className="text-xs text-ink-faint">正在读取版本…</p> : history?.versions.length ? <>
          <select aria-label="选择标准库版本" value={versionId} onChange={(e) => setVersionId(e.target.value)}
            className="w-full rounded border border-line px-3 py-2 bg-card-bg text-xs mb-3">
            {history.versions.map((v) => <option key={v.releaseId} value={v.releaseId}>
              {formatDateTime(v.publishedAt)} · {v.releaseId} · {v.docCount}篇标准文档变更
            </option>)}
          </select>
          {versionLoading ? <p className="text-xs text-ink-faint">正在读取版本差异…</p> : version ? <>
            <p className="text-xs font-mono text-ink-faint break-all mb-2">{version.baseReleaseId ?? '初始版本'} → {version.releaseId}</p>
            {version.summary ? <p className="text-sm text-ink-soft whitespace-pre-wrap mb-4">{version.summary}</p> : null}
            <h4 className="text-sm font-medium text-ink mb-2">标准文档变化</h4><ChangeList changes={version.docChanges} />
            {!version.docChanges.length ? <p className="text-xs text-ink-faint mb-3">该版本无已记录的正文差异。</p> : null}
            <h4 className="text-sm font-medium text-ink mt-4 mb-2">原始源变化</h4><ChangeList changes={version.sourceChanges} />
          </> : null}
        </> : <p className="text-sm text-ink-faint py-6">尚无发布版本。</p>}
      </>}
    </div>
    {tab === 'pending' ? <div className="pt-3 mt-3 border-t border-line flex justify-end">
      <Button size="sm" onClick={onUpdate} disabled={!canUpdate || running || loading || !preview?.sources.length}>按这些变更更新</Button>
    </div> : null}
  </Modal>;
}

function ChangeList({ changes }: { changes: KbFileChange[] }) {
  return <div className="space-y-2">{changes.map((change) => <details key={change.key} className="rounded border border-line bg-paper/40">
    <summary className="cursor-pointer p-3 text-sm text-ink break-all">
      <span className="mr-2 text-xs text-seal">{LABEL[change.kind]}{change.reason === 'excluded' ? ' · 用户排除' : ''}</span>
      {change.path}<span className="ml-3 text-xs text-jade">+{change.additions}</span><span className="ml-2 text-xs text-seal-2">-{change.deletions}</span>
    </summary>
    <div className="border-t border-line p-3">
      {!change.beforeAvailable ? <p className="text-xs text-ink-faint">历史版本尚未保存原文，仅有hash；本次开始保存完整源快照，不推测缺失的旧差异。</p>
        : !change.patch ? <p className="text-xs text-ink-faint">正文未变化；路径、标题或来源等元数据已更新。</p>
          : <pre className="text-xs font-mono overflow-x-auto leading-relaxed" aria-label={`差异：${change.title}`}>
            {change.patch.split('\n').map((line, i) => <div key={i} className={line.startsWith('+') ? 'text-jade bg-jade/5' : line.startsWith('-') ? 'text-seal-2 bg-seal-2/5' : 'text-ink-soft'}>{line || ' '}</div>)}
          </pre>}
      {change.truncated ? <p className="text-xs text-seal mt-2">差异过长，已截断显示；构建仍读取完整源文档。</p> : null}
    </div>
  </details>)}</div>;
}
