/**
 * KbGovernancePanel 组件测试（D1；diting S-F04/S-F05 增补）—— jsdom 交互锚定：
 * 待治理分组渲染（高风险人审 / 待裁定提示 / 可操作对象 governable）、人工复核
 * 提交参数、业务决定提交（rationale 必填校验 + expectedRevision + supersede 链
 * ——存在有效决定时始终携带 supersedesDecisionId，含 stale 旧载荷决定重绑）、
 * unknown 对象出现在可操作分区并可按服务端 targets 提交、409 冲突提示与刷新
 * 引导。api/client 全 mock（BuildOrchestrationProgress.test.tsx 同法；真实
 * 服务 round-trip 见 server/tests/governance-seam.test.ts）。
 */

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getKbGovernancePending: vi.fn(),
  listKbGovernanceDecisions: vi.fn(),
  submitKbGovernanceDecision: vi.fn(),
  listKbHumanReviews: vi.fn(),
  recordKbHumanReview: vi.fn(),
}));
vi.mock('../../api/client', () => ({
  ...api,
  APIError: class APIError extends Error {
    statusCode?: number;
    response?: unknown;
    constructor(message: string, statusCode?: number, response?: unknown) {
      super(message);
      this.name = 'APIError';
      this.statusCode = statusCode;
      this.response = response;
    }
  },
}));

import { KbGovernancePanel } from './KbGovernancePanel';
import { APIError } from '../../api/client';
import type { KbGovernancePendingDto, KbGovernancePendingObjectDto } from '../../types/agent';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
document.body.appendChild(host);
let root: Root = createRoot(host);

function makeObject(over: Partial<KbGovernancePendingObjectDto> = {}): KbGovernancePendingObjectDto {
  return {
    objectId: 'ko_objA',
    title: '普攻伤害上限',
    type: 'rule',
    scopeKey: 'combat-global',
    businessStatus: 'candidate',
    reviewStatus: 'passed',
    payloadHash: 'sha256:payload-a',
    reviewSubjectHash: 'sha256:subject-a',
    highRiskClaims: ['cap-300'],
    humanReviewed: false,
    effectiveDecision: null,
    allowedDecisionTargets: ['approved'],
    ...over,
  };
}

function makePending(over: Partial<KbGovernancePendingDto> = {}, governable: KbGovernancePendingObjectDto[] = []): KbGovernancePendingDto {
  return {
    releaseId: 'r_gov1',
    highRisk: [],
    candidates: [],
    staleDecisions: [],
    // diting S-F04：可操作对象分区数据源（服务端 governable 列表）
    governable,
    transitionTable: { candidate: ['approved'], approved: ['deprecated', 'approved'] },
    ...over,
  };
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

async function renderPanel() {
  await act(async () => {
    root = createRoot(host);
    root.render(<KbGovernancePanel />);
  });
}

beforeEach(() => {
  api.getKbGovernancePending.mockReset().mockResolvedValue(makePending());
  api.listKbGovernanceDecisions.mockReset().mockResolvedValue({ records: [], effective: [], revision: 0 });
  api.submitKbGovernanceDecision.mockReset();
  api.recordKbHumanReview.mockReset().mockResolvedValue({ review: { reviewId: 'kbr_1' } });
});

afterEach(() => {
  act(() => root.unmount());
  root = createRoot(host);
});

it('待治理分组渲染：高风险人审 / 待裁定提示（candidate+stale）/ 可操作对象（governable 全量）', async () => {
  const highRisk = makeObject();
  const candidate = makeObject({
    objectId: 'ko_objB', title: '作战单元', type: 'concept', highRiskClaims: [],
    businessStatus: 'candidate',
  });
  const unknown = makeObject({
    objectId: 'ko_objD', title: '未定规则', type: 'rule', highRiskClaims: [],
    businessStatus: 'unknown',
  });
  const stale = makeObject({
    objectId: 'ko_objC', title: '旧规则', highRiskClaims: [],
    businessStatus: 'unknown', allowedDecisionTargets: ['deprecated', 'approved'],
    effectiveDecision: { decisionId: 'kbd_old', businessStatus: 'approved', createdAt: '2026-11-01T00:00:00Z', payloadMismatch: true },
  });
  api.getKbGovernancePending.mockResolvedValue(
    makePending({ highRisk: [highRisk], candidates: [candidate], staleDecisions: [stale] }, [highRisk, candidate, stale, unknown]),
  );

  await renderPanel();

  expect(api.getKbGovernancePending).toHaveBeenCalled();
  const highRiskSection = host.querySelector('[data-testid="kb-gov-highrisk"]');
  expect(highRiskSection?.textContent).toContain('高风险人工复核');
  expect(highRiskSection?.textContent).toContain('cap-300');
  expect(highRiskSection?.querySelector('[data-testid="kb-gov-object-ko_objA"]')).not.toBeNull();
  // diting S-F04：candidate + stale 进入待裁定提示（提示语义，无表单）
  const alerts = host.querySelector('[data-testid="kb-gov-alerts"]');
  expect(alerts?.querySelector('[data-testid="kb-gov-object-ko_objB"]')).not.toBeNull();
  expect(alerts?.querySelector('[data-testid="kb-gov-object-ko_objC"]')).not.toBeNull();
  expect(alerts?.textContent).toContain('决定过期');
  expect(alerts?.querySelector('textarea')).toBeNull();
  // 可操作对象：governable 全量（含 unknown 与高风险对象——业务决定通道合法）
  const decisions = host.querySelector('[data-testid="kb-gov-decisions"]');
  expect(decisions?.querySelector('[data-testid="kb-gov-object-ko_objA"]')).not.toBeNull();
  expect(decisions?.querySelector('[data-testid="kb-gov-object-ko_objC"]')).not.toBeNull();
  expect(decisions?.querySelector('[data-testid="kb-gov-object-ko_objD"]')).not.toBeNull();
  expect(decisions?.textContent).toContain('取代旧决定');
});

it('人工复核提交：通过按钮绑定 objectId + reviewSubjectHash，成功后刷新', async () => {
  api.getKbGovernancePending.mockResolvedValue(makePending({ highRisk: [makeObject()] }, [makeObject()]));
  await renderPanel();

  await act(async () => { button('复核通过').click(); });
  expect(api.recordKbHumanReview).toHaveBeenCalledWith({
    objectId: 'ko_objA', reviewSubjectHash: 'sha256:subject-a', passed: true,
  });
  expect(host.querySelector('[data-testid="kb-gov-notice"]')?.textContent).toContain('复核通过');
});

it('业务决定提交：空理由拦截；填写后按 expectedRevision 提交并提示待发布生效', async () => {
  const object = makeObject({ highRiskClaims: [] });
  api.getKbGovernancePending.mockResolvedValue(makePending({ candidates: [object] }, [object]));
  api.submitKbGovernanceDecision.mockResolvedValue({ decision: { decisionId: 'kbd_1' }, revision: 1 });
  await renderPanel();

  // 空理由 → 拦截，不调 API
  await act(async () => { button('提交决定').click(); });
  expect(api.submitKbGovernanceDecision).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="kb-gov-notice"]')?.textContent).toContain('实质理由');

  const rationale = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="决定理由 ko_objA"]')!;
  await act(async () => { setTextareaValue(rationale, '设计负责人核对源文档后批准上限规则。'); });
  await act(async () => { button('提交决定').click(); });
  expect(api.submitKbGovernanceDecision).toHaveBeenCalledWith(expect.objectContaining({
    objectId: 'ko_objA',
    payloadHash: 'sha256:payload-a',
    scopeKey: 'combat-global',
    businessStatus: 'approved',
    rationale: '设计负责人核对源文档后批准上限规则。',
    expectedRevision: 0,
  }));
  expect(api.submitKbGovernanceDecision).toHaveBeenCalledWith(expect.not.objectContaining({ supersedesDecisionId: expect.anything() }));
  expect(host.querySelector('[data-testid="kb-gov-notice"]')?.textContent).toContain('决定待发布');
});

it('diting S-F04：unknown 对象出现在可操作分区，按服务端 targets 提交 approved；diting S-F05：stale 旧载荷决定重绑始终携带 supersedesDecisionId', async () => {
  const unknown = makeObject({
    objectId: 'ko_objD', title: '未定规则', highRiskClaims: [],
    businessStatus: 'unknown', allowedDecisionTargets: ['approved'],
  });
  const stale = makeObject({
    objectId: 'ko_objC', title: '旧规则', highRiskClaims: [],
    businessStatus: 'unknown', allowedDecisionTargets: ['deprecated', 'approved'],
    effectiveDecision: { decisionId: 'kbd_old', businessStatus: 'approved', createdAt: '2026-11-01T00:00:00Z', payloadMismatch: true },
  });
  api.getKbGovernancePending.mockResolvedValue(makePending({ staleDecisions: [stale] }, [unknown, stale]));
  api.submitKbGovernanceDecision.mockResolvedValue({ decision: { decisionId: 'kbd_2' }, revision: 1 });
  await renderPanel();

  // unknown → approved（治理生命周期入口：真实服务 targets = ['approved']）
  const rationaleD = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="决定理由 ko_objD"]')!;
  await act(async () => { setTextareaValue(rationaleD, '批准未定规则。'); });
  await act(async () => {
    ([...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('提交决定')
      && b.closest('li')?.dataset.testid === 'kb-gov-object-ko_objD')!).click();
  });
  expect(api.submitKbGovernanceDecision).toHaveBeenCalledWith(expect.objectContaining({
    objectId: 'ko_objD', businessStatus: 'approved', rationale: '批准未定规则。',
  }));

  // stale 分支：payloadMismatch=true 也必须携带旧决定 ID（服务端按有效链裁决）；
  // 默认目标为链状态 targets[0]=deprecated，先切换到 approved 验证选择器交互
  const selectC = host.querySelector<HTMLSelectElement>('#kb-gov-target-ko_objC')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(selectC, 'approved');
    selectC.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const rationaleC = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="决定理由 ko_objC"]')!;
  await act(async () => { setTextareaValue(rationaleC, '新载荷上重新批准。'); });
  await act(async () => {
    ([...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('提交决定')
      && b.closest('li')?.dataset.testid === 'kb-gov-object-ko_objC')!).click();
  });
  expect(api.submitKbGovernanceDecision).toHaveBeenCalledWith(expect.objectContaining({
    objectId: 'ko_objC',
    businessStatus: 'approved',
    supersedesDecisionId: 'kbd_old',
  }));
});

it('409 版本冲突：显示冲突提示并引导刷新', async () => {
  const object = makeObject({ highRiskClaims: [] });
  api.getKbGovernancePending.mockResolvedValue(makePending({ candidates: [object] }, [object]));
  api.submitKbGovernanceDecision.mockRejectedValue(new APIError('决定集已变化', 409, { error: 'kb_decision_revision_conflict' }));
  await renderPanel();

  const rationale = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="决定理由 ko_objA"]')!;
  await act(async () => { setTextareaValue(rationale, '理由'); });
  await act(async () => { button('提交决定').click(); });
  expect(host.querySelector('[data-testid="kb-gov-conflict"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="kb-gov-conflict"]')?.textContent).toContain('版本冲突');
});
