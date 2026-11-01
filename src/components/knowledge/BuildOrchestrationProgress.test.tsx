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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getKbBuildOrchestration: vi.fn(), confirmKbRelease: vi.fn(), getKbBuildLeaderProgress: vi.fn() }));
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
import type { KbBuildDto, KbBuildOrchestrationDto, KbBuildOrchestrationTaskDto, KbLeaderPublishRequestDto, KbLeaderRunProgressDto, KbLeaderRunTaskDto } from '../../types/agent';
import { APIError } from '../../api/client';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
document.body.appendChild(host);
let root: Root;

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

function makeLeaderTask(over: Partial<KbLeaderRunTaskDto> = {}): KbLeaderRunTaskDto {
  return {
    nativeTaskId: 'b559b30e-0f40-45ea-b96e-84206aa65078',
    role: 'luban',
    parentTaskId: null,
    status: 'confirmed',
    execState: 'running',
    lastEventAt: '2026-11-02T08:12:30Z',
    ...over,
  };
}

function makeLeader(
  over: Omit<Partial<KbLeaderRunProgressDto>, 'summary' | 'publishRequest'> & {
    summary?: Partial<KbLeaderRunProgressDto['summary']>;
    publishRequest?: Partial<KbLeaderPublishRequestDto>;
  } = {},
): KbLeaderRunProgressDto {
  const { summary, publishRequest, ...rest } = over;
  return {
    buildId: 'kb-v2',
    orchestrationMode: 'pi-amagi',
    generation: 1,
    leader: { sessionId: 'sess-8f21c4aa9e', pid: 4310, resumeCapability: 'session' },
    tasks: [],
    rounds: { started: 3, ended: 2 },
    idle: { remindedAt: null, lastActivityAt: '2026-11-02T08:12:30Z' },
    publishRequest: null,
    summary: {
      acceptedDocumentCount: null,
      openBlockingCount: null,
      activeAssignments: null,
      queueReason: null,
      lastUsage: null,
      cumulativeUsage: null,
      ...(summary ?? {}),
    },
    endedReason: null,
    eventCursor: { 'leader-rpc': 'evt-42' },
    updatedAt: '2026-11-02T08:12:31Z',
    ...rest,
    ...(publishRequest !== undefined ? { publishRequest: { requestId: null, candidateRevision: 'rev-1', summary: '', accepted: false, status: null, decidedAt: '2026-11-02T08:30:00Z', ...publishRequest } } : {}),
  };
}

beforeEach(() => {
  api.getKbBuildOrchestration.mockReset().mockResolvedValue(makeOrch());
  api.confirmKbRelease.mockReset();
  api.getKbBuildLeaderProgress.mockReset().mockResolvedValue(makeLeader());
});

afterEach(() => {
  act(() => root?.unmount());
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
  // 所有角色均可见；尚未创建任务的角色如实标记。
  expect(host.querySelector('[data-role-group="write"]')).not.toBeNull();
  expect(host.querySelector('[data-role-group="review"]')).not.toBeNull();
  expect(host.querySelector('[data-role-group="integrate"]')).not.toBeNull();
  expect(host.querySelector('[data-role-group="final_review"]')).not.toBeNull();
  expect(host.querySelector('[data-role-group="plan"]')?.textContent).toContain('未创建任务');
  expect(host.querySelector('[data-selected-role="write"]')).not.toBeNull();
  expect(host.querySelectorAll('[data-task-id]')).toHaveLength(2);

  // 三轴徽标（分色 data 属性 + 中文文案）。
  const running = host.querySelector('[data-task-id="t:write:u1:r0"]');
  expect(running?.getAttribute('data-exec')).toBe('running');
  expect(running?.textContent).toContain('执行中');
  expect(running?.textContent).toContain('待生成');
  expect(running?.textContent).toContain('待审');
  await act(async () => { (host.querySelector('[data-role-group="review"]') as HTMLButtonElement).click(); });
  const reviewed = host.querySelector('[data-task-id="t:review:u1:r0"]');
  expect(reviewed?.getAttribute('data-acceptance')).toBe('passed');
  expect(reviewed?.textContent).toContain('完成');
  expect(reviewed?.textContent).toContain('可用');
  expect(reviewed?.textContent).toContain('通过');

  // 等待原因三分类：依赖未满足 / 名额等待 / 等待人工。
  await act(async () => { (host.querySelector('[data-role-group="write"]') as HTMLButtonElement).click(); });
  expect(host.querySelector('[data-task-id="t:write:u2:r1"]')?.textContent).toContain('依赖未满足（1）');
  expect(host.querySelector('[data-task-id="t:write:u2:r1"]')?.getAttribute('data-waiting')).toBe('dependency');
  await act(async () => { (host.querySelector('[data-role-group="integrate"]') as HTMLButtonElement).click(); });
  expect(host.querySelector('[data-task-id="t:integrate:r0#1"]')?.textContent).toContain('等待构建名额');
  expect(host.querySelector('[data-task-id="t:integrate:r0#1"]')?.getAttribute('data-waiting')).toBe('capacity');
  await act(async () => { (host.querySelector('[data-role-group="final_review"]') as HTMLButtonElement).click(); });
  expect(host.querySelector('[data-task-id="t:final:all"]')?.textContent).toContain('等待人工裁定');
  expect(host.querySelector('[data-task-id="t:final:all"]')?.getAttribute('data-waiting')).toBe('human');

  // 修订轮次/预算/阻断计数。
  await act(async () => { (host.querySelector('[data-role-group="write"]') as HTMLButtonElement).click(); });
  expect(host.querySelector('[data-task-id="t:write:u2:r1"]')?.textContent).toContain('修订 r1');
  expect(host.querySelector('[data-task-id="t:write:u2:r1"]')?.textContent).toContain('修订 1/2');
  expect(host.querySelector('[data-task-id="t:write:u2:r1"]')?.textContent).toContain('阻断 2');

  // 整合/最终复核无单元标识的展示。
  await act(async () => { (host.querySelector('[data-role-group="integrate"]') as HTMLButtonElement).click(); });
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

it('角色总览按单元最新修订统计，保留旧轮次供明细追溯', async () => {
  api.getKbBuildOrchestration.mockResolvedValue(makeOrch({ tasks: [
    makeTask({ taskId: 'u1:r0', unitId: 'u1', round: 0, execState: 'failed' }),
    makeTask({ taskId: 'u1:r1', unitId: 'u1', round: 1, execState: 'done', artifactState: 'available', acceptanceState: 'passed' }),
  ] }));
  await act(async () => { root = createRoot(host); root.render(<BuildOrchestrationProgress build={makeBuild()} />); });
  expect(host.querySelector('[data-role-group="write"]')?.textContent).toContain('已完成');
  expect(host.querySelector('[data-role-group="write"]')?.textContent).toContain('1/1');
  expect(host.querySelectorAll('[data-task-id]')).toHaveLength(2);
});

it('构建终态时未执行任务显示已停止，不再提示等待名额', async () => {
  api.getKbBuildOrchestration.mockResolvedValue(makeOrch({ tasks: [
    makeTask({ execState: 'queued' }),
  ] }));
  await act(async () => { root = createRoot(host); root.render(<BuildOrchestrationProgress build={makeBuild({ status: 'failed' })} />); });
  expect(host.querySelector('[data-role-group="write"]')?.textContent).toContain('已停止');
  expect(host.querySelector('[data-task-id="t:write:u1"]')?.textContent).toContain('已停止');
  expect(host.querySelector('[data-task-id="t:write:u1"]')?.textContent).not.toContain('等待构建名额');
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
describe('v2 Leader 监督运行进度（真实契约 GET /api/kb/builds/:id/leader）', () => {
  it('汇总三格（真实计数：已接受文档/未解决阻断/实际并发）+ Leader 行轮次；null 计数显示未知；无百分比', async () => {
    api.getKbBuildLeaderProgress.mockResolvedValue(makeLeader({
      tasks: [
        makeLeaderTask({ nativeTaskId: 'task-w-01', execState: 'running' }),
        makeLeaderTask({ nativeTaskId: 'task-r-01', role: 'diting', execState: 'done', status: 'confirmed' }),
      ],
      summary: { acceptedDocumentCount: 5, openBlockingCount: 2, activeAssignments: 3, queueReason: null, lastUsage: null, cumulativeUsage: null },
    }));
    await act(async () => {
      root = createRoot(host);
      root.render(<BuildOrchestrationProgress build={makeBuild({ id: 'kb-v2', orchestrationMode: 'pi-amagi' })} />);
    });
    expect(api.getKbBuildLeaderProgress).toHaveBeenCalledWith('kb-v2');
    expect(api.getKbBuildOrchestration).not.toHaveBeenCalled(); // v2 不请求 B 案数据
    const summary = host.querySelector('[data-testid="kb-runtime-summary"]');
    expect(summary?.textContent).toContain('已接受文档');
    expect(summary?.textContent).toContain('未解决阻断');
    expect(summary?.textContent).toContain('实际并发');
    expect(summary?.textContent).toContain('活动分配 3');
    const leader = host.querySelector('[data-testid="kb-runtime-leader"]');
    expect(leader?.textContent).toContain('监督中');
    expect(leader?.textContent).toContain('代次 1');
    expect(leader?.textContent).toContain('轮次 3/2（启/收）');
    expect(leader?.textContent).toContain('sess-8f21c4');
    expect(host.querySelector('[data-testid="kb-runtime-resume-capability"]')?.textContent)
      .toContain('可原会话续接');
    expect(host.querySelector('[data-testid="kb-runtime-plan-count"]')?.textContent)
      .toContain('当前计划 2 项');
    expect(summary?.textContent).not.toContain('%');
    // 累计用量恒未知（不假累加）的诚实声明。
    expect(host.querySelector('[data-testid="kb-runtime-mode-note"]')?.textContent)
      .toContain('累计用量');
  });

  it.each([null, { started: null, ended: null }])('终局只显示历史并发，缺失轮次为未知而不是0/0（%#）', async (rounds) => {
    api.getKbBuildLeaderProgress.mockResolvedValue(makeLeader({
      termination: 'finished',
      rounds,
      tasks: [makeLeaderTask({ execState: 'running' })],
    }));
    await act(async () => {
      root = createRoot(host);
      root.render(<BuildOrchestrationProgress build={makeBuild({ id: 'kb-v2', status: 'published', orchestrationMode: 'pi-amagi' })} />);
    });
    const summary = host.querySelector('[data-testid="kb-runtime-summary"]');
    expect(summary?.textContent).toContain('末次观测并发');
    expect(summary?.textContent).toContain('非当前活跃');
    expect(summary?.textContent).not.toContain('实际并发');
    expect(host.querySelector('[data-testid="kb-runtime-leader"]')?.textContent).toContain('轮次 未知/未知');
    expect(host.querySelector('[data-testid="kb-runtime-task"]')?.getAttribute('data-exec')).toBe('stopped');
  });

  it('旧epoch/代次任务仅作历史，不计当前计划与并发', async () => {
    api.getKbBuildLeaderProgress.mockResolvedValue(makeLeader({
      generation: 3, runtimeEpoch: 2,
      tasks: [
        makeLeaderTask({ nativeTaskId: 'old', generation: 1, runtimeEpoch: 1, execState: 'running' }),
        makeLeaderTask({ nativeTaskId: 'new', generation: 3, runtimeEpoch: 2, execState: 'running' }),
      ],
    }));
    await act(async () => {
      root = createRoot(host);
      root.render(<BuildOrchestrationProgress build={makeBuild({ id: 'kb-v2', orchestrationMode: 'pi-amagi' })} />);
    });
    expect(host.querySelector('[data-testid="kb-runtime-plan-count"]')?.textContent).toContain('当前计划 1 项');
    expect(host.querySelector('[data-testid="kb-runtime-plan-count"]')?.textContent).toContain('历史 1 项');
    expect(host.querySelector('[data-testid="kb-runtime-summary"]')?.children[2]?.textContent).toContain('已观测）1');
    expect(host.querySelector('[data-task-id="old"]')?.getAttribute('data-exec')).toBe('stopped');
    expect(host.querySelector('[data-task-id="old"]')?.textContent).toContain('历史任务');
    expect(host.querySelector('[data-task-id="new"]')?.getAttribute('data-exec')).toBe('running');
  });

  it('进程终止未确认独立于业务终态，不伪称已退出或可直接恢复', async () => {
    api.getKbBuildLeaderProgress.mockResolvedValue(makeLeader({
      termination: 'termination-unconfirmed', endedReason: 'leader-failed',
      processTermination: { state: 'unconfirmed', at: '2026-11-01T00:00:00Z', note: '缺少进程归属证明', unconfirmedPids: [0] },
      tasks: [makeLeaderTask({ execState: 'running' })],
    }));
    await act(async () => {
      root = createRoot(host);
      root.render(<BuildOrchestrationProgress build={makeBuild({ id: 'kb-v2', status: 'failed', orchestrationMode: 'pi-amagi' })} />);
    });
    expect(host.querySelector('[data-testid="kb-runtime-termination-unconfirmed"]')?.textContent).toContain('尚未确认所有进程退出');
    expect(host.querySelector('[data-testid="kb-runtime-leader"]')?.textContent).toContain('终止未确认');
    expect(host.querySelector('[data-testid="kb-runtime-resume-capability"]')?.textContent).toContain('需先确认后台终止');
    expect(host.querySelector('[data-testid="kb-runtime-task"]')?.getAttribute('data-exec')).toBe('termination-unconfirmed');
    expect(host.querySelector('[data-testid="kb-runtime-task"]')?.textContent).not.toContain('已停止');
    expect(host.querySelector('[data-testid="kb-runtime-summary"]')?.textContent).toContain('末次观测并发');
  });

  it('summary 计数 null=未知：显示未知而非 0/推测值；lastUsage 末次口径明示', async () => {
    api.getKbBuildLeaderProgress.mockResolvedValue(makeLeader({
      summary: { acceptedDocumentCount: null, openBlockingCount: null, activeAssignments: null, queueReason: null, lastUsage: { inputTokens: 12_400, outputTokens: 3_100, at: '2026-11-02T08:12:00Z' }, cumulativeUsage: null },
    }));
    await act(async () => {
      root = createRoot(host);
      root.render(<BuildOrchestrationProgress build={makeBuild({ id: 'kb-v2', orchestrationMode: 'pi-amagi' })} />);
    });
    const summary = host.querySelector('[data-testid="kb-runtime-summary"]');
    expect(summary?.textContent).toContain('未知');
    expect(summary?.textContent).toContain('回执数据未提供');
    const usage = host.querySelector('[data-testid="kb-runtime-leader-usage"]');
    expect(usage?.textContent).toContain('末次轮次用量');
    expect(usage?.textContent).toContain('12400');
    expect(usage?.textContent).toContain('累计未知');
    // 未知不冒充数字：未知格不渲染 0 计数文案。
    expect(host.querySelector('[data-testid="kb-runtime-summary"]')?.textContent).not.toContain('已接受文档 0');
  });

  it('子任务行：角色/身份状态/执行状态/排队（原因未细分）/续接链/用量未知/最近事件', async () => {
    api.getKbBuildLeaderProgress.mockResolvedValue(makeLeader({
      tasks: [
        makeLeaderTask({ nativeTaskId: 'task-w-01', execState: 'running', status: 'confirmed' }),
        makeLeaderTask({ nativeTaskId: 'task-w-02', role: 'luban', execState: 'queued', status: 'pending' }),
        makeLeaderTask({ nativeTaskId: 'task-r-01', role: 'diting', execState: 'done', status: 'confirmed' }),
        makeLeaderTask({ nativeTaskId: 'task-err', execState: 'error', status: 'confirmed' }),
        makeLeaderTask({ nativeTaskId: 'task-w-03', execState: 'running', parentTaskId: 'task-w-01' }),
        makeLeaderTask({ nativeTaskId: 'task-gone', execState: null, status: 'revoked' }),
      ],
    }));
    await act(async () => {
      root = createRoot(host);
      root.render(<BuildOrchestrationProgress build={makeBuild({ id: 'kb-v2', orchestrationMode: 'pi-amagi' })} />);
    });
    const tasks = [...host.querySelectorAll('[data-testid="kb-runtime-task"]')];
    expect(tasks).toHaveLength(6);
    expect(host.querySelector('[data-testid="kb-runtime-plan-count"]')?.textContent).toContain('当前计划 6 项');
    // native execState=error（真实链路实测）：中文标签 + 语气与 failed 同级（异常终态）。
    const errored = host.querySelector('[data-task-id="task-err"]');
    expect(errored?.textContent).toContain('异常');
    expect(errored?.querySelector('.text-seal-2')?.textContent).toContain('异常'); // bad tone（与 failed 同级）
    const running = host.querySelector('[data-task-id="task-w-01"]');
    expect(running?.getAttribute('data-exec')).toBe('running');
    expect(running?.getAttribute('data-actor-status')).toBe('confirmed');
    expect(running?.textContent).toContain('执行中');
    expect(running?.textContent).toContain('已确认');
    expect(running?.textContent).toContain('鲁班（写作）');
    expect(running?.textContent).toContain('子任务用量不经 Leader 事件');
    expect(running?.textContent).toContain('最近事件');
    // execState 未知原样展示；null 显示「未观测」。
    expect(host.querySelector('[data-task-id="task-gone"]')?.textContent).toContain('未观测');
    expect(host.querySelector('[data-task-id="task-gone"]')?.textContent).toContain('已撤销');
    const queued = host.querySelector('[data-task-id="task-w-02"]');
    expect(queued?.textContent).toContain('排队');
    expect(queued?.textContent).toContain('原因未细分'); // 端点不区分准入/等待接受，如实标注
    expect(queued?.getAttribute('data-actor-status')).toBe('pending');
    expect(queued?.textContent).toContain('身份待确认');
    const resumed = host.querySelector('[data-task-id="task-w-03"]');
    expect(resumed?.textContent).toContain('续接');
    expect(resumed?.textContent).toContain('task-w-01');
  });

  it('空闲提醒与发布申请：真实字段如实展示（leader-idle 提醒 / 候选待裁定）', async () => {
    api.getKbBuildLeaderProgress.mockResolvedValue(makeLeader({
      idle: { remindedAt: '2026-11-02T08:30:00Z', lastActivityAt: '2026-11-02T08:20:00Z' },
      publishRequest: { candidateRevision: 'rev-7f3a', summary: '8 篇候选', accepted: false, status: 'pending', decidedAt: '2026-11-02T08:31:00Z' },
      skill: { path: '/data/agent/skills/kb-build/SKILL.md', revision: 'a1b2c3d4e5f6a7b8' },
    }));
    await act(async () => {
      root = createRoot(host);
      root.render(<BuildOrchestrationProgress build={makeBuild({ id: 'kb-v2', orchestrationMode: 'pi-amagi' })} />);
    });
    expect(host.querySelector('[data-testid="kb-runtime-idle-reminded"]')?.textContent)
      .toContain('空闲提醒已发送');
    const publish = host.querySelector('[data-testid="kb-runtime-publish-request"]');
    expect(publish?.textContent).toContain('rev-7f3a');
    expect(publish?.textContent).toContain('待裁定');
    // 冻结 skill 哈希可见（供核对）。
    expect(host.querySelector('[data-testid="kb-runtime-skill"]')?.textContent).toContain('a1b2c3d4e5f6a7b8');
  });

  it('termination=cancelling：取消后台终止中横幅；queueReason 有值时排队任务显示真实原因', async () => {
    api.getKbBuildLeaderProgress.mockResolvedValue(makeLeader({
      termination: 'cancelling',
      summary: { queueReason: '准入池满（writer 池 4）', lastUsage: null, cumulativeUsage: null },
      tasks: [makeLeaderTask({ nativeTaskId: 'task-q', execState: 'queued' })],
    }));
    await act(async () => {
      root = createRoot(host);
      // 取消进行中：构建 status 仍 running，由 termination=cancelling 表达终止中。
      root.render(<BuildOrchestrationProgress build={makeBuild({ id: 'kb-v2', orchestrationMode: 'pi-amagi', status: 'running' })} />);
    });
    const banner = host.querySelector('[data-testid="kb-runtime-cancelling"]');
    expect(banner?.textContent).toContain('已请求取消');
    expect(banner?.textContent).toContain('仍在终止后台任务');
    expect(host.querySelector('[data-task-id="task-q"]')?.textContent).toContain('排队（准入池满（writer 池 4））');
  });

  it('leader 端点 404（终态构建，非 pi-amagi/无检查点）：如实降级说明，不渲染推测进度', async () => {
    api.getKbBuildLeaderProgress.mockRejectedValue(new APIError('构建不存在或非 Leader 监督构建', 404, { error: 'build_not_found' }));
    await act(async () => {
      root = createRoot(host);
      root.render(<BuildOrchestrationProgress build={makeBuild({ id: 'kb-v2', orchestrationMode: 'pi-amagi', status: 'failed' })} />);
    });
    expect(host.querySelector('[data-testid="kb-runtime-unavailable"]')?.textContent)
      .toContain('暂不可用');
    expect(host.querySelector('[data-testid="kb-runtime-progress"]')).toBeNull();
  });

  it('非终态构建启动窗口 404：不定格降级，后续数据就绪后恢复渲染（真实实测修复）', async () => {
    // POST /api/kb/builds 返回后 leaderRun 尚未建立，首轮 404；随后就绪。
    vi.useFakeTimers();
    let calls = 0;
    api.getKbBuildLeaderProgress.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new APIError('构建不存在或非 Leader 监督构建', 404, { error: 'build_not_found' });
      return makeLeader({ summary: { acceptedDocumentCount: 1, openBlockingCount: 0, queueReason: null, lastUsage: null, cumulativeUsage: null } });
    });
    await act(async () => {
      root = createRoot(host);
      root.render(<BuildOrchestrationProgress build={makeBuild({ id: 'kb-v2', orchestrationMode: 'pi-amagi', status: 'running' })} />);
    });
    // 首拉 404 不得定格为不可用，也不渲染降级说明。
    expect(host.querySelector('[data-testid="kb-runtime-unavailable"]')).toBeNull();
    // 非终态保持轮询，第二次拉取成功后渲染真实进度。
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(host.querySelector('[data-testid="kb-runtime-progress"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kb-runtime-summary"]')?.textContent).toContain('1');
    vi.useRealTimers();
  });

  it('legacy 构建不进入 v2 分支：仍走 B 案 orchestration 数据', async () => {
    await act(async () => {
      root = createRoot(host);
      root.render(<BuildOrchestrationProgress build={makeBuild()} />);
    });
    expect(api.getKbBuildLeaderProgress).not.toHaveBeenCalled();
    expect(api.getKbBuildOrchestration).toHaveBeenCalledWith('kb-b1');
  });

  it('v2 终态构建只拉取一次定格；监督结束原因与已停止任务如实展示', async () => {
    vi.useFakeTimers();
    try {
      api.getKbBuildLeaderProgress.mockClear();
      api.getKbBuildLeaderProgress.mockResolvedValue(makeLeader({
        endedReason: 'leader-idle',
        leader: { sessionId: 'sess-x', pid: null, resumeCapability: 'artifact' },
        tasks: [makeLeaderTask({ nativeTaskId: 'task-x', execState: 'running' })],
      }));
      await act(async () => {
        root = createRoot(host);
        root.render(<BuildOrchestrationProgress build={makeBuild({ id: 'kb-v2', orchestrationMode: 'pi-amagi', status: 'failed' })} />);
      });
      expect(api.getKbBuildLeaderProgress).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(6000); });
      expect(api.getKbBuildLeaderProgress).toHaveBeenCalledTimes(1);
      const leader = host.querySelector('[data-testid="kb-runtime-leader"]');
      expect(leader?.textContent).toContain('已结束（leader-idle）');
      expect(host.querySelector('[data-testid="kb-runtime-resume-capability"]')?.textContent)
        .toContain('成果级恢复');
      expect(host.querySelector('[data-task-id="task-x"]')?.textContent).toContain('已停止');
      expect(host.querySelector('[data-task-id="task-x"]')?.textContent).not.toContain('执行中');
      // 「已停止」=最后观测语义：title 明示未观测到 native 终态、不虚构 done。
      expect(host.querySelector('[data-task-id="task-x"] span[title*="最后观测"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('恢复能力三态：none=不支持恢复', async () => {
    api.getKbBuildLeaderProgress.mockResolvedValue(makeLeader({
      leader: { sessionId: null, pid: null, resumeCapability: 'none' },
    }));
    await act(async () => {
      root = createRoot(host);
      root.render(<BuildOrchestrationProgress build={makeBuild({ id: 'kb-v2', orchestrationMode: 'pi-amagi' })} />);
    });
    expect(host.querySelector('[data-testid="kb-runtime-resume-capability"]')?.textContent)
      .toContain('不支持恢复');
  });
});
