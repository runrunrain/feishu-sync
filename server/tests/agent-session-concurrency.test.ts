import { modelRevision } from '../src/agent/model-revision.js';
/**
 * F3-R04/R05/R06 受控并发回归：会话投递、容量预留与 busy/idle 生命周期
 *
 * - R04：steer/followUp 必须投递到【同一活跃 RPC 运行】——直接向运行中
 *   pi 进程发官方 steer/follow_up 命令（pi 自带队列语义），不新建第二
 *   run、不 removeAllListeners 抹掉原 run 的 SSE 转发；无 delivery → 409；
 *   运行中切模式 → 409；收尾窗口（进程已退）→ 409 而非伪造投递。
 * - R05：容量先预留后 spawn（reserveSlot/register 消费/释放幂等/closeAll
 *   拒绝）；池满时第二会话立即 agent_busy 失败，不 spawn 新 OS 进程。
 * - R06：busy 挂起 idle 回收；运行结束重起完整 idle 窗口（fake timers）。
 *
 * FakeRpcProcess 是 PiRpcProcess 接口的受控 double（记录 prompt 与
 * sendCommand；steer 断言的是「服务发出官方命令」本身，真实协议往返在
 * app-llm-fixture.test.ts 用真实 pi 覆盖）。
 */

import { describe, expect, it, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SessionService } from '../src/agent/session-service.js';
import type { SessionStoreApi } from '../src/agent/session-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import type { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import type { Config } from '../src/types/index.js';
import { collectResolvedRuntimeProtectedRoots } from '../src/agent/protected-roots.js';
import { makeRuntimeInstallation } from './helpers/runtime-installation.js';

class FakeRpcProcess extends EventEmitter {
  prompts: string[] = [];
  commands: Array<{ type: string; payload: unknown }> = [];
  removeAllListenersCount = 0;
  terminated = false;
  exited = false;
  stateGate: Promise<unknown> | null = null;
  active = false;
  private resolvers: Array<(value: unknown) => void> = [];

  isExited(): boolean { return this.exited; }
  hasActiveRun(): boolean { return this.active; }
  async start(): Promise<void> {}
  async prompt(message: string, _options: unknown): Promise<unknown> {
    this.prompts.push(message);
    this.active = true;
    return new Promise((resolve) => { this.resolvers.push(resolve); });
  }
  resolvePrompt(value: unknown): void {
    this.active = false;
    this.resolvers.shift()?.(value);
  }
  async sendCommand(type: string, payload: unknown, _timeout?: number): Promise<unknown> {
    this.commands.push({ type, payload });
    if (type === 'get_state') return this.stateGate ?? { success: true, data: {} };
    return { success: true, data: { disposition: 'queued' } };
  }
  async abort(): Promise<void> {}
  async terminate(): Promise<void> { this.terminated = true; this.emit('exit'); }
  removeAllListeners(event?: string | symbol): this {
    this.removeAllListenersCount += 1;
    return super.removeAllListeners(event);
  }
}

const temporaryRoots: string[] = [];
afterAll(() => { for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true }); });

function makeStore(): SessionStoreApi {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    getAgentSession: (id: string) => (rows.get(id) ? { ...rows.get(id)! } : null),
    createAgentSession: (input: { id: string; title: string; mode: string; workspaceId: string | null; createdAt: string; updatedAt: string }) => {
      rows.set(input.id, {
        id: input.id, title: input.title, mode: input.mode, workspace_id: input.workspaceId,
        pi_session_file: null, last_error_code: null, last_error_message: null,
        created_at: input.createdAt, updated_at: input.updatedAt, deleted_at: null,
      });
    },
    updateAgentSession: (id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id);
      if (!row) throw new Error(`agent_session 不存在: ${id}`);
      const mapped: Record<string, unknown> = {};
      if ('title' in patch) mapped.title = patch.title;
      if ('mode' in patch) mapped.mode = patch.mode;
      if ('workspaceId' in patch) mapped.workspace_id = patch.workspaceId;
      if ('piSessionFile' in patch) mapped.pi_session_file = patch.piSessionFile;
      if ('lastErrorCode' in patch) mapped.last_error_code = patch.lastErrorCode;
      if ('lastErrorMessage' in patch) mapped.last_error_message = patch.lastErrorMessage;
      rows.set(id, { ...row, ...mapped });
    },
    listSessionsByWorkspace: (workspaceId: string) =>
      [...rows.values()].filter((row) => row.workspace_id === workspaceId && !row.deleted_at),
  } as SessionStoreApi;
}

function makeConfig(): Config {
  return {
    llm: {
      openAiCompatBaseUrl: 'https://x/v1', apiKey: '', model: 'm', temperature: 0.2,
      primaryChannel: 'direct', fallbackOnFailure: false,
    },
    agent: {
      runtime: {},
      model: { source: 'app-llm', thinkingLevel: 'off', contextWindow: 128000, maxTokens: 8192 },
      maxConcurrentProcesses: 2,
      idleTimeoutMinutes: 10,
      workspaces: [],
    },
    standardKb: {
      outputRoot: '/tmp/conc-out-none', retainReleases: 3, buildBatchSize: 10,
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 180, autoBuildAfterSync: false,
    },
    pollIntervalMinutes: 30,
    knowledgeBaseRoot: '/tmp/conc-kb-none',
    watchedRoots: [],
    watchedRootUrls: [],
    requiredScopes: [],
    enableAutoStart: true,
  } as unknown as Config;
}

function makeService(options: { maxConcurrentProcesses?: number; idleTimeoutMinutes?: number } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'conc-it-'));
  temporaryRoots.push(dataRoot);
  const store = makeStore();
  const pool = new AgentProcessPool({
    maxConcurrentProcesses: options.maxConcurrentProcesses ?? 2,
    idleTimeoutMinutes: options.idleTimeoutMinutes ?? 10,
  });
  const config = makeConfig();
  // 受控测试只需要解析 fixture，不执行临时 POSIX 脚本（Windows 也可运行）。
  const resolver = new PiRuntimeResolver({ execNodeVersion: async () => '24.21.0' });
  const service = new SessionService({
    dataRoot,
    pool,
    toolService: new AgentToolService({ dataRoot, documentsProvider: () => [] }),
    resolver,
    configProvider: () => config,
    internalBaseUrl: () => 'http://127.0.0.1:39999',
    extensionPath: () => null,
    workspaceGuards: () => ({
      knowledgeBaseRoot: config.knowledgeBaseRoot,
      outputRoot: config.standardKb.outputRoot,
      dataRoot,
      protectedRoots: collectResolvedRuntimeProtectedRoots(resolver),
    }),
  });
  // Injected fake processes represent an already-spawned session at this configuration.
  const register = pool.register.bind(pool);
  vi.spyOn(pool, 'register').mockImplementation((...args) => {
    (service as unknown as { modelRevisions: WeakMap<PiRpcProcess, string> }).modelRevisions.set(args[1], modelRevision(config));
    return register(...args);
  });
  return { service, store, pool, config };
}

function createSession(store: SessionStoreApi, id: string): void {
  const iso = new Date().toISOString();
  store.createAgentSession({ id, title: `T-${id}`, mode: 'discuss', workspaceId: null, createdAt: iso, updatedAt: iso });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function captureRunEnd(service: SessionService, sessionId: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      service.off('sse', handler);
      reject(new Error('run_end 超时'));
    }, 5000);
    const handler = (evt: { sessionId: string; event: string; data: unknown }) => {
      if (evt.sessionId === sessionId && evt.event === 'run_end') {
        clearTimeout(timer);
        service.off('sse', handler);
        resolve(evt.data as Record<string, unknown>);
      }
    };
    service.on('sse', handler);
  });
}

describe('R04：steer/followUp 投递同一活跃 RPC 运行', () => {
  it.each(['steer', 'followUp'])('RPC已经完成、await尚未恢复时 %s 也返回409', async (delivery) => {
    const { service, store, pool } = makeService();
    createSession(store, 'microtask');
    const fake = new FakeRpcProcess();
    pool.register('microtask', fake as unknown as PiRpcProcess, 'session');
    await service.sendMessage(store, 'microtask', { text: '运行' });
    fake.resolvePrompt({ outcome: 'completed' });
    // 不await flush：executeRun此时还没有机会把phase改为settling。
    const rejected = service.sendMessage(store, 'microtask', { text: '已经迟到', delivery });
    await expect(rejected).rejects.toMatchObject({ code: 'session_busy', status: 409 });
    expect(fake.commands.some((c) => c.type === 'steer' || c.type === 'follow_up')).toBe(false);
    await flush();
    await pool.closeAll();
  });

  it.each(['steer', 'followUp'])('活进程 settled 后延迟 get_state：%s 返回409，收尾后新消息启动新run', async (delivery) => {
    const { service, store, pool } = makeService();
    createSession(store, 'settling');
    const fake = new FakeRpcProcess();
    let releaseState!: (value: unknown) => void;
    fake.stateGate = new Promise((resolve) => { releaseState = resolve; });
    pool.register('settling', fake as unknown as PiRpcProcess, 'session');
    const first = await service.sendMessage(store, 'settling', { text: '第一轮' });
    const ended = captureRunEnd(service, 'settling');
    fake.resolvePrompt({ outcome: 'completed' });
    await ended;
    expect(fake.isExited()).toBe(false);
    expect(fake.commands.some((c) => c.type === 'get_state')).toBe(true);
    expect(service.isRunning('settling')).toBe(true);
    try {
      await expect(service.sendMessage(store, 'settling', { text: '迟到消息', delivery }))
        .rejects.toMatchObject({ code: 'session_busy', status: 409 });
      await expect(service.switchMode(store, 'settling', { mode: 'work' }))
        .rejects.toMatchObject({ code: 'session_busy', status: 409 });
      expect(fake.commands.filter((c) => c.type === 'steer' || c.type === 'follow_up')).toEqual([]);
    } finally {
      releaseState({ success: true, data: {} });
    }
    await flush();
    expect(service.isRunning('settling')).toBe(false);
    const next = await service.sendMessage(store, 'settling', { text: '新一轮' });
    expect(next.runId).not.toBe(first.runId);
    expect(fake.prompts).toEqual(['第一轮', '新一轮']);
    fake.resolvePrompt({ outcome: 'completed' });
    await flush();
    await pool.closeAll();
  });

  it('steer → 官方 steer 命令、runId 不变、不抹旧监听器', async () => {
    const { service, store, pool } = makeService();
    createSession(store, 's1');
    const fake = new FakeRpcProcess();
    pool.register('s1', fake as unknown as PiRpcProcess, 'session');
    const first = await service.sendMessage(store, 's1', { text: '第一个问题' });
    await flush();
    expect(fake.prompts).toEqual(['第一个问题']);
    const listenersBefore = fake.removeAllListenersCount;
    const second = await service.sendMessage(store, 's1', { text: '转向：改做这件事', delivery: 'steer' });
    expect(second.accepted).toBe(true);
    expect(second.runId).toBe(first.runId);
    const steer = fake.commands.find((command) => command.type === 'steer');
    expect(steer?.payload).toEqual({ message: '转向：改做这件事' });
    expect(fake.removeAllListenersCount).toBe(listenersBefore); // 未重挂监听（原 run SSE 不中断）
    expect(service.isRunning('s1')).toBe(true); // 原运行仍活跃
    fake.resolvePrompt({ outcome: 'completed' });
    await flush();
    expect(service.isRunning('s1')).toBe(false);
  });

  it('followUp → follow_up 命令', async () => {
    const { service, store, pool } = makeService();
    createSession(store, 's2');
    const fake = new FakeRpcProcess();
    pool.register('s2', fake as unknown as PiRpcProcess, 'session');
    await service.sendMessage(store, 's2', { text: '首个任务' });
    await flush();
    const second = await service.sendMessage(store, 's2', { text: '结束后再查这个', delivery: 'followUp' });
    expect(second.accepted).toBe(true);
    expect(fake.commands.some((command) => command.type === 'follow_up'
      && (command.payload as { message?: string })?.message === '结束后再查这个')).toBe(true);
    fake.resolvePrompt({ outcome: 'completed' });
    await flush();
  });

  it('运行中无 delivery → 409 session_busy（不新建第二个 run）', async () => {
    const { service, store, pool } = makeService();
    createSession(store, 's3');
    const fake = new FakeRpcProcess();
    pool.register('s3', fake as unknown as PiRpcProcess, 'session');
    await service.sendMessage(store, 's3', { text: '运行中' });
    await flush();
    await expect(service.sendMessage(store, 's3', { text: '挤进来' }))
      .rejects.toMatchObject({ code: 'session_busy', status: 409 });
    expect(fake.prompts).toHaveLength(1); // 没有第二次 prompt
    fake.resolvePrompt({ outcome: 'completed' });
    await flush();
  });

  it('运行中切换模式 → 409', async () => {
    const { service, store, pool } = makeService();
    createSession(store, 's4');
    const fake = new FakeRpcProcess();
    pool.register('s4', fake as unknown as PiRpcProcess, 'session');
    await service.sendMessage(store, 's4', { text: '运行中' });
    await flush();
    await expect(service.switchMode(store, 's4', { mode: 'work' }))
      .rejects.toMatchObject({ code: 'session_busy', status: 409 });
    fake.resolvePrompt({ outcome: 'completed' });
    await flush();
  });

  it('收尾窗口（进程已退出、run 未清理）→ steer 409 而非伪造投递', async () => {
    const { service, store, pool } = makeService();
    createSession(store, 's5');
    const fake = new FakeRpcProcess();
    pool.register('s5', fake as unknown as PiRpcProcess, 'session');
    await service.sendMessage(store, 's5', { text: '运行中' });
    await flush();
    fake.exited = true; // 池条目视为退出，但 run 记录仍在（executeRun 未收尾）
    await expect(service.sendMessage(store, 's5', { text: '迟到的 steer', delivery: 'steer' }))
      .rejects.toMatchObject({ code: 'session_busy', status: 409 });
    expect(fake.commands.some((command) => command.type === 'steer')).toBe(false);
    fake.resolvePrompt({ outcome: 'completed' });
    await flush();
  });
});

describe('R01：spawn前复用完整运行根策略', () => {
  it('旧Work绑定在npm包内：resolve后立即拒绝，不spawn、不发能力令牌', async () => {
    const { service, store, pool, config } = makeService();
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-npm-'));
    temporaryRoots.push(fixtureRoot);
    const fixture = makeRuntimeInstallation(fixtureRoot);
    config.agent.runtime = { nodePath: fixture.nodePath };
    config.agent.workspaces = [{ id: 'old-npm', name: '旧授权', path: fixture.npmRoot, createdAt: new Date().toISOString() }];
    createSession(store, 'old-work');
    store.updateAgentSession('old-work', { mode: 'work', workspaceId: 'old-npm' });
    const ended = captureRunEnd(service, 'old-work');
    await service.sendMessage(store, 'old-work', { text: '不能改写运行代码' });
    const event = await ended;
    expect(event.outcome).toBe('failed');
    expect(event.error).toMatchObject({ code: 'workspace_path_forbidden' });
    expect(pool.runningCount()).toBe(0);
    expect(pool.loadCount()).toBe(0);
    expect(fs.existsSync(fixture.marker)).toBe(false);
    await pool.closeAll();
  });
});

describe('R05：容量预留（reserveSlot）', () => {
  it('池满拒绝预留；释放后可再预留', () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 1 });
    const slot = pool.reserveSlot();
    expect(slot).not.toBeNull();
    expect(pool.loadCount()).toBe(1);
    expect(pool.reserveSlot()).toBeNull();
    slot!.release();
    expect(pool.loadCount()).toBe(0);
    expect(pool.reserveSlot()).not.toBeNull();
  });

  it('register 消费预留：容量计数不重复，再 release 幂等', () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 1 });
    const slot = pool.reserveSlot();
    pool.register('k1', new FakeRpcProcess() as unknown as PiRpcProcess, 'session', slot!);
    expect(pool.loadCount()).toBe(1); // 已注册 1 + 预留 0
    expect(pool.reserveSlot()).toBeNull(); // 不超发
    slot!.release(); // 消费后的 release 是幂等空操作
    expect(pool.loadCount()).toBe(1);
  });

  it('closeAll 后拒绝预留（不再 spawn）', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    await pool.closeAll();
    expect(pool.reserveSlot()).toBeNull();
  });

  it('进程 exit → 池条目移除（exit 即回收的池侧契约）', () => {
    const pool = new AgentProcessPool();
    const fake = new FakeRpcProcess();
    pool.register('k2', fake as unknown as PiRpcProcess, 'session');
    expect(pool.has('k2')).toBe(true);
    fake.emit('exit');
    expect(pool.has('k2')).toBe(false);
  });

  it('池满时第二会话立即 agent_busy 失败，不 spawn 新进程', async () => {
    const { service, store, pool } = makeService({ maxConcurrentProcesses: 1 });
    pool.register('other', new FakeRpcProcess() as unknown as PiRpcProcess, 'session'); // 占满
    createSession(store, 's2');
    const runEnd = captureRunEnd(service, 's2');
    await service.sendMessage(store, 's2', { text: 'hi' });
    const event = await runEnd;
    expect(event.outcome).toBe('failed');
    expect((event.error as { code?: string }).code).toBe('agent_busy');
    expect(store.getAgentSession('s2')?.last_error_code).toBe('agent_busy');
    expect(pool.runningCount()).toBe(1); // 没有第二个进程
  });
});

describe('R06：busy/idle 生命周期', () => {
  it('busy 挂起 idle 回收；运行结束重起完整 idle 窗口', async () => {
    vi.useFakeTimers();
    try {
      const { service, store, pool } = makeService({ maxConcurrentProcesses: 1, idleTimeoutMinutes: 1 });
      createSession(store, 's6');
      const fake = new FakeRpcProcess();
      pool.register('s6', fake as unknown as PiRpcProcess, 'session');
      await service.sendMessage(store, 's6', { text: '长任务' });
      await vi.advanceTimersByTimeAsync(1);
      expect(pool.isBusy('s6')).toBe(true);
      // busy 期间：远超 idle 窗口也不回收（prompt 不得中途被杀）
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pool.has('s6')).toBe(true);
      expect(fake.terminated).toBe(false);
      // 运行结束 → 完整窗口重新起算
      fake.resolvePrompt({ outcome: 'completed' });
      await vi.advanceTimersByTimeAsync(1);
      expect(pool.isBusy('s6')).toBe(false);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(pool.has('s6')).toBe(true); // 窗口内（59s < 60s）
      await vi.advanceTimersByTimeAsync(2_000);
      expect(pool.has('s6')).toBe(false); // 超窗口回收
      expect(fake.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
