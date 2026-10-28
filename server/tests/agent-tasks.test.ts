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
    this.terminated = true;
    this.exited = true;
    this.emit('exit');
  }
}

const temporaryRoots: string[] = [];
const pools: AgentProcessPool[] = [];
afterAll(() => {
  for (const pool of pools) void pool.closeAll();
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
  const updates: Array<{ sessionId: string; status: string }> = [];
  const rpcs: FakeTaskRpc[] = [];
  const service = new TaskService({
    dataRoot,
    pool,
    toolService,
    roles: new RoleRegistry(rolesDir),
    resolver: new PiRuntimeResolver(),
    configProvider: () => makeConfig(),
    sessionInfo: (id) => (id === session.id ? session : null),
    internalBaseUrl: () => 'http://127.0.0.1:39999',
    emitTaskUpdate: (sessionId, dto) => updates.push({ sessionId, status: dto.status }),
    extensionPath: () => null,
    orchestrationEnabled: () => opts.orchestration ?? true,
    spawner: async () => {
      const rpc = new FakeTaskRpc(scriptQueue.shift() ?? []);
      rpcs.push(rpc);
      return rpc as unknown as PiRpcProcess;
    },
  });
  toolService.registerToolFamily(taskToolFamily({ service, store }));
  return {
    dataRoot, store, pool, toolService, service, updates, rpcs,
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
    expect(() => resolveTaskWorkspaceRoot(session, 'link/sub')).toThrow(/outputDir 越出/);
    fs.mkdirSync(path.join(external, 'pre'), { recursive: true });
    expect(() => resolveTaskWorkspaceRoot(session, 'link/pre')).toThrow(/outputDir 越出/);

    // 深层 symlink（第二段）：同样拒绝
    fs.mkdirSync(path.join(wsRoot, 'real'));
    fs.symlinkSync(external, path.join(wsRoot, 'real', 'link2'));
    expect(() => resolveTaskWorkspaceRoot(session, 'real/link2/x')).toThrow(/outputDir 越出/);

    // 正常路径：逐级创建并返回父根内 realpath
    const resolved = resolveTaskWorkspaceRoot(session, 'a/b/c');
    expect(resolved!.startsWith(fs.realpathSync(wsRoot) + path.sep)).toBe(true);
    expect(fs.statSync(resolved!).isDirectory()).toBe(true);
    // 已存在真实子目录复用
    expect(resolveTaskWorkspaceRoot(session, 'a/b')).toBe(fs.realpathSync(path.join(wsRoot, 'a', 'b')));
    // 只读任务：父根原样；无 Workspace：undefined
    expect(resolveTaskWorkspaceRoot(session, null)).toBe(wsRoot);
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
