/**
 * KbGovernancePanel —— 标准库侧栏「治理」面板（D1，A 案 §4.2/§5.1）。
 *
 * 人工复核与业务决定入口（仅 desktop 人工通道；CLI/Agent 不获得写权限）：
 * - 高风险人审：riskCategory=high 且无绑定当前载荷 human 凭据的对象，
 *   「通过/拒绝」提交人工内容复核（A 案 §5.1：高风险断言至少一次人工复核；
 *   diting S-F03：最新拒绝覆盖历史通过，拒绝即阻断下次发布）；
 * - 待裁定提示（diting S-F04）：candidate 对象与决定过期对象的紧凑提示分区
 *  （无表单——操作统一在「可操作对象」分区完成）；
 * - 可操作对象（diting S-F04）：当前 release 全部活跃对象（governable，
 *   含 unknown/approved/deprecated）的业务决定表单——合法转移目标由服务端
 *   按有效决定链状态计算（diting S-F05，与 recordDecision 同源）；存在有效
 *   决定时提交始终携带 supersedesDecisionId（payloadMismatch 与否都带，
 *   服务端按有效链裁决），消灭「targets=approved 但服务要求 supersede」的
 *   两端不一致；
 * - 决定对标准库消费者的生效点是下一次成功发布（UI 明示「决定待发布」，
 *   不把运行期决定叠加进旧 release，A 案 §4.2）。
 * 数据源：GET /api/kb/governance/pending + decisions（revision 随行）；
 * UI 模式对齐 KbPublishPanel/BuildOrchestrationProgress（jsdom 测试锚定）。
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, RefreshCw, X } from 'lucide-react';
import { Button } from '../common/Button';
import {
  APIError,
  getKbGovernancePending,
  listKbGovernanceDecisions,
  recordKbHumanReview,
  submitKbGovernanceDecision,
} from '../../api/client';
import type {
  KbGovernancePendingDto,
  KbGovernancePendingObjectDto,
} from '../../types/agent';

const STATUS_LABEL: Record<string, string> = {
  unknown: '未定', candidate: '候选', approved: '已批准', disputed: '有争议', deprecated: '已停用',
};

function shortHash(hash: string): string {
  return hash ? `${hash.slice(0, 10)}…` : '';
}

function ObjectRow({ object, children }: { object: KbGovernancePendingObjectDto; children?: React.ReactNode }) {
  return (
    <li className="rounded border border-line bg-paper px-2.5 py-2 space-y-1.5" data-testid={`kb-gov-object-${object.objectId}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ink truncate" title={object.objectId}>{object.title || object.objectId}</span>
        <span className="text-[10px] text-ink-faint shrink-0">{object.objectId}</span>
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-ink-faint">
        <span>业务状态 {STATUS_LABEL[object.businessStatus] ?? object.businessStatus}</span>
        <span>审查 {object.reviewStatus}</span>
        <span className="break-all">范围 {object.scopeKey}</span>
        {object.highRiskClaims.length > 0 ? <span className="text-seal-2">高风险断言 {object.highRiskClaims.join(', ')}</span> : null}
      </div>
      {children}
    </li>
  );
}

interface DecisionDraft {
  target: string;
  rationale: string;
}

export function KbGovernancePanel() {
  const [pending, setPending] = useState<KbGovernancePendingDto | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pendingData, decisions] = await Promise.all([
        getKbGovernancePending(),
        listKbGovernanceDecisions(),
      ]);
      setPending(pendingData);
      setRevision(decisions.revision);
      setConflict(false);
    } catch (err) {
      setError(err instanceof APIError ? err.message : '治理状态加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const draftOf = (object: KbGovernancePendingObjectDto): DecisionDraft =>
    drafts[object.objectId] ?? { target: object.allowedDecisionTargets[0] ?? 'approved', rationale: '' };

  const submitDecision = async (object: KbGovernancePendingObjectDto) => {
    const draft = draftOf(object);
    if (!draft.rationale.trim()) {
      setNotice('业务决定必须填写实质理由（rationale 必填）。');
      return;
    }
    setBusy(object.objectId);
    setNotice(null);
    try {
      await submitKbGovernanceDecision({
        objectId: object.objectId,
        payloadHash: object.payloadHash,
        scopeKey: object.scopeKey,
        businessStatus: draft.target as KbGovernancePendingObjectDto['businessStatus'],
        rationale: draft.rationale.trim(),
        // diting S-F05：存在有效决定（含旧载荷 stale 决定）时始终携带被取
        // 代决定的 decisionId——服务端按有效决定链裁决重绑；旧实现仅在
        // 非 payloadMismatch 时携带，恰在需要重绑的 stale 分支缺失导致 400。
        ...(object.effectiveDecision ? { supersedesDecisionId: object.effectiveDecision.decisionId } : {}),
        expectedRevision: revision,
      });
      setDrafts((prev) => { const next = { ...prev }; delete next[object.objectId]; return next; });
      setNotice(`已登记业务决定（${object.title || object.objectId} → ${STATUS_LABEL[draft.target] ?? draft.target}）；决定待发布——生效点是下一次成功构建发布。`);
      await load();
    } catch (err) {
      if (err instanceof APIError && err.statusCode === 409) {
        setConflict(true);
        setNotice('决定集已被并发修改（版本冲突），请刷新后基于最新状态重试。');
      } else {
        setNotice(err instanceof APIError ? err.message : '决定提交失败');
      }
    } finally {
      setBusy(null);
    }
  };

  const submitReview = async (object: KbGovernancePendingObjectDto, passed: boolean) => {
    setBusy(object.objectId);
    setNotice(null);
    try {
      await recordKbHumanReview({ objectId: object.objectId, reviewSubjectHash: object.reviewSubjectHash, passed });
      setNotice(`已记录人工复核${passed ? '通过' : '拒绝'}（${object.title || object.objectId}）。`);
      await load();
    } catch (err) {
      setNotice(err instanceof APIError ? err.message : '人工复核提交失败');
    } finally {
      setBusy(null);
    }
  };

  const highRisk = pending?.highRisk ?? [];
  const candidates = pending?.candidates ?? [];
  const stale = pending?.staleDecisions ?? [];
  // diting S-F04：可操作对象 = 服务端 governable 列表（当前 release 全部
  // 活跃对象）；旧后端未返回该字段时回退 candidates+stale（兼容窗口）。
  const governable = pending?.governable ?? [...new Map([...candidates, ...stale].map((object) => [object.objectId, object])).values()];
  const alertObjects = [...new Map([...candidates, ...stale].map((object) => [object.objectId, object])).values()];

  return (
    <div className="flex-1 min-h-0 overflow-auto scrollbar-thin p-4 space-y-4 text-xs text-ink-soft" data-testid="kb-governance-panel">
      <p className="leading-relaxed">
        人工复核与业务裁定（A 案 §4.2/§5.1）：高风险断言至少一次人工内容复核；批准/停用/恢复使用由人工决定产生。
        决定生效点是<b className="text-ink">下一次成功发布</b>，不叠加进旧版本。
      </p>

      {conflict ? <div role="alert" className="rounded border border-seal-2/30 bg-seal-2/5 px-2.5 py-2 text-seal-2 flex items-start gap-1.5" data-testid="kb-gov-conflict">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>决定版本冲突（409）：他人或其它窗口已先提交决定，请刷新后重试。</span>
      </div> : null}
      {notice ? <p role="status" data-testid="kb-gov-notice" className="rounded border border-line bg-paper px-2.5 py-2 text-ink-soft">{notice}</p> : null}
      {error ? <div role="alert" className="rounded border border-seal-2/30 bg-seal-2/5 px-2.5 py-2 text-seal-2">{error}</div> : null}

      <section className="space-y-2" data-testid="kb-gov-highrisk">
        <h4 className="text-ink font-medium flex items-center gap-1.5">
          高风险人工复核 <span className="text-seal-2">{highRisk.length}</span>
        </h4>
        {loading && highRisk.length === 0 ? <p className="text-ink-faint">加载中…</p>
          : highRisk.length === 0 ? <p className="text-ink-faint">无待复核的高风险对象。</p>
            : <ul className="space-y-2">
              {highRisk.map((object) => (
                <ObjectRow key={object.objectId} object={object}>
                  <div className="flex items-center gap-2">
                    <Button size="sm" disabled={busy === object.objectId} onClick={() => void submitReview(object, true)}>
                      {busy === object.objectId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}复核通过
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy === object.objectId} onClick={() => void submitReview(object, false)}>
                      <X className="w-3.5 h-3.5" />复核拒绝
                    </Button>
                    <span className="text-[10px] text-ink-faint">绑定载荷 {shortHash(object.reviewSubjectHash)}</span>
                  </div>
                </ObjectRow>
              ))}
            </ul>}
      </section>

      <section className="space-y-2 border-t border-line pt-3" data-testid="kb-gov-alerts">
        <h4 className="text-ink font-medium flex items-center gap-1.5">
          待裁定提示 <span className="text-seal-2">{alertObjects.length}</span>
        </h4>
        {(pending && pending.releaseId) ? null : <p className="text-[10px] text-ink-faint">标准库尚未发布：发布后可对对象做业务决定。</p>}
        {alertObjects.length === 0 ? (loading ? <p className="text-ink-faint">加载中…</p> : <p className="text-ink-faint">无待裁定的对象。</p>)
          : <ul className="space-y-1.5">
            {alertObjects.map((object) => (
              <ObjectRow key={object.objectId} object={object}>
                {object.effectiveDecision?.payloadMismatch ? (
                  <p className="text-[10px] text-seal-2">决定过期：现有决定绑定旧载荷（{shortHash(object.effectiveDecision.decisionId)}），需在下方「可操作对象」重新决定。</p>
                ) : (
                  <p className="text-[10px] text-ink-faint">候选对象待业务决定：在下方「可操作对象」分区提交。</p>
                )}
              </ObjectRow>
            ))}
          </ul>}
      </section>

      <section className="space-y-2 border-t border-line pt-3" data-testid="kb-gov-decisions">
        <h4 className="text-ink font-medium flex items-center gap-1.5">
          可操作对象 <span className="text-seal-2">{governable.length}</span>
          <span className="text-[10px] text-ink-faint font-normal">（决定集 revision {revision}）</span>
        </h4>
        {(pending && pending.releaseId) ? null : <p className="text-[10px] text-ink-faint">标准库尚未发布：发布后可对对象做业务决定。</p>}
        {governable.length === 0 ? (loading ? <p className="text-ink-faint">加载中…</p> : <p className="text-ink-faint">无可操作对象（当前 release 无活跃对象）。</p>)
          : <ul className="space-y-2">
            {governable.map((object) => {
              const draft = draftOf(object);
              return (
                <ObjectRow key={object.objectId} object={object}>
                  {object.effectiveDecision?.payloadMismatch ? (
                    <p className="text-[10px] text-seal-2">现有决定绑定旧载荷（{shortHash(object.effectiveDecision.decisionId)}），本次提交将取代旧决定并在新载荷上生效。</p>
                  ) : null}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <label className="text-ink-faint shrink-0" htmlFor={`kb-gov-target-${object.objectId}`}>裁定</label>
                      <select
                        id={`kb-gov-target-${object.objectId}`}
                        className="rounded border border-line bg-card-bg px-1.5 py-1 text-xs text-ink"
                        value={draft.target}
                        onChange={(event) => setDrafts((prev) => ({ ...prev, [object.objectId]: { ...draft, target: event.target.value } }))}
                      >
                        {object.allowedDecisionTargets.map((target) => (
                          <option key={target} value={target}>{STATUS_LABEL[target] ?? target}</option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      className="rounded border border-line bg-card-bg px-2 py-1 text-xs text-ink min-h-[44px]"
                      placeholder="实质理由（必填）：批准/停用的依据，随 release 冻结"
                      aria-label={`决定理由 ${object.objectId}`}
                      value={draft.rationale}
                      onChange={(event) => setDrafts((prev) => ({ ...prev, [object.objectId]: { ...draft, rationale: event.target.value } }))}
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" disabled={busy === object.objectId} onClick={() => void submitDecision(object)}>
                        {busy === object.objectId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}提交决定
                      </Button>
                      <span className="text-[10px] text-ink-faint">提交后待发布生效</span>
                    </div>
                  </div>
                </ObjectRow>
              );
            })}
          </ul>}
      </section>

      <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading}>
        <RefreshCw className="w-3.5 h-3.5" />刷新治理状态
      </Button>
    </div>
  );
}
