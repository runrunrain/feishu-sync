/**
 * S6 任务编排（设计 kb-agent-upgrade §5.5 验收行）假 pi 回归：
 * DONE→done；BLOCKED→resume→done；缺 marker→nudge→failed；取消（运行中/
 * 排队中）；重启→interrupted；工具交集（子任务无 task_*、编排关闭无
 * task_*）；outputDir 重叠拒绝；编排开关（AppPluginStore orchestration 条目）。
 *
 * FakeTaskRpc 是 PiRpcProcess 的受控 double（脚本化 prompt 结果）；
 * TaskService 经 deps.spawner 注入，不触真实 pi/网络。
 */

import { describe, expect, it, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { RoleRegistry } from '../src/agent/tasks/role-registry.js';
import {
  TaskService,
  parseTaskReply,
  taskSeqSegment,
  validateOutputDirRel,
  resolveTaskWorkspaceRoot,
  type TaskParentInfo,
} from '../src/agent/tasks/task-service.js';
import { taskToolFamily } from '../src/agent/tasks/task-tools.js';
import { AppPluginStore } from '../src/agent/app-plugin-store.js';
import type { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import type { Config } from '../src/types/index.js';

const rolesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/agent/roles');

/** 假 pi 子进程：prompt 按脚本队列出队；队列为空时挂起（供取消测试）。 */
class FakeTaskRpc extends EventEmitter {
  prompts: string[] = [];
  aborted = false;
  terminated = false;
  exited = false;
  /** R2-03：terminate 前注入的可控延迟（复现 blocked→resume→释放窗口） */
  terminateDelay: Promise<unknown> | null = null;
  private pending: Array<(value: unknown) => void> = [];

  constructor(private script: Array<Record<string, unknown>>) {
    super();
  }

  isExited(): boolean { return this.exited; }
  hasActiveRun(): boolean { return this.pending.length > 0; }
  async start(): Promise<void> {}
  async prompt(message: string): Promise<unknown> {
    this.prompts.push(message);
    const next = this.script.shift();
    if (next === undefined) return new Promise((resolve) => { this.pending.push(resolve); });
    return next;
  }
  async sendCommand(type: string): Promise<unknown> {
    return type === 'get_state' ? { success: true, data: {} } : { success: true, data: {} };
  }
  async abort(): Promise<void> {
    this.aborted = true;
    while (this.pending.length > 0) this.pending.shift()?.({ outcome: 'aborted' });
  }
  async terminate(): Promise<void> {
    if (this.terminateDelay) await this.terminateDelay;
    this.terminated = true;
    this.exited = true;
    this.emit('exit');
  }
}

const temporaryRoots: string[] = [];
const pools: AgentProcessPool[] = [];
// 先 await closeAll 再删临时根：closeAll 的排队者拒绝链（dispatchRound
// catch→finish 落库）需要 store 仍可用——不等得 rmSync 会让迟到落库撞
// 上已删除的 DB（SqliteError 循环放大，T3d 实测）。
afterAll(async () => {
  for (const pool of pools) await pool.closeAll();
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function makeConfig(): Config {
  return {
    llm: {
      openAiCompatBaseUrl: 'https://x/v1', apiKey: '', model: 'm', temperature: 0.2,
      primaryChannel: 'direct', fallbackOnFailure: false,
    },
    agent: {
      runtime: {},
      model: { source: 'app-llm', thinkingLevel: 'off', contextWindow: 128000, maxTokens: 8192 },
      orchestration: { maxActiveTasksPerSession: 8, taskTimeoutMinutes: 30 },
      maxConcurrentProcesses: 3,
      idleTimeoutMinutes: 10,
      workspaces: [],
    },
    standardKb: {
      outputRoot: '/tmp/task-out', retainReleases: 3, buildBatchSize: 10,
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 180, autoBuildAfterSync: false,
    },
  } as unknown as Config;
}

interface EnvOptions {
  mode?: 'discuss' | 'work';
  workspacePath?: string | null;
  /** 每次 spawn 的脚本（一任务一轮一 rpc；nudge 轮同 rpc 追加） */
  scripts?: Array<Array<Record<string, unknown>>>;
  orchestration?: boolean;
  pool?: AgentProcessPool;
  /** R2-01：额外可解析的父会话（跨会话归属测试） */
  extraSessions?: TaskParentInfo[];
  /** R2-03：所有子进程 terminate 前注入的可控延迟 */
  terminateDelay?: Promise<unknown>;
  /** R2-05：真实 AppPluginStore（native 一致性测试；native 资源由 store 闭包可变对象提供） */
  pluginStore?: AppPluginStore;
}

function makeEnv(opts: EnvOptions = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tasks-'));
  temporaryRoots.push(dataRoot);
  const store = new LocalMapStore(path.join(dataRoot, 'feishu-sync.db'));
  store.initialize();
  const pool = opts.pool ?? new AgentProcessPool({ maxConcurrentProcesses: 3 });
  pools.push(pool);
  const toolService = new AgentToolService({ dataRoot, documentsProvider: () => [] });
  const scriptQueue = [...(opts.scripts ?? [])];
  const session: TaskParentInfo = {
    id: 'sess1',
    mode: opts.mode ?? 'discuss',
    workspaceId: opts.workspacePath ? 'ws_test1' : null,
    workspacePath: opts.workspacePath ?? null,
  };
  const extraSessions = opts.extraSessions ?? [];
  // R2-02：dispatch 按任务冻结的 workspaceId 从当前配置解析——work 模式
  // 测试必须把 ws_test1 登记进配置；测试可直接改 env.config 模拟移除。
  const config = makeConfig();
  if (opts.workspacePath) {
    config.agent.workspaces = [{
      id: 'ws_test1', name: '测试工作区', path: opts.workspacePath,
      createdAt: new Date().toISOString(),
    }];
  }
  const updates: Array<{ sessionId: string; status: string }> = [];
  const rpcs: FakeTaskRpc[] = [];
  const spawnInputs: import('../src/agent/tasks/task-service.js').TaskSpawnInput[] = [];
  const service = new TaskService({
    dataRoot,
    pool,
    toolService,
    roles: new RoleRegistry(rolesDir),
    resolver: new PiRuntimeResolver(),
    configProvider: () => config,
    sessionInfo: (id) => (id === session.id ? session : extraSessions.find((candidate) => candidate.id === id) ?? null),
    internalBaseUrl: () => 'http://127.0.0.1:39999',
    emitTaskUpdate: (sessionId, dto) => updates.push({ sessionId, status: dto.status }),
    extensionPath: () => null,
    orchestrationEnabled: () => opts.orchestration ?? true,
    ...(opts.pluginStore ? {
      pluginRevision: (scope) => {
        try { return opts.pluginStore!.snapshot(scope).revision; } catch { return null; }
      },
      frozenSnapshot: (scope, revision) => opts.pluginStore!.frozenSnapshot(scope, revision),
    } : {}),
    spawner: async (input) => {
      spawnInputs.push(input);
      // 与生产 spawnProcess 同构的快照门：pluginRevision 冻结的任务按
      // revision 重建快照（AppPluginStore.frozenSnapshot 原生资源一致性
      // 校验——不匹配即抛 plugin_snapshot_stale → dispatchRound 落 failed）。
      if (opts.pluginStore && input.task.pluginRevision) {
        opts.pluginStore.frozenSnapshot(input.task.parentMode, input.task.pluginRevision);
      }
      const rpc = new FakeTaskRpc(scriptQueue.shift() ?? []);
      if (opts.terminateDelay) rpc.terminateDelay = opts.terminateDelay;
      rpcs.push(rpc);
      return rpc as unknown as PiRpcProcess;
    },
  });
  toolService.registerToolFamily(taskToolFamily({ service, store }));
  return {
    dataRoot, store, pool, toolService, service, updates, rpcs, spawnInputs, config,
    lastRpc: () => rpcs[rpcs.length - 1],
    session,
  };
}

const DONE = (text: string) => ({ outcome: 'completed', lastAssistantText: `${text}\n<!--FS:DONE-->` });
const BLOCKED = (questions: string) => ({ outcome: 'completed', lastAssistantText: `<!--FS:BLOCKED-->\nQUESTIONS: ${questions}` });
const PLAIN = (text: string) => ({ outcome: 'completed', lastAssistantText: text });

function submitAnalyst(env: ReturnType<typeof makeEnv>, title = '分析任务', task = '阅读并总结指定材料') {
  return env.service.submit(env.store, {
    sessionId: env.session.id, role: 'kb-analyst', title, task,
  });
}

/** 同步 submit 报错断言（submit 不返回 promise，rejects 不适用）。 */
function expectSyncToolError(fn: () => unknown, code: string, status?: number): void {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject(status !== undefined ? { code, status } : { code });
    return;
  }
  throw new Error(`期望抛出 ${code}，但调用成功`);
}

describe('RoleRegistry（角色卡装载）', () => {
  it('内置三张卡：frontmatter 与设计 §5.1 表一致', () => {
    const registry = new RoleRegistry(rolesDir);
    const analyst = registry.get('kb-analyst');
    expect(analyst?.requiresMode).toBe('any');
    expect(analyst?.tools).toEqual(['kb_search', 'kb_read', 'raw_search', 'raw_read', 'raw_read_image']);
    expect(registry.get('kb-converter')?.requiresMode).toBe('work');
    expect(registry.get('kb-converter')?.tools).toContain('ws_write');
    expect(registry.get('kb-reviewer')?.tools).toContain('ws_search');
    expect(registry.size()).toBe(3);
    expect(analyst?.body).toContain('分析员');
  });

  it('符号链接拒绝、非法 frontmatter 跳过并告警', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-roles-'));
    temporaryRoots.push(dir);
    fs.writeFileSync(path.join(dir, 'good.md'), '---\nname: good\nlabel: 好\ndescription: d\ntools: [kb_search]\nrequiresMode: any\n---\n正文');
    fs.symlinkSync(path.join(dir, 'good.md'), path.join(dir, 'evil.md'));
    fs.writeFileSync(path.join(dir, 'bad.md'), '---\nname: bad\nlabel: 坏\ntools: [kb_search]\n---\n正文');
    const registry = new RoleRegistry(dir);
    expect(registry.size()).toBe(1);
    expect(registry.get('good')?.label).toBe('好');
    expect(registry.get('evil')).toBeNull();
    expect(registry.get('bad')).toBeNull();
  });
});

describe('marker 协议与 outputDir 校验', () => {
  it('DONE 末行 / BLOCKED 首行 / 缺 marker 为 null；BLOCKED 剥离 QUESTIONS 前缀', () => {
    expect(parseTaskReply('结论\n\n<!--FS:DONE-->')).toEqual({ kind: 'done', result: '结论' });
    const blocked = parseTaskReply('<!--FS:BLOCKED-->\nQUESTIONS: 需要哪个文档？\n- 文档A');
    expect(blocked).toEqual({ kind: 'blocked', questions: '需要哪个文档？\n- 文档A' });
    expect(parseTaskReply('没有 marker 的回复')).toBeNull();
    expect(parseTaskReply('<!--FS:DONE-->\n在末行之后还有内容')).toBeNull();
  });

  it('outputDir：规范化尾斜杠；拒绝绝对路径/..段/隐藏段', () => {
    expect(validateOutputDirRel('out/sub/')).toBe('out/sub');
    expect(() => validateOutputDirRel('/abs')).toThrow();
    expect(() => validateOutputDirRel('../up')).toThrow();
    expect(() => validateOutputDirRel('out/.hidden')).toThrow();
    expect(() => validateOutputDirRel('a\\b')).toThrow();
  });

  it('T3b-04：resolveTaskWorkspaceRoot 父 Workspace 围栏（symlink 段拒绝 + 逐级创建）', () => {
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-ws-'));
    temporaryRoots.push(wsRoot);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'task-ext-'));
    temporaryRoots.push(external);
    const session: TaskParentInfo = {
      id: 'sess1', mode: 'work', workspaceId: 'ws1', workspacePath: wsRoot,
    };

    // 祖先 symlink 指向外部：拒绝（无论目标子目录是否已存在）
    fs.symlinkSync(external, path.join(wsRoot, 'link'));
    expect(() => resolveTaskWorkspaceRoot(session.workspacePath, 'link/sub')).toThrow(/outputDir 越出/);
    fs.mkdirSync(path.join(external, 'pre'), { recursive: true });
    expect(() => resolveTaskWorkspaceRoot(session.workspacePath, 'link/pre')).toThrow(/outputDir 越出/);

    // 深层 symlink（第二段）：同样拒绝
    fs.mkdirSync(path.join(wsRoot, 'real'));
    fs.symlinkSync(external, path.join(wsRoot, 'real', 'link2'));
    expect(() => resolveTaskWorkspaceRoot(session.workspacePath, 'real/link2/x')).toThrow(/outputDir 越出/);

    // 正常路径：逐级创建并返回父根内 realpath
    const resolved = resolveTaskWorkspaceRoot(session.workspacePath, 'a/b/c');
    expect(resolved!.startsWith(fs.realpathSync(wsRoot) + path.sep)).toBe(true);
    expect(fs.statSync(resolved!).isDirectory()).toBe(true);
    // 已存在真实子目录复用
    expect(resolveTaskWorkspaceRoot(session.workspacePath, 'a/b')).toBe(fs.realpathSync(path.join(wsRoot, 'a', 'b')));
    // 只读任务：父根原样；无 Workspace：undefined
    expect(resolveTaskWorkspaceRoot(session.workspacePath, null)).toBe(wsRoot);
    expect(resolveTaskWorkspaceRoot(null, 'a')).toBeUndefined();
  });
});

describe('假 pi 状态机（§5.5 验收行）', () => {
  it('DONE→done：result 剥离 marker；task_update 到达父会话；prompt 含角色正文与契约', async () => {
    const env = makeEnv({ scripts: [[DONE('分析结论：三条')]] });
    const dto = submitAnalyst(env);
    expect(['queued', 'running']).toContain(dto.status);
    await env.service.whenSettled(dto.id);
    const done = env.service.get(env.store, dto.id);
    expect(done.status).toBe('done');
    expect(done.result).toBe('分析结论：三条');
    expect(done.rounds).toBe(1);
    expect(done.error).toBeNull();
    expect(env.updates.some((u) => u.sessionId === 'sess1' && u.status === 'done')).toBe(true);
    const prompt = env.lastRpc().prompts[0];
    expect(prompt).toContain('知识库分析员');
    expect(prompt).toContain('<!--FS:DONE-->');
    expect(prompt).toContain('阅读并总结指定材料');
  });

  it('BLOCKED→resume→done：questions 落库；作答进入下一轮 prompt；rounds=2', async () => {
    const env = makeEnv({
      scripts: [
        [BLOCKED('需要哪个文档？')],
        [DONE('结论')],
      ],
    });
    const dto = submitAnalyst(env);
    await env.service.whenSettled(dto.id);
    const blocked = env.service.get(env.store, dto.id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.questions).toContain('需要哪个文档？');
    expect(blocked.result).toBeNull();

    const resumed = env.service.resume(env.store, dto.id, '文档A（objToken tok1）');
    expect(resumed.status).toBe('queued');
    await env.service.whenSettled(dto.id);
    const done = env.service.get(env.store, dto.id);
    expect(done.status).toBe('done');
    expect(done.result).toBe('结论');
    expect(done.rounds).toBe(2);
    const resumePrompt = env.lastRpc().prompts[0];
    expect(resumePrompt).toContain('文档A（objToken tok1）');
    expect(resumePrompt).toContain('阅读并总结指定材料'); // resume 轮自包含（防 JSONL 恢复失败）
  });

  it('缺 marker→一次 nudge→仍缺→failed(task_contract_missing)', async () => {
    const env = makeEnv({
      scripts: [[PLAIN('第一轮没有标记'), PLAIN('第二轮还是没有标记')]],
    });
    const dto = submitAnalyst(env);
    await env.service.whenSettled(dto.id);
    const failed = env.service.get(env.store, dto.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('task_contract_missing');
    expect(env.lastRpc().prompts).toHaveLength(2);
    expect(env.lastRpc().prompts[1]).toContain('<!--FS:DONE-->');
    expect(failed.rounds).toBe(2);
  });

  it('取消运行中任务：abort 送达子进程，终态 cancelled', async () => {
    const env = makeEnv({ scripts: [[]] }); // 空 script：prompt 挂起
    const dto = submitAnalyst(env);
    await vi.waitFor(() => expect(env.service.get(env.store, dto.id).status).toBe('running'), { timeout: 3000 });
    const cancelled = await env.service.cancel(env.store, dto.id);
    expect(cancelled.status).toBe('cancelled');
    await env.service.whenSettled(dto.id);
    expect(env.lastRpc().aborted).toBe(true);
    expect(env.service.get(env.store, dto.id).status).toBe('cancelled');
    // 终态再取消 → 409 task_not_active
    await expect(env.service.cancel(env.store, dto.id)).rejects.toMatchObject({ code: 'task_not_active', status: 409 });
  });

  it('取消排队中任务：等待槽位时 abort 出队；queuePosition 反映会话内排队序', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 1 });
    const holdSlot = await pool.acquire('background');
    const holdRpc = new FakeTaskRpc([]);
    pool.register('hold', holdRpc, 'build', holdSlot);
    const env = makeEnv({ pool, scripts: [[DONE('ok')]] });
    const first = submitAnalyst(env, '任务一');
    const second = submitAnalyst(env, '任务二');
    expect(first.status).toBe('queued');
    await vi.waitFor(() => expect(env.pool.queueDepth()).toBe(2), { timeout: 3000 });
    expect(second.queuePosition).toBe(2);
    await env.service.cancel(env.store, first.id);
    expect(env.service.get(env.store, first.id).status).toBe('cancelled');
    holdRpc.terminate();
    await env.service.whenSettled(second.id);
    expect(env.service.get(env.store, second.id).status).toBe('done');
    holdSlot.release();
  });

  it('重启→interrupted：queued/running 置 interrupted，blocked 保留可作答', async () => {
    const env = makeEnv({ scripts: [] });
    const now = new Date().toISOString();
    for (const status of ['queued', 'running', 'blocked']) {
      env.store.createAgentTask({
        id: `t_restart_${status}`, sessionId: 'sess1', role: 'kb-analyst', title: status,
        taskText: 'x', status, parentMode: 'discuss', workspaceId: null, outputDir: null,
        toolsJson: '[]', pluginRevision: null, model: null, createdAt: now, updatedAt: now,
      });
    }
    const ids = env.service.reconcileOnStartup(env.store);
    expect(ids.sort()).toEqual(['t_restart_queued', 't_restart_running'].sort());
    expect(env.service.get(env.store, 't_restart_queued').status).toBe('interrupted');
    expect(env.service.get(env.store, 't_restart_blocked').status).toBe('blocked');
  });

  it('outputDir：converter 必填、同会话非终态互为前缀拒绝、终态后释放', async () => {
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-ws-'));
    temporaryRoots.push(wsRoot);
    const env = makeEnv({
      mode: 'work',
      workspacePath: wsRoot,
      scripts: [[DONE('写入完成')], [DONE('写入完成2')]],
    });
    // converter 必填 outputDir
    expectSyncToolError(() => env.service.submit(env.store, {
      sessionId: 'sess1', role: 'kb-converter', title: '无目录', task: 'x',
    }), 'task_output_dir_required');
    // discuss 会话不能派发 converter（requiresMode: work）
    const discussEnv = makeEnv({ scripts: [] });
    expectSyncToolError(() => discussEnv.service.submit(discussEnv.store, {
      sessionId: 'sess1', role: 'kb-converter', title: '模式不符', task: 'x', outputDir: 'out',
    }), 'task_role_not_allowed_in_mode');

    const first = env.service.submit(env.store, {
      sessionId: 'sess1', role: 'kb-converter', title: '转换一', task: '整理材料', outputDir: 'out',
    });
    // 互为前缀（含相等）拒绝
    for (const overlap of ['out', 'out/sub']) {
      expectSyncToolError(() => env.service.submit(env.store, {
        sessionId: 'sess1', role: 'kb-converter', title: '重叠', task: 'y', outputDir: overlap,
      }), 'task_output_dir_overlap', 409);
    }
    await env.service.whenSettled(first.id);
    expect(env.service.get(env.store, first.id).status).toBe('done');
    // 终态释放目录；不重叠目录并行允许
    const second = env.service.submit(env.store, {
      sessionId: 'sess1', role: 'kb-converter', title: '转换二', task: 'z', outputDir: 'out2',
    });
    expect(['queued', 'running']).toContain(second.status);
    await env.service.whenSettled(second.id);
    expect(env.service.get(env.store, second.id).status).toBe('done');
  });

  it('T3b-04：outputDir 祖先 symlink 指向外部目录 → 拒绝派发（不 spawn、不写入）', async () => {
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-ws-'));
    temporaryRoots.push(wsRoot);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'task-ext-'));
    temporaryRoots.push(external);
    fs.symlinkSync(external, path.join(wsRoot, 'link'));
    const env = makeEnv({ mode: 'work', workspacePath: wsRoot, scripts: [[DONE('x')]] });
    const dto = env.service.submit(env.store, {
      sessionId: 'sess1', role: 'kb-converter', title: '越权', task: 'x', outputDir: 'link/sub',
    });
    await env.service.whenSettled(dto.id);
    const row = env.service.get(env.store, dto.id);
    expect(row.status).toBe('failed');
    expect(row.error?.code).toBe('task_output_dir_invalid');
    // 未派发子进程；外部目录未被创建/写入
    expect(env.rpcs).toHaveLength(0);
    expect(fs.existsSync(path.join(external, 'sub'))).toBe(false);
  });

  it('T3b-04：正常子目录逐级创建并冻结在父根内；子任务照常完成', async () => {
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-ws-'));
    temporaryRoots.push(wsRoot);
    const env = makeEnv({ mode: 'work', workspacePath: wsRoot, scripts: [[DONE('写入完成')]] });
    const dto = env.service.submit(env.store, {
      sessionId: 'sess1', role: 'kb-converter', title: '正常写入', task: 'x', outputDir: 'a/b/c',
    });
    await env.service.whenSettled(dto.id);
    expect(env.service.get(env.store, dto.id).status).toBe('done');
    expect(fs.existsSync(path.join(wsRoot, 'a', 'b', 'c'))).toBe(true);
  });

  it('编排关闭：submit 403；白名单按族剔除 task_*（会话面）', async () => {
    const off = makeEnv({ orchestration: false, scripts: [] });
    expectSyncToolError(() => submitAnalyst(off), 'orchestration_disabled', 403);

    const ctx = off.toolService.createRunContext({
      runKind: 'discuss', sessionId: 'sess1', outputRoot: '/x', knowledgeBaseRoot: '/x',
      disableToolFamilies: ['task'],
    });
    expect(ctx.context.allowedTools.some((name) => name.startsWith('task_'))).toBe(false);
    // 族已注册但未剔除时（编排开启面）task_* 在派生白名单尾部
    const onCtx = off.toolService.createRunContext({
      runKind: 'discuss', sessionId: 'sess1', outputRoot: '/x', knowledgeBaseRoot: '/x',
    });
    expect(onCtx.context.allowedTools).toContain('task_submit');
  });

  it('工具交集：子任务 override 剔除 task_*/app_command/未知工具且保持顺序；执行面 403', async () => {
    const env = makeEnv({ scripts: [] });
    // 注册一个最小 ops 族使 app_command 成为「已知工具」，验证显式禁入
    env.toolService.registerToolFamily({
      name: 'ops-test',
      tools: [{
        spec: { name: 'app_command', label: '命令', description: '测试用', parameters: { type: 'object', properties: {} } },
        runKinds: ['discuss', 'work'],
        execute: () => ({ content: [] }),
      }],
    });
    const child = env.toolService.createRunContext({
      runKind: 'task', sessionId: 't_child',
      allowedToolsOverride: ['kb_search', 'ws_write', 'task_cancel', 'app_command', 'unknown_tool'],
      outputRoot: '/x', knowledgeBaseRoot: '/x',
    });
    expect(child.context.allowedTools).toEqual(['kb_search', 'ws_write']);
    await expect(env.toolService.executeTool(child.token, 'task_cancel', { taskId: 't_child' }))
      .rejects.toMatchObject({ code: 'tool_not_allowed', status: 403 });
  });

  it('task_query 经工具执行面：DONE 结果 >20000 字符截断并标记 resultTruncated', async () => {
    const longResult = '结'.repeat(25_000);
    const env = makeEnv({ scripts: [[DONE(longResult)]] });
    const dto = submitAnalyst(env);
    await env.service.whenSettled(dto.id);
    const { token } = env.toolService.createRunContext({
      runKind: 'discuss', sessionId: 'sess1', outputRoot: '/x', knowledgeBaseRoot: '/x',
    });
    const result = await env.toolService.executeTool(token, 'task_query', { taskIds: [dto.id] });
    const parsed = JSON.parse(result.content[0].text) as { tasks: Array<{ result: string | null; resultTruncated: boolean }> };
    expect(parsed.tasks[0].result?.length).toBe(20_000);
    expect(parsed.tasks[0].resultTruncated).toBe(true);
    // API 投影：库内 64KB 上限截断（'结' 3 字节 × 25000 → 60750 字节 ≈ 20250 字符），保留截断标记
    const apiDto = env.service.get(env.store, dto.id);
    expect(apiDto.result?.length).toBe(20_250);
    expect(apiDto.resultTruncated).toBe(true);
  });

  it('waitFor：all 模式下有 running 任务 → 超时；any 模式任一落定即返回', async () => {
    const env = makeEnv({ scripts: [] });
    const now = new Date().toISOString();
    const create = (id: string, status: string) => env.store.createAgentTask({
      id, sessionId: 'sess1', role: 'kb-analyst', title: id, taskText: 'x', status,
      parentMode: 'discuss', workspaceId: null, outputDir: null,
      toolsJson: '[]', pluginRevision: null, model: null, createdAt: now, updatedAt: now,
    });
    create('t_wait_done', 'done');
    create('t_wait_running', 'running');
    const all = await env.service.waitFor(env.store, 'sess1', ['t_wait_done', 't_wait_running'], 'all', 1);
    expect(all.timedOut).toBe(true);
    expect(all.tasks.find((t) => t.id === 't_wait_done')?.status).toBe('done');
    const any = await env.service.waitFor(env.store, 'sess1', ['t_wait_done', 't_wait_running'], 'any', 1);
    expect(any.timedOut).toBe(false);
  });

  it('每会话非终态上限：达到 maxActiveTasksPerSession 后 task_queue_full', async () => {
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 1 });
    const holdSlot = await pool.acquire('background');
    const holdRpc = new FakeTaskRpc([]);
    pool.register('hold', holdRpc, 'build', holdSlot);
    const env = makeEnv({ pool, scripts: [] });
    for (let i = 0; i < 8; i += 1) {
      env.service.submit(env.store, { sessionId: 'sess1', role: 'kb-analyst', title: `T${i}`, task: 'x' });
    }
    expectSyncToolError(() => env.service.submit(env.store, {
      sessionId: 'sess1', role: 'kb-analyst', title: '第九个', task: 'x',
    }), 'task_queue_full', 409);
    holdRpc.terminate();
    holdSlot.release();
  });
});

describe('编排开关（AppPluginStore orchestration 条目）', () => {
  it('默认停用、可启用；frozenSnapshot 按 revision 复用快照文件', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugins-6-'));
    temporaryRoots.push(dataRoot);
    const store = new AppPluginStore(dataRoot);
    const list = store.list();
    const orchestration = list.plugins.find((plugin) => plugin.id === 'orchestration');
    expect(orchestration).toMatchObject({ builtin: true, enabled: false, kind: 'context' });
    expect(orchestration?.scopes).toEqual(['discuss', 'work']);
    expect(orchestration?.content).toContain('task_submit');
    // 启用（沿用插件 overrides 面）
    const enabled = store.mutate('update', 'orchestration', list.revision, { enabled: true });
    expect(enabled.plugins.find((plugin) => plugin.id === 'orchestration')?.enabled).toBe(true);
    // frozenSnapshot：未知 revision → null；真实 snapshot revision → 文件存在
    expect(store.frozenSnapshot('work', 'deadbeef')).toBeNull();
    const snapshot = store.snapshot('work');
    const frozen = store.frozenSnapshot('work', snapshot.revision);
    expect(frozen?.revision).toBe(snapshot.revision);
    expect(fs.existsSync(frozen?.path ?? '')).toBe(true);
  });
});

describe('R2-01：task_resume/task_cancel 跨会话越权拒绝', () => {
  it('B 会话 resume/cancel A 的任务 → 403、零 spawn、零写入；同会话照常', async () => {
    const env = makeEnv({
      scripts: [[BLOCKED('需要哪个文档？')], [DONE('结论')]],
      extraSessions: [{ id: 'sessB', mode: 'discuss', workspaceId: null, workspacePath: null }],
    });
    const dto = submitAnalyst(env);
    await env.service.whenSettled(dto.id);
    expect(env.service.get(env.store, dto.id).status).toBe('blocked');
    const tokenA = env.toolService.createRunContext({ runKind: 'discuss', sessionId: 'sess1', outputRoot: '/x', knowledgeBaseRoot: '/x' }).token;
    const tokenB = env.toolService.createRunContext({ runKind: 'discuss', sessionId: 'sessB', outputRoot: '/x', knowledgeBaseRoot: '/x' }).token;

    // B 会话 resume A 的 blocked 任务 → 403 归属拒绝（不产生任何状态变化）
    await expect(env.toolService.executeTool(tokenB, 'task_resume', { taskId: dto.id, message: '恶意注入的作答' }))
      .rejects.toMatchObject({ code: 'task_not_owned_by_session', status: 403 });
    // B 会话 cancel 同样拒绝
    await expect(env.toolService.executeTool(tokenB, 'task_cancel', { taskId: dto.id }))
      .rejects.toMatchObject({ code: 'task_not_owned_by_session', status: 403 });
    expect(env.service.get(env.store, dto.id).status).toBe('blocked'); // 状态未被改动
    expect(env.rpcs).toHaveLength(1); // 零新 spawn
    expect(String(env.store.getAgentTask(dto.id)!.resume_answers_json ?? '[]')).toBe('[]'); // 零写入

    // 同会话（A）工具面 resume 照常 → 重新调度至 done
    const resumed = await env.toolService.executeTool(tokenA, 'task_resume', { taskId: dto.id, message: '文档A' });
    expect(JSON.parse(resumed.content[0].text).status).toBe('queued');
    await env.service.whenSettled(dto.id);
    expect(env.service.get(env.store, dto.id).status).toBe('done');
    expect(env.rpcs).toHaveLength(2);

    // desktop 入口（不传 callerSessionId）保留全局授权契约：取消可用
    const fresh = makeEnv({ scripts: [[BLOCKED('q')]] });
    const dto2 = submitAnalyst(fresh);
    await fresh.service.whenSettled(dto2.id);
    const cancelled = await fresh.service.cancel(fresh.store, dto2.id);
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('R2-02：任务授权根按冻结 workspaceId 解析（不受父会话当前 Workspace 影响）', () => {
  it('排队中父会话切 W2 → 派发仍用冻结 W1；不在 W2 创建任何目录', async () => {
    const w1 = fs.mkdtempSync(path.join(os.tmpdir(), 'task-w1-'));
    const w2 = fs.mkdtempSync(path.join(os.tmpdir(), 'task-w2-'));
    temporaryRoots.push(w1, w2);
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 1 });
    const holdSlot = await pool.acquire('background');
    const holdRpc = new FakeTaskRpc([]);
    pool.register('hold', holdRpc, 'build', holdSlot);
    const env = makeEnv({
      mode: 'work', workspacePath: w1, pool,
      scripts: [[DONE('写入完成')]],
    });
    const dto = env.service.submit(env.store, {
      sessionId: 'sess1', role: 'kb-converter', title: '转换', task: 'x', outputDir: 'out',
    });
    expect(dto.status).toBe('queued');
    // 排队中：父会话切到 W2（sessionInfo 返回的当前 Workspace 变化）
    env.session.workspaceId = 'ws_test2';
    env.session.workspacePath = w2;
    holdRpc.terminate();
    holdSlot.release();
    await env.service.whenSettled(dto.id);
    expect(env.service.get(env.store, dto.id).status).toBe('done');
    // 授权根 = 冻结的 W1/out（已 realpath），不足 W2
    const root = env.spawnInputs[0]!.workspaceRoot!;
    expect(root.startsWith(fs.realpathSync(w1) + path.sep)).toBe(true);
    expect(fs.existsSync(path.join(w1, 'out'))).toBe(true);
    expect(fs.existsSync(path.join(w2, 'out'))).toBe(false);
  });

  it('blocked 后父会话切 Discuss（无 Workspace）→ resume 仍用冻结 W1 完成', async () => {
    const w1 = fs.mkdtempSync(path.join(os.tmpdir(), 'task-w1-'));
    temporaryRoots.push(w1);
    const env = makeEnv({
      mode: 'work', workspacePath: w1,
      scripts: [[BLOCKED('缺什么？')], [DONE('写入完成')]],
    });
    const dto = env.service.submit(env.store, {
      sessionId: 'sess1', role: 'kb-converter', title: '转换', task: 'x', outputDir: 'out',
    });
    await env.service.whenSettled(dto.id);
    expect(env.service.get(env.store, dto.id).status).toBe('blocked');
    // 父会话切回 Discuss：当前 Workspace 清空
    env.session.mode = 'discuss';
    env.session.workspaceId = null;
    env.session.workspacePath = null;
    env.service.resume(env.store, dto.id, '继续');
    await env.service.whenSettled(dto.id);
    expect(env.service.get(env.store, dto.id).status).toBe('done');
    expect(env.spawnInputs[1]!.workspaceRoot!.startsWith(fs.realpathSync(w1) + path.sep)).toBe(true);
  });

  it('冻结的 Workspace 被移除 → 任务显式 failed(task_workspace_unavailable)，零 spawn', async () => {
    const w1 = fs.mkdtempSync(path.join(os.tmpdir(), 'task-w1-'));
    temporaryRoots.push(w1);
    const env = makeEnv({
      mode: 'work', workspacePath: w1,
      scripts: [[BLOCKED('缺什么？')], [DONE('不应执行')]],
    });
    const dto = env.service.submit(env.store, {
      sessionId: 'sess1', role: 'kb-converter', title: '转换', task: 'x', outputDir: 'out',
    });
    await env.service.whenSettled(dto.id);
    // Workspace 从配置移除后 resume
    env.config.agent.workspaces = [];
    env.service.resume(env.store, dto.id, '继续');
    await env.service.whenSettled(dto.id);
    const failed = env.service.get(env.store, dto.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('task_workspace_unavailable');
    expect(env.rpcs).toHaveLength(1); // 零新 spawn
  });
});

describe('R2-03：blocked 清理窗口内 resume 不丢调度', () => {
  it('可控延迟 terminate：blocked SSE→resume→释放 → 恰好一次新 spawn 且终态落定', async () => {
    const gate = Promise.withResolvers<void>();
    const env = makeEnv({
      scripts: [[BLOCKED('缺什么？')], [DONE('结论')]],
      terminateDelay: gate.promise,
    });
    const dto = submitAnalyst(env);
    // blocked 已落库/SSE 已发，但旧 dispatch 停在 finally 的 await terminate
    await vi.waitFor(() => expect(env.service.get(env.store, dto.id).status).toBe('blocked'), { timeout: 3000 });
    // 清理窗口内作答：行置 queued，但 kickDispatch 被旧条目挡住（修复前会永远 queued）
    const resumed = env.service.resume(env.store, dto.id, '用户作答');
    expect(resumed.status).toBe('queued');
    expect(env.rpcs).toHaveLength(1); // 释放前零新 spawn
    // 释放 terminate → finally 删除旧条目后原子复查 queued → 补派发恰好一次
    gate.resolve();
    await vi.waitFor(() => expect(env.service.get(env.store, dto.id).status).toBe('done'), { timeout: 3000 });
    expect(env.rpcs).toHaveLength(2);
    expect(env.service.get(env.store, dto.id).result).toBe('结论');
    expect(env.lastRpc().prompts[0]).toContain('用户作答');
  });
});

describe('R2-05：任务活跃纳入插件互斥 + 冻结快照一致性', () => {
  it('hasPendingWork：queued/running/blocked 为 true，终态为 false', async () => {
    const env = makeEnv({ scripts: [[BLOCKED('q')]] });
    expect(env.service.hasPendingWork(env.store)).toBe(false);
    const dto = submitAnalyst(env);
    expect(env.service.hasPendingWork(env.store)).toBe(true); // queued→running
    await env.service.whenSettled(dto.id);
    expect(env.service.hasPendingWork(env.store)).toBe(true); // blocked
    await env.service.cancel(env.store, dto.id);
    expect(env.service.hasPendingWork(env.store)).toBe(false); // cancelled
  });

  it('blocked 后插件 native 资源变更 → resume 显式失败(plugin_snapshot_stale)，不装当前资源进旧快照', async () => {
    const native = { sources: ['/x/native-a.js'], revision: 'native_rev_a', external: false };
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugins-r205-'));
    temporaryRoots.push(dataRoot);
    const pluginStore = new AppPluginStore(dataRoot, undefined, () => native);
    const env = makeEnv({
      pluginStore,
      scripts: [[BLOCKED('缺什么？')], [DONE('不应执行')]],
    });
    const dto = submitAnalyst(env);
    await env.service.whenSettled(dto.id);
    expect(env.service.get(env.store, dto.id).status).toBe('blocked');
    expect(env.store.getAgentTask(dto.id)!.plugin_revision).not.toBeNull(); // 冻结了快照
    // 插件资源变更（如插件更新）——旧 revision 快照无法忠实重建
    native.revision = 'native_rev_b';
    native.sources = ['/x/native-b.js'];
    env.service.resume(env.store, dto.id, '继续');
    await env.service.whenSettled(dto.id);
    const failed = env.service.get(env.store, dto.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('plugin_snapshot_stale');
    expect(env.rpcs).toHaveLength(1); // 不 spawn（诚实阻断，非降级注入）
  });
});

describe('R3-03：读成功/写失败的派发有限收敛（fault injection）', () => {
  it('updateAgentTask 持续失败 → 无自动重派（dispatch 有界、槽位不残留、错误日志有界），行保持 queued', async () => {
    // 旧缺陷：设置 running 写失败 → catch 内 finish(failed) 写也失败 → 错误
    // 被吞 → finally 读到 queued 立即 kickDispatch → 无退避微任务循环。
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = makeEnv({ scripts: [] });
    try {
      let updateAttempts = 0;
      let acquired = 0;
      let released = 0;
      // fault injection：读成功（getAgentTask 走真库）、写持续失败
      const failingStore = new Proxy(env.store, {
        get(target, prop) {
          if (prop === 'updateAgentTask') {
            return () => {
              updateAttempts += 1;
              throw new Error('injected sqlite write failure');
            };
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      // 计数 dispatch 尝试（每次 dispatchRound 都 acquire）与槽位归还
      const realAcquire = env.pool.acquire.bind(env.pool);
      const acquireSpy = vi.spyOn(env.pool, 'acquire').mockImplementation(async (kind, options) => {
        acquired += 1;
        const slot = await realAcquire(kind, options);
        return { release: () => { released += 1; slot.release(); } };
      });

      const dto = env.service.submit(failingStore, {
        sessionId: env.session.id, role: 'kb-analyst', title: '写故障', task: 'x',
      });
      await env.service.whenSettled(dto.id);
      // 等待足够久：若仍自动重派（旧行为），dispatch/日志会持续增长
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(acquired).toBe(1); // dispatch 尝试有界（旧缺陷下无界增长）
      expect(released).toBe(acquired); // 槽位成对归还，无残留
      expect(updateAttempts).toBe(2); // 恰好两次写尝试：置 running + finish(failed)
      expect(env.service.get(env.store, dto.id).status).toBe('queued'); // 行保持 queued（写不进去）
      const logs = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(logs.filter((line) => line.includes('dispatch failure persist failed'))).toHaveLength(1);
      expect(logs.length).toBeLessThanOrEqual(4); // 日志有界，不刷屏
      // 真实库取消收尾（写面健康，取消可达）
      const cancelled = await env.service.cancel(env.store, dto.id);
      expect(cancelled.status).toBe('cancelled');
      acquireSpy.mockRestore();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('R3-04：任务序号定宽 base36——同毫秒排序单调', () => {
  it('taskSeqSegment：z→10、zz→100 进位边界字典序单调（定宽 4 位）', () => {
    expect(taskSeqSegment(35)).toBe('000z');
    expect(taskSeqSegment(36)).toBe('0010');
    expect(taskSeqSegment(35) < taskSeqSegment(36)).toBe(true); // 旧：'z' > '10' 逆序
    expect(taskSeqSegment(1295)).toBe('00zz');
    expect(taskSeqSegment(1296)).toBe('0100');
    expect(taskSeqSegment(1295) < taskSeqSegment(1296)).toBe(true);
    // 0..5000 全程字典序 = 数值序（无进位逆序；5000+ 覆盖 zzz→1000 邻域）
    for (let n = 0; n < 5000; n += 1) {
      expect(taskSeqSegment(n) < taskSeqSegment(n + 1)).toBe(true);
    }
  });

  it('固定时钟提交跨 z→10 边界：id 字典序 = 提交序，排队次序与 queuePosition 正确', async () => {
    vi.useFakeTimers();
    try {
      // 池满排队：任务停在 queued（排队序可观察）；探测当前进程级序号
      const pool = new AgentProcessPool({ maxConcurrentProcesses: 1 });
      pools.push(pool);
      const holdSlot = await pool.acquire('background');
      const holdRpc = new FakeTaskRpc([]);
      pool.register('hold-r304', holdRpc, 'build', holdSlot);
      const env = makeEnv({ pool, scripts: [] });
      const seg = (id: string) => id.split('_')[2];
      const probe = submitAnalyst(env, '序号探测');
      expect(probe.id).toMatch(/^t_[0-9a-z]+_[0-9a-z]{4}_[0-9a-f]{8}$/); // 定宽 4 位
      const probeSeq = parseInt(seg(probe.id), 36);
      await env.service.cancel(env.store, probe.id);
      // 补齐到进位边界前一个（z→10 或 zz→100，取决于当前进程序号）
      const boundary = probeSeq + 1 <= 35 ? 36 : 1296;
      const fill = boundary - 1 - probeSeq;
      for (let i = 0; i < fill; i += 1) {
        const dto = submitAnalyst(env, `填充-${i}`);
        await env.service.cancel(env.store, dto.id);
      }
      // 冻结时钟下连续提交三个：序号跨进位边界（000z → 0010…）
      const ids = [
        submitAnalyst(env, '边界-A').id,
        submitAnalyst(env, '边界-B').id,
        submitAnalyst(env, '边界-C').id,
      ];
      expect(seg(ids[0])).toBe(boundary === 36 ? '0010' : '0100');
      // 字典序 = 提交序（修复前 '000z' > '0010' 会逆序）
      expect([...ids].sort()).toEqual(ids);
      // 排队次序：listBySession（ORDER BY created_at, id）与提交序一致
      const queued = env.service.listBySession(env.store, env.session.id)
        .filter((task) => task.status === 'queued');
      expect(queued.map((task) => task.id)).toEqual(ids);
      expect(queued.map((task) => task.queuePosition)).toEqual([1, 2, 3]);
      // 收尾
      for (const id of ids) await env.service.cancel(env.store, id);
      holdRpc.terminate();
      holdSlot.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
