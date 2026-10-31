/**
 * BuildOrchestrationProgress 组件测试（T5b）—— jsdom 交互锚定：
 * 任务流水按角色分组渲染（三轴徽标/等待原因/修订轮次与预算/阻断计数）、
 * reviewSummary 四计数卡片、spec 摘要（发布方式/N 路/角色模型）、旧式构建
 * 404 降级、awaiting_release 确认面板（候选摘要 + 确认成功回调 + 409
 * kb_confirm_stale 失效提示与刷新引导）。api/client 全 mock（KbPublishModal
 * .mount.test.tsx 同法）；轮询只在非终态进行，初始拉取即可锚定。
 */

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getKbBuildOrchestration: vi.fn(), confirmKbRelease: vi.fn() }));
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

import { BuildOrchestrationProgress } from './BuildOrchestrationProgress';
import type { KbBuildDto, KbBuildOrchestrationDto, KbBuildOrchestrationTaskDto } from '../../types/agent';
import { APIError } from '../../api/client';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
document.body.appendChild(host);
let root: Root = createRoot(host);

function makeTask(over: Partial<KbBuildOrchestrationTaskDto> = {}): KbBuildOrchestrationTaskDto {
  return {
    taskId: 't:write:u1',
    role: 'write',
    unitId: 'u1',
    revision: 0,
    round: 0,
    attempt: 0,
    execState: 'running',
    artifactState: 'pending',
    acceptanceState: 'unreviewed',
    waitingOn: [],
    model: { modelPresetId: 'glm-w', thinking: 'high' },
    revisionBudget: { usedAutoRevisions: 0, maxAutoRevisions: 2 },
    blockingIssues: 0,
    ...over,
  };
}

function makeOrch(over: Partial<KbBuildOrchestrationDto> = {}): KbBuildOrchestrationDto {
  return {
    buildId: 'kb-b1',
    spec: { specHash: 'hash-1', publishMode: 'confirm', concurrency: 2, maxAutoRevisions: 2, maxInterfaceRetries: 2 },
    ended: false,
    endReason: null,
    tasks: [],
    reviewSummary: {
      unitsWritten: 4,
      unitsReviewed: 3,
      unitsPendingRevision: 1,
      integration: { integratePassed: true, finalReviewDone: true, carriedOverDocs: 2 },
    },
    lateReceiptCount: 0,
    interfaceRetryTotal: 1,
    autoRevisionUsage: {},
    ...over,
  };
}

function makeBuild(over: Partial<KbBuildDto> = {}): KbBuildDto {
  return {
    id: 'kb-b1',
    mode: 'incremental',
    status: 'running',
    noChanges: false,
    baseReleaseId: null,
    releaseId: null,
    model: 'glm-4.7',
    counts: { sourceTotal: 30, added: 2, changed: 1, removed: 0, docsWritten: 12, docsDeleted: 0 },
    progress: {
      batchIndex: 2, batchTotal: 6, stage: 'reviewing',
      units: { total: 4, done: 3, running: 1, failed: 0, retried: 0 },
      workers: [], images: { total: 0, described: 0, cached: 0, unavailable: 0 },
    },
    parallelism: 2,
    warnings: [],
    error: null,
    createdAt: '2026-11-01T10:00:00Z',
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  api.getKbBuildOrchestration.mockReset().mockResolvedValue(makeOrch());
  api.confirmKbRelease.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  root = createRoot(host);
});

it('任务流水按角色分组渲染：三轴徽标、等待原因、修订轮次/预算、阻断计数', async () => {
  api.getKbBuildOrchestration.mockResolvedValue(makeOrch({
    tasks: [
      makeTask({ taskId: 't:write:u1:r0', unitId: 'u1', execState: 'running', model: { modelPresetId: 'glm-w', thinking: 'high' } }),
      makeTask({
        taskId: 't:write:u2:r1', unitId: 'u2', round: 1, execState: 'queued',
        acceptanceState: 'needs_revision',
        waitingOn: ['t:review:u2:r0（等待产物可用，当前 artifact=pending）'],
        revisionBudget: { usedAutoRevisions: 1, maxAutoRevisions: 2 },
        blockingIssues: 2,
      }),
      makeTask({ taskId: 't:review:u1:r0', role: 'review', unitId: 'u1', execState: 'done', artifactState: 'available', acceptanceState: 'passed', model: { modelPresetId: '' }, revisionBudget: null }),
      makeTask({ taskId: 't:integrate:r0#1', role: 'integrate', unitId: null, execState: 'queued', attempt: 1, revisionBudget: { usedAutoRevisions: 0, maxAutoRevisions: 2 } }),
      makeTask({ taskId: 't:final:all', role: 'final_review', unitId: null, execState: 'done', artifactState: 'available', acceptanceState: 'pending_decision' }),
    ],
  }));
  await act(async () => { root = createRoot(host); root.render(<BuildOrchestrationProgress build={makeBuild()} />); });

  expect(api.getKbBuildOrchestration).toHaveBeenCalledWith('kb-b1');
  // 分组：撰写/审查/整合/最终复核存在；规划（无任务）不渲染。
  expect(host.querySelector('[data-role-group="write"]')).not.toBeNull();
  expect(host.querySelector('[data-role-group="review"]')).not.toBeNull();
  expect(host.querySelector('[data-role-group="integrate"]')).not.toBeNull();
  expect(host.querySelector('[data-role-group="final_review"]')).not.toBeNull();
  expect(host.querySelector('[data-role-group="plan"]')).toBeNull();
  expect(host.querySelectorAll('[data-task-id]')).toHaveLength(5);

  // 三轴徽标（分色 data 属性 + 中文文案）。
  const running = host.querySelector('[data-task-id="t:write:u1:r0"]');
  expect(running?.getAttribute('data-exec')).toBe('running');
  expect(running?.textContent).toContain('执行中');
  expect(running?.textContent).toContain('待生成');
  expect(running?.textContent).toContain('待审');
  const reviewed = host.querySelector('[data-task-id="t:review:u1:r0"]');
  expect(reviewed?.getAttribute('data-acceptance')).toBe('passed');
  expect(reviewed?.textContent).toContain('完成');
  expect(reviewed?.textContent).toContain('可用');
  expect(reviewed?.textContent).toContain('通过');

  // 等待原因三分类：依赖未满足 / 名额等待 / 等待人工。
  expect(host.querySelector('[data-task-id="t:write:u2:r1"]')?.textContent).toContain('依赖未满足（1）');
  expect(host.querySelector('[data-task-id="t:write:u2:r1"]')?.getAttribute('data-waiting')).toBe('dependency');
  expect(host.querySelector('[data-task-id="t:integrate:r0#1"]')?.textContent).toContain('等待构建名额');
  expect(host.querySelector('[data-task-id="t:integrate:r0#1"]')?.getAttribute('data-waiting')).toBe('capacity');
  expect(host.querySelector('[data-task-id="t:final:all"]')?.textContent).toContain('等待人工裁定');
  expect(host.querySelector('[data-task-id="t:final:all"]')?.getAttribute('data-waiting')).toBe('human');

  // 修订轮次/预算/阻断计数。
  expect(host.querySelector('[data-task-id="t:write:u2:r1"]')?.textContent).toContain('修订 r1');
  expect(host.querySelector('[data-task-id="t:write:u2:r1"]')?.textContent).toContain('修订 1/2');
  expect(host.querySelector('[data-task-id="t:write:u2:r1"]')?.textContent).toContain('阻断 2');

  // 整合/最终复核无单元标识的展示。
  expect(host.querySelector('[data-task-id="t:integrate:r0#1"]')?.textContent).toContain('全部单元');

  // 分组头部模型：审查=跟随活跃预设；撰写带思考档位。
  expect(host.querySelector('[data-role-group="write"]')?.textContent).toContain('glm-w（高）');
  expect(host.querySelector('[data-role-group="review"]')?.textContent).toContain('跟随活跃预设');
});

it('reviewSummary 四计数卡片与整合/最终复核标记', async () => {
  await act(async () => { root = createRoot(host); root.render(<BuildOrchestrationProgress build={makeBuild()} />); });
  const summary = host.querySelector('[data-testid="kb-orch-summary"]');
  expect(summary).not.toBeNull();
  expect(summary?.textContent).toContain('已写');
  expect(summary?.textContent).toContain('4');
  expect(summary?.textContent).toContain('已审');
  expect(summary?.textContent).toContain('3');
  expect(summary?.textContent).toContain('待修订');
  expect(summary?.textContent).toContain('1');
  expect(summary?.textContent).toContain('沿用');
  expect(summary?.textContent).toContain('2 篇');
  expect(summary?.textContent).toContain('整合通过');
  expect(summary?.textContent).toContain('最终复核完成');
});

it('spec 摘要：发布方式 / N 路 / 角色模型（冻结 BuildSpec）', async () => {
  api.getKbBuildOrchestration.mockResolvedValue(makeOrch({
    spec: { specHash: 'hash-2', publishMode: 'auto', concurrency: 4, maxAutoRevisions: 3, maxInterfaceRetries: 2 },
    tasks: [
      makeTask({ taskId: 't:write:u1:r0', model: { modelPresetId: 'glm-w' } }),
      makeTask({ taskId: 't:review:u1:r0', role: 'review', execState: 'done', artifactState: 'available', acceptanceState: 'passed', model: { modelPresetId: 'glm-r', thinking: 'low' } }),
    ],
  }));
  await act(async () => { root = createRoot(host); root.render(<BuildOrchestrationProgress build={makeBuild()} />); });
  const spec = host.querySelector('[data-testid="kb-orch-spec"]');
  expect(spec?.textContent).toContain('自动整版发布');
  expect(spec?.textContent).toContain('并发 4 路');
  expect(spec?.textContent).toContain('撰写 glm-w');
  expect(spec?.textContent).toContain('审查 glm-r（低）');
  // 无 integrate 任务时不显示整合模型。
  expect(spec?.textContent).not.toContain('整合 ');
  // 接口重试计数可见。
  expect(spec?.textContent).toContain('接口重试 1');
});

it('旧式构建降级：端点 404 显示说明行，不再报错', async () => {
  api.getKbBuildOrchestration.mockRejectedValue(new APIError('构建不存在或无编排数据', 404, { error: 'build_not_found' }));
  await act(async () => { root = createRoot(host); root.render(<BuildOrchestrationProgress build={makeBuild()} />); });
  expect(host.querySelector('[data-testid="kb-orch-legacy"]')?.textContent).toContain('旧式构建（未启用编排流水）');
  expect(host.querySelector('[data-testid="kb-orch-progress"]')).toBeNull();
});

it('非 awaiting 状态不渲染确认面板', async () => {
  await act(async () => { root = createRoot(host); root.render(<BuildOrchestrationProgress build={makeBuild({ status: 'running' })} />); });
  expect(host.querySelector('[data-testid="kb-orch-awaiting"]')).toBeNull();
});

it('awaiting_release 确认面板：候选摘要 + 确认成功回调新构建 DTO', async () => {
  const published = makeBuild({ status: 'published', releaseId: 'r_20261101' });
  api.confirmKbRelease.mockResolvedValue(published);
  const onBuildUpdated = vi.fn();
  await act(async () => { root = createRoot(host); root.render(<BuildOrchestrationProgress build={makeBuild({ status: 'awaiting_release' })} onBuildUpdated={onBuildUpdated} />); });

  const panel = host.querySelector('[data-testid="kb-orch-awaiting"]');
  expect(panel).not.toBeNull();
  expect(panel?.textContent).toContain('候选就绪 · 等待确认发布');
  // 候选摘要：文档数（写入+沿用）/变更说明/已审查范围 vs 沿用范围。
  expect(host.querySelector('[data-testid="kb-orch-candidate-docs"]')?.textContent).toContain('本轮写入 12 篇');
  expect(host.querySelector('[data-testid="kb-orch-candidate-docs"]')?.textContent).toContain('沿用未改动 2 篇');
  expect(host.querySelector('[data-testid="kb-orch-candidate-changes"]')?.textContent).toContain('新增 2 · 变更 1 · 移除 0');
  expect(host.querySelector('[data-testid="kb-orch-candidate-review"]')?.textContent).toContain('单元验收通过 3/4');
  expect(host.querySelector('[data-testid="kb-orch-candidate-review"]')?.textContent).toContain('最终复核已完成');

  await act(async () => { button('确认发布').click(); });
  expect(api.confirmKbRelease).toHaveBeenCalledWith('kb-b1');
  expect(onBuildUpdated).toHaveBeenCalledWith(published);
  expect(host.querySelector('[data-testid="kb-orch-confirm-done"]')?.textContent).toContain('已确认发布：r_20261101');
});

it('409 kb_confirm_stale：明确提示确认失效并引导刷新（重拉编排进度）', async () => {
  api.confirmKbRelease.mockRejectedValue(new APIError('候选内容已变化，确认失效：请重新构建或在草稿上排查改动', 409, { error: 'kb_confirm_stale' }));
  api.getKbBuildOrchestration.mockClear();
  await act(async () => { root = createRoot(host); root.render(<BuildOrchestrationProgress build={makeBuild({ status: 'awaiting_release' })} />); });
  api.getKbBuildOrchestration.mockClear();

  await act(async () => { button('确认发布').click(); });
  const stale = host.querySelector('[data-testid="kb-orch-confirm-stale"]');
  expect(stale).not.toBeNull();
  expect(stale?.textContent).toContain('候选内容已变化，确认失效');
  expect(host.querySelector('[data-testid="kb-orch-confirm-done"]')).toBeNull();

  // 刷新引导：重拉编排进度并清除失效提示。
  api.getKbBuildOrchestration.mockResolvedValue(makeOrch({ ended: true, endReason: null }));
  await act(async () => { button('刷新候选状态').click(); });
  expect(api.getKbBuildOrchestration).toHaveBeenCalledWith('kb-b1');
  expect(host.querySelector('[data-testid="kb-orch-confirm-stale"]')).toBeNull();
});

it('确认的其他失败：显示服务端消息（不误报 stale）', async () => {
  api.confirmKbRelease.mockRejectedValue(new APIError('发布条件未满足：必审报告缺失', 409, { error: 'kb_publish_blocked' }));
  await act(async () => { root = createRoot(host); root.render(<BuildOrchestrationProgress build={makeBuild({ status: 'awaiting_release' })} />); });
  await act(async () => { button('确认发布').click(); });
  const error = host.querySelector('[data-testid="kb-orch-confirm-error"]');
  expect(error?.textContent).toContain('确认失败：发布条件未满足：必审报告缺失');
  expect(host.querySelector('[data-testid="kb-orch-confirm-stale"]')).toBeNull();
});

it('终态构建只拉取一次定格（不再轮询），展示收束结果', async () => {
  vi.useFakeTimers();
  try {
    api.getKbBuildOrchestration.mockClear();
    await act(async () => { root = createRoot(host); root.render(<BuildOrchestrationProgress build={makeBuild({ status: 'published' })} />); });
    expect(api.getKbBuildOrchestration).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(api.getKbBuildOrchestration).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="kb-orch-spec"]')?.textContent).toContain('候选就绪人工确认一次');
  } finally {
    vi.useRealTimers();
  }
});
