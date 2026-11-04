/** Human decisions and content reviews for the published knowledge library. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, RefreshCw, X } from 'lucide-react';
import { Button } from '../common/Button';
import {
  APIError, getKbGovernancePending, listKbGovernanceDecisions,
  recordKbHumanReview, submitKbGovernanceDecision,
} from '../../api/client';
import type { KbGovernancePendingDto, KbGovernancePendingObjectDto } from '../../types/agent';

const STATUS_LABEL: Record<string, string> = {
  unknown: '未定', candidate: '候选', approved: '已批准', disputed: '有争议', deprecated: '已停用',
};
const PAGE_SIZE = 20;
interface DecisionDraft { target: string; rationale: string }

function decisionEffect(target: string): string {
  if (target === 'approved') return '批准后，这项内容会在下一次成功发布时成为已批准的正式规则。';
  if (target === 'deprecated') return '停用后，这项内容会在下一次成功发布时标为已停用，不再作为现行规则使用。';
  return '决定会在下一次成功发布时生效。';
}

function ObjectRow({ object, onOpenDoc, children }: {
  object: KbGovernancePendingObjectDto;
  onOpenDoc?: (path: string, anchor: string | null) => void;
  children?: React.ReactNode;
}) {
  return <li className="rounded border border-line bg-paper px-3 py-2.5 space-y-2" data-testid={`kb-gov-object-${object.objectId}`}>
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="font-medium text-ink break-words">{object.title || object.objectId}</p>
        <p className="text-[10px] text-ink-faint break-all">{object.docPath ?? object.scopeKey} · {STATUS_LABEL[object.businessStatus] ?? object.businessStatus}</p>
      </div>
      {object.docPath && onOpenDoc ? <button type="button" className="text-seal shrink-0 underline" onClick={() => onOpenDoc(object.docPath!, object.anchor)}>查看正文</button> : null}
    </div>
    {object.claimPreviews.map((claim) => <div key={claim.claimKey} className="rounded bg-card-bg border border-line/70 px-2.5 py-2 space-y-1">
      <p className="text-[10px] text-seal-2">{object.reviewRejection ? '复核未通过的断言' : '关联断言'} · {claim.claimKey}</p>
      <p className="text-ink leading-relaxed break-words">{claim.excerpt || '未能提取正文片段，请打开正式文档核对这一断言。'}</p>
      <p className="text-[10px] text-ink-faint break-words">来源：{claim.evidenceSources.length ? claim.evidenceSources.join('、') : '未关联来源，请核对证据'}</p>
    </div>)}
    {children}
  </li>;
}

export function KbGovernancePanel({ onOpenDoc }: { onOpenDoc?: (path: string, anchor: string | null) => void }) {
  const [pending, setPending] = useState<KbGovernancePendingDto | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewLimit, setReviewLimit] = useState(PAGE_SIZE);
  const [actionLimit, setActionLimit] = useState(PAGE_SIZE);
  const [objectQuery, setObjectQuery] = useState('');
  const [objectLimit, setObjectLimit] = useState(PAGE_SIZE);
  const [selectedObjects, setSelectedObjects] = useState<string[]>([]);
  const [batchRationale, setBatchRationale] = useState('');
  const batchRunning = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pendingData, decisions] = await Promise.all([getKbGovernancePending(), listKbGovernanceDecisions()]);
      setPending(pendingData);
      setRevision(decisions.revision);
      setConflict(false);
    } catch (err) { setError(err instanceof APIError ? err.message : '治理状态加载失败'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const draftOf = (object: KbGovernancePendingObjectDto): DecisionDraft =>
    drafts[object.objectId] ?? { target: object.allowedDecisionTargets[0] ?? 'approved', rationale: '' };

  const submitDecision = async (object: KbGovernancePendingObjectDto) => {
    const draft = draftOf(object);
    if (!draft.rationale.trim()) { setNotice('业务决定必须填写实质理由。'); return; }
    setBusy(object.objectId);
    setNotice(null);
    try {
      await submitKbGovernanceDecision({
        objectId: object.objectId, payloadHash: object.payloadHash, scopeKey: object.scopeKey,
        businessStatus: draft.target as KbGovernancePendingObjectDto['businessStatus'],
        rationale: draft.rationale.trim(),
        ...(object.effectiveDecision ? { supersedesDecisionId: object.effectiveDecision.decisionId } : {}),
        expectedRevision: revision,
      });
      setDrafts((prev) => { const next = { ...prev }; delete next[object.objectId]; return next; });
      setNotice(`已登记业务决定（${object.title || object.objectId} → ${STATUS_LABEL[draft.target] ?? draft.target}）；决定待发布，下一次成功构建发布后生效。`);
      await load();
    } catch (err) {
      if (err instanceof APIError && err.statusCode === 409) {
        setConflict(true);
        setNotice('决定集已被并发修改，请刷新后基于最新状态重试。');
      } else setNotice(err instanceof APIError ? err.message : '决定提交失败');
    } finally { setBusy(null); }
  };

  const submitReview = async (object: KbGovernancePendingObjectDto, passed: boolean) => {
    const note = reviewNotes[object.objectId]?.trim() ?? '';
    if (!passed && !note) { setNotice('复核拒绝时请写明正文或证据的问题，方便后续修订。'); return; }
    setBusy(object.objectId);
    setNotice(null);
    try {
      await recordKbHumanReview({ objectId: object.objectId, reviewSubjectHash: object.reviewSubjectHash, passed, ...(note ? { note } : {}) });
      setReviewNotes((prev) => { const next = { ...prev }; delete next[object.objectId]; return next; });
      setNotice(`已记录人工复核${passed ? '通过' : '拒绝'}（${object.title || object.objectId}）。${passed ? '凭据绑定当前内容；新内容仍需复核。' : '该内容在下一次发布时将被阻断，修订并重新复核后可继续。'}当前正式版不变。`);
      await load();
    } catch (err) { setNotice(err instanceof APIError ? err.message : '人工复核提交失败'); }
    finally { setBusy(null); }
  };

  const rejectedReviews = pending?.highRisk ?? [];
  const candidates = pending?.candidates ?? [];
  const stale = pending?.staleDecisions ?? [];
  const governable = pending?.governable ?? [...new Map([...candidates, ...stale].map((object) => [object.objectId, object])).values()];
  const alertObjects = useMemo(() => [...new Map([...(pending?.candidates ?? []), ...(pending?.staleDecisions ?? [])].map((object) => [object.objectId, object])).values()], [pending]);
  const alertIds = new Set(alertObjects.map((object) => object.objectId));
  const reviewProblems = rejectedReviews.filter((object) => !alertIds.has(object.objectId));
  const filterObjects = (items: KbGovernancePendingObjectDto[], query: string) => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? items.filter((object) => `${object.title} ${object.objectId} ${object.docPath ?? ''} ${object.scopeKey}`.toLocaleLowerCase().includes(normalized)) : items;
  };
  const matchingObjects = objectQuery.trim() ? filterObjects(governable, objectQuery) : [];
  const eligibleForBatch = (object: KbGovernancePendingObjectDto) =>
    (object.businessStatus === 'unknown' || object.businessStatus === 'candidate')
    && object.reviewStatus === 'passed' && !object.reviewRejection && !object.effectiveDecision
    && object.allowedDecisionTargets.includes('approved');
  const visibleBatchObjects = matchingObjects.slice(0, objectLimit).filter(eligibleForBatch);

  const submitBatch = async () => {
    if (batchRunning.current) return;
    const chosen = matchingObjects.filter((object) => selectedObjects.includes(object.objectId) && eligibleForBatch(object));
    if (!chosen.length) { setNotice('请先选择要批准的对象。'); return; }
    if (!batchRationale.trim()) { setNotice('批量批准需要填写共同的核对依据。'); return; }
    batchRunning.current = true; setBusy('batch'); setNotice(null);
    let completed = 0;
    try {
      const [fresh, decisions] = await Promise.all([getKbGovernancePending(), listKbGovernanceDecisions()]);
      if (fresh.releaseId !== pending?.releaseId) throw new Error('正式版本已变化，请重新核对所选对象。');
      const current = new Map((fresh.governable ?? []).map((object) => [object.objectId, object]));
      if (chosen.some((object) => {
        const item = current.get(object.objectId);
        return !item || !eligibleForBatch(item) || item.payloadHash !== object.payloadHash || item.scopeKey !== object.scopeKey;
      })) throw new Error('所选对象或其状态已变化，请刷新后重新核对。');
      let nextRevision = decisions.revision;
      for (const object of chosen) {
        const result = await submitKbGovernanceDecision({ objectId: object.objectId, payloadHash: object.payloadHash, scopeKey: object.scopeKey,
          businessStatus: 'approved', rationale: batchRationale.trim(), expectedRevision: nextRevision });
        nextRevision = result.revision;
        completed++;
      }
      setSelectedObjects([]); setBatchRationale('');
      await load();
      setNotice(`已登记 ${completed} 项业务批准；决定将在下一次成功发布后生效。高风险内容的人工复核仍按各自要求处理。`);
    } catch (err) {
      await load();
      setSelectedObjects([]);
      setNotice(`已登记 ${completed}/${chosen.length} 项，后续项目未提交。${err instanceof Error ? err.message : '请刷新后重试。'}`);
    } finally { batchRunning.current = false; setBusy(null); }
  };

  const reviewControls = (object: KbGovernancePendingObjectDto) => <div className="space-y-2 border-t border-line/70 pt-2">
    <p className="text-ink-soft leading-relaxed">{object.reviewRejection
      ? `问题：人工复核未通过。${object.reviewRejection} 请核对上面的正文与来源。`
      : '这项断言被标为高风险。若要批准当前内容，发布前需要人工核对正文与来源；高风险标签本身不表示内容有错。'}</p>
    <p className="text-[10px] text-ink-faint">通过：记录或更新此版内容的复核结论。拒绝：阻断这项内容的下一次发布，并记录具体原因。当前正式版保持可读。</p>
    <textarea className="w-full rounded border border-line bg-card-bg px-2 py-1.5 text-xs text-ink min-h-[42px]" aria-label={`复核说明 ${object.objectId}`} placeholder="复核说明；拒绝时必填具体问题"
      value={reviewNotes[object.objectId] ?? ''} onChange={(event) => setReviewNotes((prev) => ({ ...prev, [object.objectId]: event.target.value }))} />
    <div className="flex gap-2">
      <Button size="sm" disabled={busy !== null} onClick={() => void submitReview(object, true)}>{busy === object.objectId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}复核通过</Button>
      <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void submitReview(object, false)}><X className="w-3.5 h-3.5" />复核拒绝</Button>
    </div>
  </div>;

  const decisionControls = (object: KbGovernancePendingObjectDto) => {
    const draft = draftOf(object);
    return <div className="space-y-2 border-t border-line/70 pt-2">
      <p className="text-ink-soft leading-relaxed">{object.effectiveDecision?.payloadMismatch
        ? '问题：已有业务决定绑定的是旧版内容，不能自动用于当前内容。请重新核对并决定。'
        : object.businessStatus === 'candidate' ? '问题：这是候选表述，尚未有人工业务批准；请核对正文与来源后再决定是否批准。'
          : '此对象当前没有待裁定问题。可在此主动调整业务状态。'}</p>
      <div className="flex items-center gap-2">
        <label className="shrink-0 text-ink-faint" htmlFor={`kb-gov-target-${object.objectId}`}>处理方式</label>
        <select id={`kb-gov-target-${object.objectId}`} className="rounded border border-line bg-card-bg px-1.5 py-1 text-xs text-ink" value={draft.target}
          onChange={(event) => setDrafts((prev) => ({ ...prev, [object.objectId]: { ...draft, target: event.target.value } }))}>
          {object.allowedDecisionTargets.map((target) => <option key={target} value={target}>{STATUS_LABEL[target] ?? target}</option>)}
        </select>
      </div>
      <p className="text-[10px] text-ink-faint">{decisionEffect(draft.target)}当前正式版不变。{object.highRiskClaims.length && draft.target === 'approved' && !object.humanReviewed ? '此对象还有高风险断言，发布前需完成人工复核。' : ''}</p>
      <textarea className="w-full rounded border border-line bg-card-bg px-2 py-1.5 text-xs text-ink min-h-[48px]" placeholder="决定依据（必填）：说明为何批准或停用" aria-label={`决定理由 ${object.objectId}`}
        value={draft.rationale} onChange={(event) => setDrafts((prev) => ({ ...prev, [object.objectId]: { ...draft, rationale: event.target.value } }))} />
      <Button size="sm" disabled={busy !== null || object.allowedDecisionTargets.length === 0} onClick={() => void submitDecision(object)}>
        {busy === object.objectId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}提交决定
      </Button>
    </div>;
  };

  return <div className="flex-1 min-h-0 overflow-auto scrollbar-thin p-4 space-y-5 text-xs text-ink-soft" data-testid="kb-governance-panel">
    <p className="leading-relaxed">这里处理需要人工判断的候选内容和过期决定。人工决定与复核记录会在下一次成功发布时进入正式版；当前正式文档可以继续阅读。</p>
    {conflict ? <div role="alert" className="rounded border border-seal-2/30 bg-seal-2/5 px-2.5 py-2 text-seal-2 flex items-start gap-1.5" data-testid="kb-gov-conflict"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>决定版本冲突：其他窗口已先提交决定，请刷新后重试。</span></div> : null}
    {notice ? <p role="status" data-testid="kb-gov-notice" className="rounded border border-line bg-paper px-2.5 py-2">{notice}</p> : null}
    {error ? <div role="alert" className="rounded border border-seal-2/30 bg-seal-2/5 px-2.5 py-2 text-seal-2">{error}</div> : null}
    <section className="space-y-2" data-testid="kb-gov-alerts">
      <h4 className="text-ink font-medium">需要业务裁定 <span className="text-seal-2">{alertObjects.length}</span></h4>
      {!pending?.releaseId ? <p className="text-ink-faint">标准库尚未发布；发布后可以处理业务决定。</p> : null}
      {loading && !pending ? <p className="text-ink-faint">加载中…</p> : alertObjects.length === 0 ? <p className="rounded border border-line bg-paper px-3 py-3 text-ink-faint">当前没有需要业务裁定的对象。</p> : <>
        <ul className="space-y-2">{alertObjects.slice(0, actionLimit).map((object) => <ObjectRow key={object.objectId} object={object} onOpenDoc={onOpenDoc}>
          {object.reviewRejection || (object.highRiskClaims.length && !object.humanReviewed && draftOf(object).target === 'approved') ? reviewControls(object) : null}{decisionControls(object)}
        </ObjectRow>)}</ul>
        {alertObjects.length > actionLimit ? <Button size="sm" variant="ghost" onClick={() => setActionLimit((limit) => limit + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, alertObjects.length - actionLimit)} 项</Button> : null}
      </>}
    </section>
    {reviewProblems.length ? <section className="space-y-2 border-t border-line pt-3" data-testid="kb-gov-highrisk">
      <h4 className="font-medium text-seal-2">内容复核未通过 {reviewProblems.length}</h4>
      <ul className="space-y-2">{reviewProblems.slice(0, reviewLimit).map((object) => <ObjectRow key={object.objectId} object={object} onOpenDoc={onOpenDoc}>{reviewControls(object)}</ObjectRow>)}</ul>
      {reviewProblems.length > reviewLimit ? <Button size="sm" variant="ghost" onClick={() => setReviewLimit((limit) => limit + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, reviewProblems.length - reviewLimit)} 项</Button> : null}
    </section> : null}
    <section className="space-y-2 border-t border-line pt-3" data-testid="kb-gov-decisions">
      <h4 className="font-medium text-ink">查找其他对象</h4>
      <p className="text-[11px] text-ink-faint">需要主动批准、停用或恢复某项规则时，在 {governable.length} 个正式对象中搜索。未搜索时不展开全部对象。</p>
      <input className="w-full rounded border border-line bg-card-bg px-2 py-1.5 text-xs text-ink" aria-label="查找治理对象" placeholder="输入标题、文档路径或对象编号" value={objectQuery} disabled={busy === 'batch'}
        onChange={(event) => { setObjectQuery(event.target.value); setObjectLimit(PAGE_SIZE); setSelectedObjects([]); }} />
      {objectQuery.trim() ? <>
        <p className="text-[10px] text-ink-faint">匹配 {matchingObjects.length} 项，当前显示 {Math.min(matchingObjects.length, objectLimit)} 项</p>
        {visibleBatchObjects.length ? <div className="rounded border border-line bg-paper px-3 py-2 space-y-2">
          <p>核对正文与来源后，可批量批准本次选中的对象。业务批准与人工内容复核分别记录，决定在下一次成功发布后生效。</p>
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setSelectedObjects((current) => [...new Set([...current, ...visibleBatchObjects.map((object) => object.objectId)])])}>选择当前显示的可批准对象</Button>
          <span className="ml-2">已选 {selectedObjects.length} 项</span>
          {selectedObjects.length ? <>
            <textarea className="w-full rounded border border-line bg-card-bg px-2 py-1.5 text-xs text-ink min-h-[48px]" aria-label="批量批准依据" placeholder="填写已核对所选内容的共同依据" value={batchRationale} disabled={busy !== null} onChange={(event) => setBatchRationale(event.target.value)} />
            <Button size="sm" disabled={busy !== null} onClick={() => void submitBatch()}>批准所选 {selectedObjects.length} 项</Button>
          </> : null}
        </div> : null}
        <ul className="space-y-2">{matchingObjects.slice(0, objectLimit).map((object) => <ObjectRow key={object.objectId} object={object} onOpenDoc={onOpenDoc}>
          {eligibleForBatch(object) ? <label className="flex items-center gap-1.5"><input type="checkbox" aria-label={`选择批准 ${object.title || object.objectId}`} disabled={busy !== null} checked={selectedObjects.includes(object.objectId)} onChange={(event) => { const checked = event.target.checked; setSelectedObjects((current) => checked ? [...new Set([...current, object.objectId])] : current.filter((id) => id !== object.objectId)); }} />选择此对象</label> : null}
          {object.reviewRejection || (object.highRiskClaims.length && !object.humanReviewed && draftOf(object).target === 'approved') ? reviewControls(object) : null}{decisionControls(object)}
        </ObjectRow>)}</ul>
        {matchingObjects.length > objectLimit ? <Button size="sm" variant="ghost" onClick={() => setObjectLimit((limit) => limit + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, matchingObjects.length - objectLimit)} 项</Button> : null}
      </> : null}
    </section>
    <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading}><RefreshCw className="w-3.5 h-3.5" />刷新治理状态</Button>
  </div>;
}
