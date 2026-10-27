import { useEffect, useState } from 'react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { getKbChanges, getKbVersion, listKbSources, listKbVersions, setKbSourceIncluded } from '../../api/client';
import { formatDateTime } from '../../utils/agentReadiness';
import type { KbChangePreview, KbFileChange, KbSourceChoice, KbVersionDto } from '../../types/kb-version';

export type KbChangeTab = 'sources' | 'pending' | 'history';
const LABEL = { added: '新增', changed: '修改', removed: '移除', unchanged: '无变化', excluded: '已排除' };

export function KbChangesPanel({ tab, onTab, onClose, onChanged, onUpdate, onOpenSource, running, canUpdate }: {
  tab: KbChangeTab | null;
  onTab: (tab: KbChangeTab) => void;
  onClose: () => void;
  onChanged: () => void;
  onUpdate: () => void;
  onOpenSource: (source: KbSourceChoice) => void;
  running: boolean;
  canUpdate: boolean;
}) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [sources, setSources] = useState<KbSourceChoice[]>([]);
  const [total, setTotal] = useState(0);
  const [preview, setPreview] = useState<KbChangePreview | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof listKbVersions>> | null>(null);
  const [versionId, setVersionId] = useState('');
  const [version, setVersion] = useState<KbVersionDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [versionLoading, setVersionLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!tab) return;
    let disposed = false;
    setLoading(true); setError('');
    void (async () => {
      try {
        if (tab === 'sources') {
          const data = await listKbSources(q, page);
          if (!disposed) { setSources(data.sources); setTotal(data.total); }
        } else if (tab === 'pending') {
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
  }, [tab, q, page, nonce]);

  useEffect(() => {
    if (tab !== 'history' || !versionId) { setVersion(null); return; }
    let disposed = false;
    setVersion(null); setVersionLoading(true);
    void getKbVersion(versionId).then((data) => { if (!disposed) setVersion(data); })
      .catch((err) => { if (!disposed) setError(err instanceof Error ? err.message : '版本读取失败'); })
      .finally(() => { if (!disposed) setVersionLoading(false); });
    return () => { disposed = true; };
  }, [tab, versionId, nonce]);

  const toggle = async (source: KbSourceChoice) => {
    setBusy(source.objToken); setError('');
    try {
      await setKbSourceIncluded(source.objToken, !source.included);
      setNonce((n) => n + 1); onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : '标记保存失败'); }
    finally { setBusy(null); }
  };

  return <Modal open={tab !== null} title="源文档与变更记录" onClose={onClose} contentClassName="max-w-5xl">
    <div className="flex gap-2 border-b border-line pb-3 mb-3" role="tablist" aria-label="变更管理">
      {(['sources', 'pending', 'history'] as const).map((value) => <Button key={value} size="sm"
        role="tab" aria-selected={tab === value} variant={tab === value ? 'primary' : 'secondary'} onClick={() => onTab(value)}>
        {{ sources: '源文档', pending: '待更新差异', history: '版本记录' }[value]}
      </Button>)}
      <div className="flex-1" />
      <Button size="sm" variant="ghost" onClick={() => setNonce((n) => n + 1)}>刷新</Button>
      <Button size="sm" variant="secondary" onClick={onClose}>关闭</Button>
    </div>
    {error ? <p role="alert" className="text-sm text-seal-2 mb-3">{error}</p> : null}
    <div className="h-[60vh] min-h-[260px] overflow-auto scrollbar-thin">
      {tab === 'sources' ? <>
        <p className="text-xs text-ink-soft mb-3 leading-relaxed">
          取消勾选后，文档继续保留在原始库，但不再参与标准库构建。已参与过的来源会在下次「按变更更新」时移除其影响；重新勾选后可再次参与。
        </p>
        <input aria-label="搜索源文档" placeholder="搜索标题、路径或文档标识" value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }} className="w-full px-3 py-2 mb-3 rounded border border-line bg-card-bg text-sm" />
        {loading ? <p className="text-xs text-ink-faint">正在读取源文档…</p> : <>
          {sources.map((source) => <div key={source.objToken} className="flex gap-3 items-center py-3 border-b border-line/60">
            <input type="checkbox" checked={source.included} disabled={running || busy !== null}
              aria-label={`参与构建：${source.title}`} onChange={() => void toggle(source)} className="accent-[#9e2b25] shrink-0" />
            <button onClick={() => onOpenSource(source)} className="flex-1 min-w-0 text-left hover:text-seal">
              <span className="block text-sm text-ink break-all">{source.title}</span>
              <span className="block text-xs text-ink-faint break-all mt-1">{source.relPath}</span>
            </button>
            <span className="text-xs shrink-0 text-ink-soft">{source.included ? '参与构建' : '不参与构建'}</span>
            <span className={`text-xs shrink-0 ${source.pending === 'removed' ? 'text-seal-2' : 'text-ink-faint'}`}>
              {LABEL[source.pending]}{source.pending === 'removed' ? '（待更新）' : ''}
            </span>
          </div>)}
          {!sources.length ? <p className="py-6 text-sm text-ink-faint">没有匹配的本地源文档。</p> : null}
          <div className="flex items-center justify-between py-3 text-xs text-ink-faint">
            <span>共 {total} 篇 · 第 {page} 页</span><div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
              <Button size="sm" variant="secondary" disabled={page * 50 >= total} onClick={() => setPage((p) => p + 1)}>下一页</Button>
            </div>
          </div>
        </>}
        {running ? <p className="text-xs text-seal">构建进行中，源选择暂不可更改。</p> : null}
      </> : tab === 'pending' ? <>
        <p className="text-xs text-ink-soft mb-3">比较当前参与构建的原始源与最近发布的源快照。差异用于更新判断，正文会重新写成完整说明。</p>
        {loading ? <p className="text-xs text-ink-faint">正在计算差异…</p> : preview ? <>
          <p className="text-sm text-ink mb-2">{preview.sources.length} 个源变更 · {preview.affectedDocs.length} 篇已有标准文档受影响</p>
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
