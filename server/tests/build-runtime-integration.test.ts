/**
 * 重构 v2：Leader 监督集成测试（宿主回调假件 + 真实 BuildRuntimeHost 探测门禁）。
 *
 * 覆盖：
 * - 编排模式冻结：缺省 legacy / 非法回落 / claude-native 拒绝 / 宿主未接线拒绝
 *   （不降级）；宿主已接线但运行时探测失败（真实 probe 链）显式失败；
 * - 监督状态机：首个 agent_end 不结束、空闲一次提醒再 leader_idle、真实
 *   publish_completed 终局、拒绝后重试、取消顺序（先撤凭据→宽限终止）、
 *   第二 Leader 守卫、运行冻结比对、事件去重（代次键）、进程退出判定、
 *   续接父链继承；
 * - Leader 发布执行器（executeLeaderPublishRequest）：候选漂移拒绝 /
 *   代次不符拒绝 / 缺审查阻断（不假发布）；
 * - Leader 只占进程池 build 通道 1 个槽位。
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../src/modules/config-manager.js';
import { computeCandidateHash } from '../src/kb/orchestration-contracts.js';
import { contentResourceHash } from '../src/kb/evidence-locator.js';
import { RawSourceSnapshot } from '../src/kb/raw-source-snapshot.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService, ToolError } from '../src/agent/agent-tool-service.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { resolveOrchestrationMode } from '../src/types/agent-knowledge.js';
import {
  BuildLeaderSupervisor,
  freshLeaderRunState,
  isPidAlive,
} from '../src/kb/build-leader-supervisor.js';
import { BuildRuntimeHost, LEADER_TOOL_WHITELIST } from '../src/kb/build-runtime-host.js';
import type { BuildRunSpec, CancelResult, RuntimeBinding, RuntimeEvent } from '../src/agent/build-runtime/contracts.js';
import type { LeaderRunCheckpointState } from '../src/types/agent-knowledge.js';

// ---------------------------------------------------------------------------
// 假件与工具
// ---------------------------------------------------------------------------

const CANDIDATE = 'c'.repeat(64);

let eventSeq = 0;
function event(type: string, extra: Partial<RuntimeEvent> = {}): RuntimeEvent {
  eventSeq += 1;
  return {
    eventId: `e${eventSeq}`,
    source: 'leader-rpc',
    nativeEventId: `n${eventSeq}`,
    generation: 1,
    taskId: null,
    type,
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    payload: {},
    ...extra,
  };
}

function specFixture(generation = 1): BuildRunSpec {
  return {
    buildId: 'b_leaderrun01',
    generation,
    orchestrationMode: 'pi-amagi',
    mode: 'full',
    sourceManifestHash: 'a'.repeat(64),
    workflowRevision: 'f'.repeat(64),
    workflowSkillPath: '/tmp/skills/knowledge-build/SKILL.md',
    amagiPackage: { version: '2.21.31', installDir: '/tmp/amagi@2.21.31', packageRoot: '/tmp/amigi@2.21.31/package', contentHash: 'p'.repeat(64) },
    piVersion: '1.4.0',
    agentDirConfigHash: 'c'.repeat(64),
    models: { leader: 'zhipuai/glm-5.3', writer: 'zhipuai/glm-5.3-flash', reviewer: 'zhipuai/glm-5.3', research: 'zhipuai/glm-5.3-flash' },
    modelDescriptors: [
      { id: 'glm-5.3', baseUrl: 'https://fixture.example/v1', api: 'openai-completions' },
      { id: 'glm-5.3-flash', baseUrl: 'https://fixture.example/v1', api: 'openai-completions' },
    ],
    roles: { writer: 'luban', reviewer: 'diting', research: 'baize' },
    limits: { maxConcurrentAgents: 6, admissionPools: { writer: 4, reviewer: 2 } },
    autoRounds: { verify: false, continueRounds: 1, repairRounds: 1, implicitRetryRounds: 1 },
    publicationPolicy: 'auto',
  };
}

function materialFixture() {
  return { mode: 'full' as const, sourceSnapshotHash: 'a'.repeat(64), baseReleaseId: null };
}

interface ScriptedHarness {
  events: RuntimeEvent[];
  nudges: string[];
  calls: string[];
  cancelResult: CancelResult;
  startBinding: RuntimeBinding;
}

/** 宿主回调假件（事件数组喂入监督器；记录调用顺序）。 */
function scriptedCallbacks(order: string[], overrides: Partial<Parameters<typeof BuildLeaderSupervisor>[0]> = {}): { cb: Parameters<typeof BuildLeaderSupervisor>[0]; harness: ScriptedHarness } {
  const harness: ScriptedHarness = {
    events: [],
    nudges: [],
    calls: [],
    cancelResult: { leaderExit: { code: 0, signal: null }, credentialsRevoked: true, residualNote: 'fixture：已确认退出' },
    startBinding: { buildId: 'b_leaderrun01', generation: 1, agentDir: '/tmp/agentdir', workDir: '/tmp/workdir', leaderSessionId: 's-1', leaderPid: null, resumeCapability: { session: true, artifact: true } },
  };
  const cb: Parameters<typeof BuildLeaderSupervisor>[0] = {
    pool: new AgentProcessPool(),
    log: () => undefined,
    persistCheckpoint: () => order.push('persist'),
    revokeCredentials: () => order.push('revoke'),
    startLeader: async () => { harness.calls.push('start'); return { ...harness.startBinding }; },
    cancelLeader: async () => { harness.calls.push('cancel'); return harness.cancelResult; },
    events: () => {
      harness.calls.push('events');
      const source = harness.events;
      return (async function* () {
        let index = 0;
        for (;;) {
          while (index < source.length) yield source[index++];
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();
    },
    nudge: async (_binding, message) => { harness.calls.push('nudge'); harness.nudges.push(message); },
    currentRuntimeFreeze: () => ({ piVersion: '1.4.0', amagiContentHash: 'p'.repeat(64), agentDirConfigHash: 'c'.repeat(64), workflowRevision: 'f'.repeat(64) }),
    actorSnapshot: () => ({ acceptedDocumentCount: 2, openBlockingCount: 0, activeAssignments: 1 }),
    ...overrides,
  };
  return { cb, harness };
}

function makeSupervisor(cb: Parameters<typeof BuildLeaderSupervisor>[0], state?: LeaderRunCheckpointState, options: { idleGraceMs?: number } = {}) {
  return new BuildLeaderSupervisor(cb, state ?? freshLeaderRunState(specFixture(), materialFixture()), { idleGraceMs: options.idleGraceMs ?? 50, idleTickMs: 10 });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// 监督状态机（真实事件词汇：宿主转换后喂入）
// ---------------------------------------------------------------------------

describe('BuildLeaderSupervisor 监督状态机', () => {
  it('真实发布管线结果（publish_completed accepted）→ publish-accepted 终局交回流水线', async () => {
    const order: string[] = [];
    const { cb, harness } = scriptedCallbacks(order);
    const supervisor = makeSupervisor(cb);
    const runPromise = supervisor.run({ spec: specFixture(), signal: new AbortController().signal, resumeMode: 'fresh' });
    await waitFor(() => harness.calls.includes('events'));
    harness.events.push(
      event('round_started'),
      event('task_created', { payload: { nativeTaskId: 't1', role: 'luban' } }),
      event('task_state', { payload: { nativeTaskId: 't1', status: 'done' } }),
      event('round_ended'),
      event('round_started'),
      event('publish_window_opened', { payload: { requestId: 'pub_1', candidateRevision: CANDIDATE } }),
      event('publish_completed', {
        source: 'tool-service',
        payload: {
          requestId: 'pub_1',
          accepted: true,
          candidateRevision: CANDIDATE,
          summary: '全部成果通过审查',
          status: 'accepted',
          publication: { status: 'published', releaseId: 'r_fixture', candidateHash: CANDIDATE, result: { docs: 2 } },
        },
      }),
    );
    const outcome = await runPromise;
    expect(outcome).toMatchObject({
      kind: 'publish-accepted',
      candidateRevision: CANDIDATE,
      publication: { status: 'published', releaseId: 'r_fixture' },
    });
    expect(order[0]).toBe('revoke');
    expect(order.filter((item) => item === 'revoke').length).toBeGreaterThanOrEqual(2);
    expect(order).toContain('persist');
    expect(supervisor.state.actors).toHaveLength(1);
    expect(supervisor.state.actors[0]).toMatchObject({ nativeTaskId: 't1', role: 'luban', status: 'confirmed', execState: 'done' });
    expect(supervisor.state.publishRequest?.accepted).toBe(true);
    expect(supervisor.state.publishRequest?.status).toBe('accepted');
    // 进度 DTO 汇总来自宿主成果快照（不虚构）
    expect(supervisor.progress().summary.acceptedDocumentCount).toBe(2);
    expect(supervisor.progress().summary.queueReason).toBeNull();
  });

  it('发布被拒不结束监督；修订后换正确候选接受', async () => {
    const order: string[] = [];
    const { cb, harness } = scriptedCallbacks(order);
    const supervisor = makeSupervisor(cb);
    const runPromise = supervisor.run({ spec: specFixture(), signal: new AbortController().signal, resumeMode: 'fresh' });
    await waitFor(() => harness.calls.includes('events'));
    harness.events.push(event('publish_completed', {
      source: 'tool-service',
      payload: { requestId: 'pub_1', accepted: false, candidateRevision: 'd'.repeat(64), summary: '旧版本', status: 'rejected', reason: 'candidate_conflict' },
    }));
    await waitFor(() => supervisor.state.publishRequest?.accepted === false);
    harness.events.push(event('publish_completed', {
      source: 'tool-service',
      payload: { requestId: 'pub_2', accepted: true, candidateRevision: CANDIDATE, summary: '修订后', status: 'accepted', publication: { status: 'published', releaseId: 'r2', candidateHash: CANDIDATE, result: {} } },
    }));
    const outcome = await runPromise;
    expect(outcome).toMatchObject({ kind: 'publish-accepted', candidateRevision: CANDIDATE });
  });

  it('首个 agent_end 不结束：空闲一次提醒，再空闲按 leader_idle 中断', async () => {
    const order: string[] = [];
    const { cb, harness } = scriptedCallbacks(order);
    const supervisor = makeSupervisor(cb, undefined, { idleGraceMs: 40 });
    const runPromise = supervisor.run({ spec: specFixture(), signal: new AbortController().signal, resumeMode: 'fresh' });
    await waitFor(() => harness.calls.includes('events'));
    harness.events.push(event('task_created', { payload: { nativeTaskId: 't1', role: 'luban' } }), event('task_state', { payload: { nativeTaskId: 't1', status: 'done' } }));
    await waitFor(() => supervisor.state.eventCursor['leader-rpc'] === harness.events.at(-1)!.eventId);
    harness.events.push(event('round_ended'));
    const outcome = await runPromise;
    expect(outcome).toEqual({ kind: 'leader-idle' });
    expect(harness.nudges).toHaveLength(1);
    expect(harness.nudges[0]).toContain('申请发布');
    expect(supervisor.state.idleRemindedAt).not.toBeNull();
    expect(supervisor.state.endedReason).toBe('leader-idle');
  });

  it('活动子任务未完成不判空闲（提醒不触发）', async () => {
    const order: string[] = [];
    const { cb, harness } = scriptedCallbacks(order);
    const supervisor = makeSupervisor(cb, undefined, { idleGraceMs: 10_000 });
    const controller = new AbortController();
    const runPromise = supervisor.run({ spec: specFixture(), signal: controller.signal, resumeMode: 'fresh' });
    await waitFor(() => harness.calls.includes('events'));
    harness.events.push(event('task_created', { payload: { nativeTaskId: 't1', role: 'diting' } })); // execState=running
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(harness.nudges).toHaveLength(0);
    await supervisor.requestCancel();
    const outcome = await runPromise;
    expect(outcome.kind).toBe('cancelled');
  });

  it('取消顺序：先撤代次凭据，再运行层终止；结果如实带回', async () => {
    const order: string[] = [];
    const { cb, harness } = scriptedCallbacks(order);
    harness.cancelResult = { leaderExit: { code: null, signal: 'SIGKILL' }, credentialsRevoked: true, residualNote: 'fixture：pid 已确认退出' };
    const supervisor = makeSupervisor(cb, undefined, { idleGraceMs: 10_000 });
    const controller = new AbortController();
    const runPromise = supervisor.run({ spec: specFixture(), signal: controller.signal, resumeMode: 'fresh' });
    await waitFor(() => harness.calls.includes('events'));
    await supervisor.requestCancel();
    const outcome = await runPromise;
    expect(outcome.kind).toBe('cancelled');
    expect(order[0]).toBe('revoke');
    const cancelIndex = harness.calls.indexOf('cancel');
    expect(cancelIndex).toBeGreaterThan(0);
    expect(supervisor.state.endedReason).toBe('cancelled');
  });

  it('旧 Leader 进程仍存活时拒绝启动第二个 Leader（会话恢复路径）', async () => {
    const order: string[] = [];
    const { cb } = scriptedCallbacks(order);
    const state = freshLeaderRunState(specFixture(), materialFixture());
    state.binding = { buildId: 'b_leaderrun01', generation: 1, agentDir: '/tmp/ad', workDir: '/tmp/wd', leaderSessionId: 's-1', leaderPid: process.pid, resumeCapability: { session: true, artifact: true } };
    const supervisor = makeSupervisor(cb, state);
    await expect(supervisor.run({ spec: specFixture(), signal: new AbortController().signal, resumeMode: 'session' }))
      .rejects.toMatchObject({ code: 'kb_leader_alive' });
  });

  it('运行冻结不一致拒绝原会话续接（不伪造 session 恢复）', async () => {
    const order: string[] = [];
    const { cb } = scriptedCallbacks(order);
    const state = freshLeaderRunState(specFixture(), materialFixture());
    // 检查点冻结面与当前环境不一致（skill 哈希变化）→ 拒绝原会话续接
    state.spec = { ...state.spec, workflowRevision: 'e'.repeat(64) };
    state.binding = { buildId: 'b_leaderrun01', generation: 1, agentDir: '/tmp/ad', workDir: '/tmp/wd', leaderSessionId: 's-1', leaderPid: 999999, resumeCapability: { session: true, artifact: true } };
    const supervisor = makeSupervisor(cb, state);
    await expect(supervisor.run({ spec: state.spec, signal: new AbortController().signal, resumeMode: 'session' }))
      .rejects.toMatchObject({ code: 'kb_resume_runtime_changed' });
  });

  it('重放事件按代次+eventId 去重，不重复登记身份', async () => {
    const order: string[] = [];
    const { cb, harness } = scriptedCallbacks(order);
    const supervisor = makeSupervisor(cb);
    const runPromise = supervisor.run({ spec: specFixture(), signal: new AbortController().signal, resumeMode: 'fresh' });
    await waitFor(() => harness.calls.includes('events'));
    const created = event('task_created', { payload: { nativeTaskId: 't1', role: 'luban' } });
    harness.events.push(created, created, created);
    await waitFor(() => supervisor.state.actors.length === 1);
    harness.events.push(event('publish_completed', {
      source: 'tool-service',
      payload: { requestId: 'pub_1', accepted: true, candidateRevision: CANDIDATE, summary: '', status: 'accepted', publication: { status: 'published', releaseId: 'r', candidateHash: CANDIDATE, result: {} } },
    }));
    const outcome = await runPromise;
    expect(outcome.kind).toBe('publish-accepted');
    expect(supervisor.state.actors).toHaveLength(1);
  });

  it('Leader 进程异常退出 → leader-failed（不当作成功）', async () => {
    const order: string[] = [];
    const { cb, harness } = scriptedCallbacks(order);
    const supervisor = makeSupervisor(cb);
    const runPromise = supervisor.run({ spec: specFixture(), signal: new AbortController().signal, resumeMode: 'fresh' });
    await waitFor(() => harness.calls.includes('events'));
    harness.events.push(event('process_exit', { payload: { code: 1 } }));
    const outcome = await runPromise;
    expect(outcome).toMatchObject({ kind: 'leader-failed' });
    expect(supervisor.state.endedReason).toBe('leader-failed');
  });

  it('续接产生新任务 ID：父链继承并撤销原任务登记', async () => {
    const order: string[] = [];
    const { cb, harness } = scriptedCallbacks(order);
    const supervisor = makeSupervisor(cb);
    const runPromise = supervisor.run({ spec: specFixture(), signal: new AbortController().signal, resumeMode: 'fresh' });
    await waitFor(() => harness.calls.includes('events'));
    harness.events.push(
      event('task_created', { payload: { nativeTaskId: 't1', role: 'luban' } }),
      event('task_resumed', { payload: { nativeTaskId: 't1-r1', role: 'luban', parentTaskId: 't1' } }),
      event('task_state', { payload: { nativeTaskId: 't1-r1', status: 'done' } }),
      event('publish_completed', {
        source: 'tool-service',
        payload: { requestId: 'pub_1', accepted: true, candidateRevision: CANDIDATE, summary: '', status: 'accepted', publication: { status: 'published', releaseId: 'r', candidateHash: CANDIDATE, result: {} } },
      }),
    );
    const outcome = await runPromise;
    expect(outcome.kind).toBe('publish-accepted');
    const original = supervisor.state.actors.find((actor) => actor.nativeTaskId === 't1');
    const resumed = supervisor.state.actors.find((actor) => actor.nativeTaskId === 't1-r1');
    expect(original?.status).toBe('revoked');
    expect(resumed).toMatchObject({ parentTaskId: 't1', role: 'luban', status: 'confirmed' });
  });
});

// ---------------------------------------------------------------------------
// 配置冻结与服务门禁
// ---------------------------------------------------------------------------

describe('编排模式冻结与服务门禁', () => {
  it('resolveOrchestrationMode：缺省/非法回落 legacy，显式 pi-amagi 通过', () => {
    expect(resolveOrchestrationMode(undefined)).toBe('legacy');
    expect(resolveOrchestrationMode({})).toBe('legacy');
    expect(resolveOrchestrationMode({ orchestrationMode: 'bogus' as never })).toBe('legacy');
    expect(resolveOrchestrationMode({ orchestrationMode: 'pi-amagi' })).toBe('pi-amagi');
    expect(resolveOrchestrationMode({ orchestrationMode: 'claude-native' })).toBe('claude-native');
  });

  it('ConfigManager：orchestrationMode 受控枚举（非法拒绝、合法落盘）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mode-'));
    try {
      const manager = new ConfigManager(path.join(root, 'config.json'));
      await manager.load();
      expect(manager.getConfig().standardKb.orchestrationMode ?? 'legacy').toBe('legacy');
      await manager.updateConfig({ standardKb: { orchestrationMode: 'pi-amagi' } } as never);
      expect(manager.getConfig().standardKb.orchestrationMode).toBe('pi-amagi');
      await expect(manager.updateConfig({ standardKb: { orchestrationMode: 'bogus' } } as never)).rejects.toThrow();
      expect(manager.getConfig().standardKb.orchestrationMode).toBe('pi-amagi');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('createBuild：claude-native 显式拒绝；pi-amagi 宿主未接线显式拒绝（不降级）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-gate-'));
    const raw = path.join(root, 'raw');
    fs.mkdirSync(raw);
    try {
      const manager = new ConfigManager(path.join(root, 'config.json'));
      await manager.load();
      await manager.updateConfig({ knowledgeBaseRoot: raw, standardKb: { outputRoot: path.join(root, 'standard') } } as never);
      const store = new LocalMapStore(path.join(root, 'db.sqlite'));
      store.initialize();
      const resolver = new PiRuntimeResolver();
      vi.spyOn(resolver, 'checkReadiness').mockResolvedValue({ code: 'ready', model: { model: 'fixture' } } as never);
      const service = new KbBuildService({
        dataRoot: root, pool: new AgentProcessPool(), resolver,
        toolService: new AgentToolService({ dataRoot: root, documentsProvider: () => [] }),
        configProvider: () => manager.getConfig(), documentsProvider: () => [], sheetCsvPaths: () => [],
        internalBaseUrl: () => '', extensionPath: () => null, promptAssets: () => null,
      });

      await manager.updateConfig({ standardKb: { orchestrationMode: 'claude-native' } } as never);
      await expect(service.createBuild(store, { mode: 'full', confirm: 'BUILD' })).rejects.toMatchObject({ code: 'build_mode_unavailable' });

      await manager.updateConfig({ standardKb: { orchestrationMode: 'pi-amagi' } } as never);
      await expect(service.createBuild(store, { mode: 'full', confirm: 'BUILD' })).rejects.toMatchObject({ code: 'build_runtime_unavailable' });

      await manager.updateConfig({ standardKb: { orchestrationMode: 'legacy' } } as never);
      const internal = service as unknown as { runPipeline: () => Promise<void> };
      vi.spyOn(internal, 'runPipeline').mockResolvedValue(undefined);
      const dto = await service.createBuild(store, { mode: 'full', confirm: 'BUILD' });
      expect(dto.id).toMatch(/^b_/);
      expect(dto.orchestrationMode).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('LEADER_TOOL_WHITELIST：amagi 任务面 + 应用构建工具，无应用 task 族/正文写工具', () => {
    expect(LEADER_TOOL_WHITELIST).toEqual(expect.arrayContaining(['task_submit', 'task_query', 'task_control', 'task_resume', 'amagi_resource']));
    expect(LEADER_TOOL_WHITELIST).toEqual(expect.arrayContaining(['build_manifest', 'build_assign_output', 'build_request_publish', 'build_checkpoint']));
    expect(LEADER_TOOL_WHITELIST).not.toContain('kb_write_doc');
    expect(LEADER_TOOL_WHITELIST).not.toContain('kb_finish');
    expect(LEADER_TOOL_WHITELIST).not.toContain('task_cancel');
    expect(LEADER_TOOL_WHITELIST).not.toContain('app_command');
  });
});

// ---------------------------------------------------------------------------
// 真实 BuildRuntimeHost：探测门禁与状态 DTO（不 spawn Leader）
// ---------------------------------------------------------------------------

describe('BuildRuntimeHost 探测门禁', () => {
  function fixtureHost(root: string, manager: ConfigManager): BuildRuntimeHost {
    const resolver = new PiRuntimeResolver();
    vi.spyOn(resolver, 'resolveRuntime').mockResolvedValue({
      nodePath: process.execPath, nodeVersion: 'v24.0.0', piPackageRoot: '/tmp/pi',
      piCliPath: path.join(root, 'fake-pi.mjs'), piVersion: '1.4.0', claudeCliPath: null,
    } as never);
    return new BuildRuntimeHost({
      dataRoot: root,
      resolver,
      toolService: new AgentToolService({ dataRoot: root, documentsProvider: () => [] }),
      pool: new AgentProcessPool(),
      configProvider: () => manager.getConfig(),
      internalBaseUrl: () => 'http://127.0.0.1:39999',
      knowledgeBaseRoot: () => manager.getConfig().knowledgeBaseRoot ?? '',
      outputRoot: () => manager.getConfig().standardKb.outputRoot,
    });
  }

  it('statusDto：运行时未就绪如实报告（不 503、不假装可用）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-host-status-'));
    try {
      const manager = new ConfigManager(path.join(root, 'config.json'));
      await manager.load();
      await manager.updateConfig({ knowledgeBaseRoot: path.join(root, 'raw'), standardKb: { outputRoot: path.join(root, 'std'), orchestrationMode: 'pi-amagi' } } as never);
      fs.mkdirSync(path.join(root, 'raw'), { recursive: true });
      const host = fixtureHost(root, manager);
      const dto = await host.statusDto();
      expect(dto.orchestrationMode).toBe('pi-amagi');
      // 无版本化 amagi 包 → probe 静态 fail 如实呈现（installed=false）
      expect(dto.amagi?.installed).toBe(false);
      expect(dto.probe).not.toBeNull();
      expect(dto.probe?.checks.some((check) => check.id === 'amagi-package' && check.state === 'fail')).toBe(true);
      expect(dto.probe?.checks.some((check) => check.id === 'model-key-mapping' && check.state === 'pass')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

void isPidAlive;

// ---------------------------------------------------------------------------
// Leader 发布执行器（白盒：候选漂移/代次不符/缺审查阻断——不假发布）
// ---------------------------------------------------------------------------

describe('executeLeaderPublishRequest 门禁', () => {
  it('候选漂移与代次不符 → 拒绝（不进入发布管线）；缺有效审查 → 阻断', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-leader-pub-'));
    const raw = path.join(root, 'raw');
    const outputRoot = path.join(root, 'standard');
    fs.mkdirSync(path.join(raw, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(raw, 'docs', 'src1.md'), '# 源文档\n\n内容规则一。\n');
    try {
      const manager = new ConfigManager(path.join(root, 'config.json'));
      await manager.load();
      await manager.updateConfig({ knowledgeBaseRoot: raw, standardKb: { outputRoot, orchestrationMode: 'pi-amagi' } } as never);
      const store = new LocalMapStore(path.join(root, 'db.sqlite'));
      store.initialize();
      const documents = [{
        wikiNodeToken: null, objType: 'docx', objToken: 'tok1', title: '源文档',
        localRelPath: 'docs/src1.md', localMdPath: path.join(raw, 'docs', 'src1.md'),
        lastSyncedModifyTime: '', lastSyncedAt: new Date().toISOString(), status: 'synced',
      }];
      const service = new KbBuildService({
        dataRoot: root, pool: new AgentProcessPool(), resolver: new PiRuntimeResolver(),
        toolService: new AgentToolService({ dataRoot: root, documentsProvider: () => documents as never }),
        configProvider: () => manager.getConfig(), documentsProvider: () => documents as never,
        sheetCsvPaths: () => [], internalBaseUrl: () => '', extensionPath: () => null, promptAssets: () => null,
      });
      // 白盒装配 Leader 运行中的最小 entry 上下文（执行器只依赖这些）
      const buildId = 'b_pubgate01';
      const stagingRoot = path.join(outputRoot, '.staging', buildId);
      fs.mkdirSync(path.join(stagingRoot, 'docs', 'combat'), { recursive: true });
      const draft = 'combat/overview.md';
      fs.writeFileSync(path.join(stagingRoot, 'docs', draft), '<!--\nfeishu_sync_kb:\n  doc_id: doc_overview\n  sources:\n    - tok1\n  build_id: b_pubgate01\n-->\n# 战斗总览\n\n战斗以回合制推进：先手由速度决定，每回合累计怒气，怒气满后可释放战技。\n战技消耗按等级递增，胜负以全灭或回合上限判定。\n');
      // 与 stagingDocsEntriesOf 同一口径（contentResourceHash）计算候选哈希
      const candidateHash = computeCandidateHash({
        documents: [{ path: draft, contentHash: contentResourceHash(fs.readFileSync(path.join(stagingRoot, 'docs', draft), 'utf-8')) }],
      });
      // 真实快照（与发布前 verifySnapshotIntact 同一扫描口径）
      const scanResult = RawSourceSnapshot.scan(raw, documents as never, () => []);
      expect(scanResult.entries.length).toBe(1);
      const snapshot = RawSourceSnapshot.fromEntries(scanResult.entries, { sheetCsvPaths: () => [] });
      const internal = service as unknown as { active: Map<string, { buildState: unknown; leaderRun?: unknown; leaderPipelineContext?: unknown }> };
      const entry = {
        events: [] as Array<{ seq: number; event: string; data: unknown }>,
        nextSeq: 1,
        buildState: { snapshot, stagingRoot, knowledgeBaseRoot: raw, workset: new Map([['tok1', 'rebuild']]), writtenPaths: new Set([draft]), finishInfo: null, docMeta: new Map() },
        leaderRun: { generation: 2, spec: { publicationPolicy: 'auto' } },
        leaderPipelineContext: { effectiveMode: 'full', sourceSnapshotHash: 'a'.repeat(64), baseReleaseId: null, model: null, updateKbBuild: () => undefined },
      };
      internal.active.set(buildId, entry);
      // 1) 候选漂移 → 拒绝
      const drift = await service.executeLeaderPublishRequest({ buildId, generation: 2, candidateHash: 'd'.repeat(64), requestedRevision: null, summary: null });
      expect(drift.accepted).toBe(false);
      expect(String(drift.result.reason)).toBe('candidate_conflict');
      // 2) 代次不符 → 拒绝
      const staleGen = await service.executeLeaderPublishRequest({ buildId, generation: 1, candidateHash, requestedRevision: null, summary: null });
      expect(staleGen.accepted).toBe(false);
      expect(String(staleGen.result.reason)).toBe('generation_mismatch');
      // 3) 发布窗口已结算 → 拒绝新发布申请（被接受 revision 不被替换）
      (entry.leaderRun as { publishLock?: unknown }).publishLock = { candidateHash: 'f'.repeat(64), revision: null, settledAt: new Date().toISOString() };
      const settled = await service.executeLeaderPublishRequest({ buildId, generation: 2, candidateHash, requestedRevision: null, summary: null });
      expect(settled.accepted).toBe(false);
      expect(String(settled.result.reason)).toBe('publish_window_settled');
      delete (entry.leaderRun as { publishLock?: unknown }).publishLock;
      // 4) 取消竞态 → 发布拒绝（CURRENT 未切换）
      (entry as { cancelRequested?: boolean }).cancelRequested = true;
      const cancelled = await service.executeLeaderPublishRequest({ buildId, generation: 2, candidateHash, requestedRevision: null, summary: null });
      expect(cancelled.accepted).toBe(false);
      expect(String(cancelled.result.reason)).toBe('build_cancelled');
      (entry as { cancelRequested?: boolean }).cancelRequested = false;
      // 5) 坏候选（staging 混入非 md）→ 真实校验失败（不假发布）
      fs.writeFileSync(path.join(stagingRoot, 'docs', 'stray.txt'), 'x');
      const tampered = await service.executeLeaderPublishRequest({ buildId, generation: 2, candidateHash, requestedRevision: null, summary: null });
      expect(tampered.accepted).toBe(false);
      expect(String(tampered.result.reason)).toBe('kb_validation_failed');
      fs.rmSync(path.join(stagingRoot, 'docs', 'stray.txt'));
      // 6) 变化来源（快照后源被改）→ 快照完整性复核拒绝
      fs.writeFileSync(path.join(raw, 'docs', 'src1.md'), '# 源文档\n\n内容规则一（已被外部修改）。\n');
      const changed = await service.executeLeaderPublishRequest({ buildId, generation: 2, candidateHash, requestedRevision: null, summary: null });
      expect(changed.accepted).toBe(false);
      expect(String(changed.result.reason)).toBe('source_changed_during_build');
      fs.writeFileSync(path.join(raw, 'docs', 'src1.md'), '# 源文档\n\n内容规则一。\n');
      // 7) 候选一致、真实校验通过但无有效审查 → canPublish 阻断（不假发布）
      const blocked = await service.executeLeaderPublishRequest({ buildId, generation: 2, candidateHash, requestedRevision: null, summary: '缺审查' });
      expect(blocked.accepted).toBe(false);
      expect(String(blocked.result.reason)).toBe('kb_publish_blocked');
      // 未发布：CURRENT 不存在
      expect(fs.existsSync(path.join(outputRoot, 'CURRENT'))).toBe(false);
      internal.active.delete(buildId);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});

void ToolError;
