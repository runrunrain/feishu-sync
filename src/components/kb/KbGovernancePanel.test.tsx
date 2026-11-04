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
let root: Root;

function makeObject(over: Partial<KbGovernancePendingObjectDto> = {}): KbGovernancePendingObjectDto {
  return {
    objectId: 'ko_objA',
    title: '普攻伤害上限',
    type: 'rule',
    docPath: '战斗/普攻规则.md',
    anchor: 'ko_objA',
    scopeKey: 'combat-global',
    businessStatus: 'candidate',
    reviewStatus: 'passed',
    payloadHash: 'sha256:payload-a',
    reviewSubjectHash: 'sha256:subject-a',
    highRiskClaims: ['cap-300'],
    claimPreviews: [{ claimKey: 'cap-300', excerpt: '普攻伤害上限为 300。', evidenceSources: ['200-战斗数值框架'] }],
    humanReviewed: false,
    reviewRejection: null,
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

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function renderPanel(onOpenDoc?: (path: string, anchor: string | null) => void) {
  await act(async () => {
    root = createRoot(host);
    root.render(<KbGovernancePanel onOpenDoc={onOpenDoc} />);
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
});

it('默认只展示真实待办；高风险无问题不成清单，主动查找仍可核对证据', async () => {
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
    makePending({ candidates: [candidate], staleDecisions: [stale] }, [highRisk, candidate, stale, unknown]),
  );

  await renderPanel();

  expect(api.getKbGovernancePending).toHaveBeenCalled();
  const highRiskSection = host.querySelector('[data-testid="kb-gov-highrisk"]');
  expect(highRiskSection).toBeNull();
  expect(host.textContent).not.toContain('608');
  const alerts = host.querySelector('[data-testid="kb-gov-alerts"]');
  expect(alerts?.querySelector('[data-testid="kb-gov-object-ko_objB"]')).not.toBeNull();
  expect(alerts?.querySelector('[data-testid="kb-gov-object-ko_objC"]')).not.toBeNull();
  expect(alerts?.textContent).toContain('已有业务决定绑定的是旧版内容');
  expect(alerts?.textContent).toContain('下一次成功发布');
  expect(alerts?.querySelector('textarea')).not.toBeNull();
  const decisions = host.querySelector('[data-testid="kb-gov-decisions"]');
  expect(decisions?.querySelector('li')).toBeNull();
  await act(async () => { setInputValue(host.querySelector<HTMLInputElement>('input[aria-label="查找治理对象"]')!, '普攻伤害上限'); });
  expect(decisions?.textContent).toContain('普攻伤害上限为 300');
  expect(decisions?.textContent).toContain('关联断言');
  expect(decisions?.textContent).not.toContain('需核对的断言');
  expect(decisions?.textContent).toContain('200-战斗数值框架');
  expect(decisions?.textContent).toContain('高风险标签本身不表示内容有错');
  await act(async () => { setInputValue(host.querySelector<HTMLInputElement>('input[aria-label="查找治理对象"]')!, '未定规则'); });
  expect(decisions?.querySelector('[data-testid="kb-gov-object-ko_objD"]')).not.toBeNull();
});

it('搜索并人工选择对象后，可用同一依据逐项登记业务批准', async () => {
  const first = makeObject({ objectId: 'ko_one', title: '规则一', businessStatus: 'unknown', highRiskClaims: [] });
  const second = makeObject({ objectId: 'ko_two', title: '规则二', businessStatus: 'unknown', highRiskClaims: [] });
  api.getKbGovernancePending.mockResolvedValue(makePending({}, [first, second]));
  api.listKbGovernanceDecisions.mockResolvedValue({ records: [], effective: [], revision: 5 });
  api.submitKbGovernanceDecision.mockResolvedValueOnce({ revision: 6 }).mockResolvedValueOnce({ revision: 7 });
  await renderPanel();
  expect(host.querySelector('[aria-label="批量批准依据"]')).toBeNull();
  await act(async () => { setInputValue(host.querySelector<HTMLInputElement>('input[aria-label="查找治理对象"]')!, '战斗/普攻规则'); });
  await act(async () => { button('选择当前显示的可批准对象').click(); });
  expect(host.textContent).toContain('已选 2 项');
  await act(async () => { button('批准所选').click(); });
  expect(api.submitKbGovernanceDecision).not.toHaveBeenCalled();
  await act(async () => { setTextareaValue(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="批量批准依据"]')!, '已核对这两项正文与来源。'); });
  await act(async () => { button('批准所选').click(); });
  expect(api.submitKbGovernanceDecision).toHaveBeenNthCalledWith(1, expect.objectContaining({ objectId: 'ko_one', businessStatus: 'approved', expectedRevision: 5 }));
  expect(api.submitKbGovernanceDecision).toHaveBeenNthCalledWith(2, expect.objectContaining({ objectId: 'ko_two', businessStatus: 'approved', expectedRevision: 6 }));
  expect(host.querySelector('[data-testid="kb-gov-notice"]')?.textContent).toContain('已登记 2 项业务批准');
  expect(host.querySelector('[data-testid="kb-gov-notice"]')?.textContent).toContain('下一次成功发布');
});

it('批量批准中途发生冲突时停止并报告已完成数量', async () => {
  const first = makeObject({ objectId: 'ko_one', title: '规则一', businessStatus: 'unknown', highRiskClaims: [] });
  const second = makeObject({ objectId: 'ko_two', title: '规则二', businessStatus: 'unknown', highRiskClaims: [] });
  api.getKbGovernancePending.mockResolvedValue(makePending({}, [first, second]));
  api.submitKbGovernanceDecision.mockResolvedValueOnce({ revision: 1 }).mockRejectedValueOnce(new APIError('版本冲突', 409));
  await renderPanel();
  await act(async () => { setInputValue(host.querySelector<HTMLInputElement>('input[aria-label="查找治理对象"]')!, '战斗/普攻规则'); });
  await act(async () => { button('选择当前显示的可批准对象').click(); });
  await act(async () => { setTextareaValue(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="批量批准依据"]')!, '已核对正文和来源。'); });
  await act(async () => { button('批准所选').click(); });
  expect(api.submitKbGovernanceDecision).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[data-testid="kb-gov-notice"]')?.textContent).toContain('已登记 1/2 项，后续项目未提交');
});

it('批量批准前发现正式版本变化时不提交决定', async () => {
  const object = makeObject({ objectId: 'ko_one', title: '规则一', businessStatus: 'unknown', highRiskClaims: [] });
  api.getKbGovernancePending.mockResolvedValueOnce(makePending({}, [object]))
    .mockResolvedValue(makePending({ releaseId: 'r_new' }, [object]));
  await renderPanel();
  await act(async () => { setInputValue(host.querySelector<HTMLInputElement>('input[aria-label="查找治理对象"]')!, '战斗/普攻规则'); });
  await act(async () => { button('选择当前显示的可批准对象').click(); });
  await act(async () => { setTextareaValue(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="批量批准依据"]')!, '已核对正文和来源。'); });
  await act(async () => { button('批准所选').click(); });
  expect(api.submitKbGovernanceDecision).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="kb-gov-notice"]')?.textContent).toContain('正式版本已变化');
});

it('人工复核提交：通过按钮绑定 objectId + reviewSubjectHash，成功后刷新', async () => {
  const rejected = makeObject({ reviewRejection: '正文数值与来源不一致。' });
  api.getKbGovernancePending.mockResolvedValue(makePending({ highRisk: [rejected] }, [rejected]));
  await renderPanel();

  expect(host.querySelector('[data-testid="kb-gov-highrisk"]')?.textContent).toContain('正文数值与来源不一致');
  await act(async () => { button('复核通过').click(); });
  expect(api.recordKbHumanReview).toHaveBeenCalledWith({
    objectId: 'ko_objA', reviewSubjectHash: 'sha256:subject-a', passed: true,
  });
  expect(host.querySelector('[data-testid="kb-gov-notice"]')?.textContent).toContain('复核通过');
});

it('断言可打开正式正文；拒绝必须说明问题并记录复核说明', async () => {
  const onOpenDoc = vi.fn();
  const rejected = makeObject({ reviewRejection: '待核对数值。' });
  api.getKbGovernancePending.mockResolvedValue(makePending({ highRisk: [rejected] }, [rejected]));
  await renderPanel(onOpenDoc);
  await act(async () => { button('查看正文').click(); });
  expect(onOpenDoc).toHaveBeenCalledWith('战斗/普攻规则.md', 'ko_objA');
  await act(async () => { button('复核拒绝').click(); });
  expect(api.recordKbHumanReview).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="kb-gov-notice"]')?.textContent).toContain('写明正文或证据的问题');
  await act(async () => { setTextareaValue(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="复核说明 ko_objA"]')!, '来源数值和正文不一致'); });
  await act(async () => { button('复核拒绝').click(); });
  expect(api.recordKbHumanReview).toHaveBeenCalledWith({
    objectId: 'ko_objA', reviewSubjectHash: 'sha256:subject-a', passed: false,
    note: '来源数值和正文不一致',
  });
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
  await act(async () => { setInputValue(host.querySelector<HTMLInputElement>('input[aria-label="查找治理对象"]')!, '未定规则'); });
  const rationaleD = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="决定理由 ko_objD"]')!;
  await act(async () => { setTextareaValue(rationaleD, '批准未定规则。'); });
  await act(async () => {
    ([...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('提交决定')
      && b.closest('li')?.dataset.testid === 'kb-gov-object-ko_objD')!).click();
  });
  expect(api.submitKbGovernanceDecision).toHaveBeenCalledWith(expect.objectContaining({
    objectId: 'ko_objD', businessStatus: 'approved', rationale: '批准未定规则。',
  }));

  await act(async () => { setInputValue(host.querySelector<HTMLInputElement>('input[aria-label="查找治理对象"]')!, '旧规则'); });
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
