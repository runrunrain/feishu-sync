/**
 * 构建模式转发扩展接线测试（设计 v2 §3.4：Leader 工具收窄 + task_submit/task_resume 派发守卫）
 *
 * 守卫策略唯一来源：运行时底座 build-runtime/dispatch-guard（本 worktree 之外，
 * 经 FEISHU_SYNC_BUILD_GUARD_MODULE 注入模块绝对路径 dynamic import；生产为编译 JS，
 * 开发/测试源码 .ts 由 jiti/vite 加载）。本文件不复制权限逻辑，只验证：
 *  A. 信封解析 + factory 接线（白名单收窄、task 族不注册、守卫装载与 fail-closed）
 *  B1. 真实 Pi 事件管线（mock 任务工具）：守卫改参真实进入执行、越权被阻断
 *  B2. 真实 amagi-core 派发：守卫改参后参数落入 amagi 冻结契约（v2-store spec）
 *
 * fixture：mock 内部 API 与 mock OpenAI SSE 模型为本测试临时 fixture；真实 amagi-core
 * 派发在临时 HOME/agentDir 中进行（子进程无真实凭据，模型不可达即快速失败——契约在
 * spawn 前已冻结，断言只针对落盘 spec）。不读取任何生产凭据。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { buildDefaultAgentConfig } from '../src/types/agent-knowledge.js';
import { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import { computePackageContentHash } from '../src/agent/build-runtime/amagi-package.js';
import { renderChildPolicySource } from '../src/agent/build-runtime/child-policy.js';
import { RUNTIME_INTEGRITY_SCHEMA_VERSION, type RuntimeIntegrityRefs } from '../src/agent/build-runtime/runtime-integrity.js';
import { createHash } from 'node:crypto';
import type { FrozenDispatchConfig } from '../src/agent/build-runtime/dispatch-guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(HERE, '../src/agent/pi-extension/feishu-sync-agent.js');

/**
 * 运行时 dispatch-guard 模块定位：合并后主树优先，当前并行切片回退到
 * build-v2-runtime worktree 的源码（jiti/vite 加载 .ts）。
 */
function resolveDispatchGuardModule(): string | null {
  const candidates = [
    path.join(HERE, '../src/agent/build-runtime/dispatch-guard.ts'),
    path.resolve(HERE, '../../../build-v2-runtime/server/src/agent/build-runtime/dispatch-guard.ts'),
    path.join(HERE, '../dist/agent/build-runtime/dispatch-guard.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

// ── 共享 fixture：mock 内部 API（GET /api/agent-internal/tools + POST 执行回环）──
type MockApi = { url: string; close(): Promise<void>; posts: { name: string; body: unknown }[]; readonly fetches: number };

function startMockApi(tools: unknown[]): Promise<MockApi> {
  let fetches = 0;
  const posts: { name: string; body: unknown }[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/agent-internal/tools') {
      fetches += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tools));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/api/agent-internal/tools/')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        posts.push({ name: decodeURIComponent(req.url!.split('/').pop()!), body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], details: undefined }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
        posts,
        get fetches() { return fetches; },
      });
    });
  });
}

// ── 模块加载（env 在 import 时读取；vi.resetModules 隔离每例）──
type ExtensionModule = typeof import('../src/agent/pi-extension/feishu-sync-agent.js');

async function loadExtension(env: Record<string, string>): Promise<ExtensionModule> {
  vi.resetModules();
  const keys = Object.keys(env);
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return (await import(EXTENSION_PATH)) as ExtensionModule;
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

type RegisteredTool = { name: string };

function fakePi(externalTools: { name: string; sourceInfo?: { path?: string } }[] = []) {
  const state = {
    registered: [] as RegisteredTool[],
    handlers: {} as Record<string, ((event: unknown, ctx?: unknown) => unknown)[]>,
    activeTools: null as string[] | null,
  };
  const pi = {
    registerTool: (tool: RegisteredTool) => state.registered.push(tool),
    registerProvider: () => {},
    on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
      (state.handlers[event] ??= []).push(handler);
    },
    getAllTools: () => externalTools,
    setActiveTools: (names: string[]) => { state.activeTools = [...names]; },
    getActiveTools: () => state.activeTools ?? [],
  };
  return { pi, state };
}

// ── F12 完整性 fixture：真实磁盘（homeDir/四配置/policy/包）供 verifyRuntimeIntegrity 触盘比对 ──
// 形状刻意最小（settings 不声明 extensions——派发期核验不做该交叉检查，真实渲染形状的
// 全量验证在 build-runtime-integrity.test 用 renderAgentDirConfigFiles+writeAgentDirConfig 覆盖）。
const INTEGRITY_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ext-integrity-'));

function buildIntegrityFixture(): RuntimeIntegrityRefs {
  const homeDir = path.join(INTEGRITY_TMP, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const expectedFiles = {
    settings: `${JSON.stringify({ $schema: 'https://pi.dev/schemas/settings.schema.json', packages: [] }, null, 2)}\n`,
    amagi: '{"agents":{}}\n',
    models: '{"providers":{}}\n',
    mcp: '{"mcpServers":{},"autoEnableCodemode":false}\n',
  };
  const policySource = renderChildPolicySource();
  const sha256 = createHash('sha256').update(policySource, 'utf-8').digest('hex');
  const fileName = `child-policy-${sha256.slice(0, 12)}.js`;
  fs.writeFileSync(path.join(homeDir, fileName), policySource, { mode: 0o600 });
  fs.writeFileSync(path.join(homeDir, 'settings.json'), expectedFiles.settings);
  fs.writeFileSync(path.join(homeDir, 'amagi.json'), expectedFiles.amagi);
  fs.writeFileSync(path.join(homeDir, 'models.json'), expectedFiles.models);
  fs.writeFileSync(path.join(homeDir, 'mcp.json'), expectedFiles.mcp);
  const packageRoot = path.join(INTEGRITY_TMP, 'fixture-pkg');
  fs.mkdirSync(path.join(packageRoot, 'extensions', 'amagi-core'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'extensions', 'amagi-core', 'index.ts'), '// fixture package\n');
  const { contentHash } = computePackageContentHash(packageRoot);
  // Leader steer：冻结工作流规则实文件（child 读此文件、F08 回执绑 workflowRevision）
  const skillPath = path.join(INTEGRITY_TMP, 'skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, '---\nname: kb-build\ndescription: fixture。\n---\n\n# 内容质量基线\n');
  const skillSha256 = createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex');
  return {
    schemaVersion: RUNTIME_INTEGRITY_SCHEMA_VERSION,
    homeDir,
    expectedFiles,
    childPolicy: { fileName, sha256 },
    amagiPackage: { packageRoot, contentHash },
    workflowSkill: { path: skillPath, sha256: skillSha256 },
  };
}

/** FrozenDispatchConfig fixture（形状=运行时 contracts；角色模型为精确名单，含 thinking 档位）。 */
const GUARD_CONFIG: FrozenDispatchConfig = {
  schemaVersion: 2,
  buildId: 'b_fixture',
  generation: 1,
  workDir: `${os.tmpdir()}/feishu-build-fixture/work`,
  reportRoot: 'agent-outputs',
  forbiddenZones: ['.pi/**', '.agents/**', '.mcp.json', 'amagi.json', 'AGENTS.md', 'CLAUDE.md'],
  roles: {
    luban: { key: 'writer', models: ['zhipuai/glm-5.3-flash'], mcpTools: ['kb_read_material', 'kb_submit_draft'] },
    diting: { key: 'reviewer', models: ['zhipuai/glm-5.3'], mcpTools: ['kb_submit_review'] },
    baize: { key: 'research', models: ['zhipuai/glm-5.3'], mcpTools: [] },
  },
  integrity: buildIntegrityFixture(),
};

const BUILD_TOOLS = ['task_submit', 'task_query', 'task_control', 'task_resume', 'amagi_resource', 'kb_build_probe'];

const HOSTILE_SUBMIT = {
  agent: 'luban',
  task: '# 任务书\n正文……',
  delivery: 'handle',
  model: 'zhipuai/glm-5.3-flash',
  profile: 'tiered',
  scope: {
    read: ['sources/**'],
    write: ['**', 'agent-outputs/report.md'],
    deny: ['docs/'],
    reportFiles: ['**', '../evil.md'],
    advisor: 'consult',
    lsp: ['rename', 'diagnostics'],
    codemode: true,
    shell: 'guarded',
    mcp: ['kb_submit_review', 'arbitrary_tool'],
  },
  workspace: { cwd: '../escape', mode: 'worktree', worktreeName: 'evil', base: 'dirty-snapshot' },
};

describe('A1 parseBuildSpecEnvelope（信封校验，fail closed）', () => {
  const load = () => import(EXTENSION_PATH) as Promise<ExtensionModule>;
  it('接受合法信封 {tools, guard}', async () => {
    const { parseBuildSpecEnvelope } = await load();
    const envelope = parseBuildSpecEnvelope(JSON.stringify({ tools: BUILD_TOOLS, guard: GUARD_CONFIG }));
    expect(envelope.tools).toEqual([...BUILD_TOOLS]);
    expect(envelope.guard).toEqual(GUARD_CONFIG);
  });
  it('拒绝：坏 JSON / 非对象 / tools 空·重复·缺 task_submit / guard 缺失', async () => {
    const { parseBuildSpecEnvelope } = await load();
    expect(() => parseBuildSpecEnvelope('{bad')).toThrow(/JSON/);
    expect(() => parseBuildSpecEnvelope('[]')).toThrow(/对象/);
    expect(() => parseBuildSpecEnvelope(JSON.stringify({ guard: GUARD_CONFIG }))).toThrow(/tools/);
    expect(() => parseBuildSpecEnvelope(JSON.stringify({ tools: [], guard: GUARD_CONFIG }))).toThrow(/tools/);
    expect(() => parseBuildSpecEnvelope(JSON.stringify({ tools: ['task_submit', 'task_submit'], guard: GUARD_CONFIG }))).toThrow(/重复/);
    expect(() => parseBuildSpecEnvelope(JSON.stringify({ tools: ['task_query'], guard: GUARD_CONFIG }))).toThrow(/task_submit/);
    expect(() => parseBuildSpecEnvelope(JSON.stringify({ tools: BUILD_TOOLS }))).toThrow(/guard/);
  });
});

/** A2/A3 共用：装载构建模式 factory（真实运行时 dispatch-guard 模块注入）。 */
async function loadBuildFactory(specJson: string, guardModule: string, mockApiUrl: string, extraEnv: Record<string, string> = {}) {
  const mod = await loadExtension({
    FEISHU_SYNC_AGENT_URL: mockApiUrl,
    FEISHU_SYNC_AGENT_RUN_TOKEN: 'fixture-token',
    FEISHU_SYNC_AGENT_BUILD_SPEC_JSON: specJson,
    FEISHU_SYNC_BUILD_GUARD_MODULE: guardModule,
    // F12 接线：Leader agentDir 与冻结引用一致性（派发钩子逐次核对）
    PI_CODING_AGENT_DIR: GUARD_CONFIG.integrity.homeDir,
    ...extraEnv,
  });
  return mod;
}

describe('A2 守卫接缝（真实运行时 dispatch-guard 语义经扩展 tool_call 生效）', () => {
  const guardModule = resolveDispatchGuardModule();
  beforeAll(() => {
    if (!guardModule) console.warn('[build-runtime-extension] 未定位到运行时 dispatch-guard 模块，A2/A3 构建模式用例跳过');
  });

  async function toolCallHandler() {
    if (!guardModule) return null;
    const api = await startMockApi([
      { name: 'task_submit', label: 'App task', description: '应用 task 工具（构建模式跳过注册）', parameters: { type: 'object' } },
      { name: 'kb_build_probe', label: '构建', description: '应用构建工具', parameters: { type: 'object' } },
    ]);
    try {
      const mod = await loadBuildFactory(JSON.stringify({ tools: BUILD_TOOLS, guard: GUARD_CONFIG }), guardModule, api.url);
      const fake = fakePi();
      await mod.default(fake.pi);
      return { handler: fake.state.handlers.tool_call[0], sessionStart: fake.state.handlers.session_start[0] };
    } finally {
      await api.close();
    }
  }

  it('task_submit：运行时守卫原地冻结（写面过滤+报告面补齐、禁区合并保留模型自加、mcp 按角色、profile 删除、workspace 固定；input 对象身份不变）', async () => {
    const wired = await toolCallHandler();
    if (!wired) return;
    const event = { toolName: 'task_submit', input: JSON.parse(JSON.stringify(HOSTILE_SUBMIT)) };
    expect(wired.handler(event)).toBeUndefined();
    const input = event.input as Record<string, any>;
    const scope = input.scope;
    expect(scope.shell).toBe('deny');
    expect('advisor' in scope).toBe(false);
    expect('lsp' in scope).toBe(false);
    expect('codemode' in scope).toBe(false);
    // 写面：报告目录内条目保留 + 报告根补齐（'**' 被移除）
    expect(scope.write).toEqual(['agent-outputs/**', 'agent-outputs/report.md']);
    // 禁区：冻结覆写（运行时当前语义：模型自报 deny 被替换，非合并）
    expect(scope.deny).toEqual([...GUARD_CONFIG.forbiddenZones].sort());
    expect(scope.mcp).toEqual(['kb_read_material', 'kb_submit_draft']);
    expect(scope.read).toEqual(['sources/**']);
    expect(scope.reportFiles).toEqual([]);
    expect('profile' in input).toBe(false);
    expect(input.workspace).toEqual({ cwd: GUARD_CONFIG.workDir, mode: 'existing' });
    expect(input.model).toBe('zhipuai/glm-5.3-flash');
  });
  it('模型覆盖按角色精确名单：他角色模型/未冻结 thinking 档位均被阻断', async () => {
    const wired = await toolCallHandler();
    if (!wired) return;
    const crossRole = wired.handler({ toolName: 'task_submit', input: { agent: 'diting', task: 'x', model: 'zhipuai/glm-5.3-flash' } }) as { block: boolean; reason: string };
    expect(crossRole.block).toBe(true);
    expect(crossRole.reason).toContain('不在角色 diting 的冻结模型内');
    expect(crossRole.reason).toContain('dispatch_model_not_frozen');
    const badThinking = wired.handler({ toolName: 'task_submit', input: { agent: 'luban', task: 'x', model: 'zhipuai/glm-5.3-flash:high' } }) as { block: boolean; reason: string };
    expect(badThinking.block).toBe(true);
    expect(badThinking.reason).toContain('不在角色 luban 的冻结模型内');
    const badRole = wired.handler({ toolName: 'task_submit', input: { agent: 'fuxi', task: 'x' } }) as { block: boolean; reason: string };
    expect(badRole.block).toBe(true);
    expect(badRole.reason).toContain('不在本次构建的角色表内');
    expect(badRole.reason).toContain('dispatch_role_not_allowed');
    const taskFileEscape = wired.handler({ toolName: 'task_submit', input: { agent: 'luban', taskFile: '../../etc/passwd' } }) as { block: boolean; reason: string };
    expect(taskFileEscape.block).toBe(true);
    expect(taskFileEscape.reason).toContain('越出固定工作目录');
  });
  it('task_resume：模型覆盖对全表精确匹配；防御性删除 scope/workspace/profile', async () => {
    const wired = await toolCallHandler();
    if (!wired) return;
    const bad = wired.handler({ toolName: 'task_resume', input: { handle: 'deadbeef', message: '继续', model: 'zhipuai/glm-4' } }) as { block: boolean; reason: string };
    expect(bad.block).toBe(true);
    expect(bad.reason).toContain('不在冻结模型集内');
    const badThinking = wired.handler({ toolName: 'task_resume', input: { handle: 'deadbeef', message: '继续', model: 'zhipuai/glm-5.3-flash:high' } }) as { block: boolean; reason: string };
    expect(badThinking.block).toBe(true);
    const smuggled = { handle: 'deadbeef', message: 'm', model: 'zhipuai/glm-5.3', scope: { shell: 'guarded' }, workspace: { cwd: '/elsewhere' }, profile: 'tiered' };
    expect(wired.handler({ toolName: 'task_resume', input: smuggled })).toBeUndefined();
    expect('scope' in smuggled).toBe(false);
    expect('workspace' in smuggled).toBe(false);
    expect('profile' in smuggled).toBe(false);
  });
});

describe('A2b F12 派发前运行期完整性重核验（真实磁盘 fixture，逐次派发触盘比对）', () => {
  const guardModule = resolveDispatchGuardModule();
  beforeAll(() => {
    if (!guardModule) console.warn('[build-runtime-extension] 未定位到运行时 dispatch-guard 模块，A2b 跳过');
  });

  /** 装载 factory 并返回 tool_call handler（可覆盖 env / guard）。 */
  async function integrityHandler(opts: { env?: Record<string, string>; guard?: FrozenDispatchConfig } = {}) {
    if (!guardModule) return null;
    const api = await startMockApi([
      { name: 'task_submit', label: 'App task', description: '应用 task 工具（构建模式跳过注册）', parameters: { type: 'object' } },
      { name: 'kb_build_probe', label: '构建', description: '应用构建工具', parameters: { type: 'object' } },
    ]);
    try {
      const mod = await loadBuildFactory(
        JSON.stringify({ tools: BUILD_TOOLS, guard: opts.guard ?? GUARD_CONFIG }),
        guardModule,
        api.url,
        opts.env,
      );
      const fake = fakePi();
      await mod.default(fake.pi);
      return { handler: fake.state.handlers.tool_call[0] };
    } finally {
      await api.close();
    }
  }

  it('基线：冻结面完整时派发照常进入参数守卫（guard_amended 语义不变）', async () => {
    const wired = await integrityHandler();
    if (!wired) return;
    expect(wired.handler({ toolName: 'task_submit', input: { agent: 'luban', task: 'x' } })).toBeUndefined();
  });

  it('policy 缺失 → 阻断派发（issue 点名 child-policy；不是只测 helper 返回 false）', async () => {
    const wired = await integrityHandler();
    if (!wired) return;
    const policyPath = path.join(GUARD_CONFIG.integrity.homeDir, GUARD_CONFIG.integrity.childPolicy.fileName);
    const backup = fs.readFileSync(policyPath, 'utf-8');
    try {
      fs.rmSync(policyPath);
      const blocked = wired.handler({ toolName: 'task_submit', input: { agent: 'luban', task: 'x' } }) as { block: boolean; reason: string };
      expect(blocked.block).toBe(true);
      expect(blocked.reason).toContain('runtime_integrity_violation');
      expect(blocked.reason).toContain('child-policy');
    } finally {
      fs.writeFileSync(policyPath, backup, { mode: 0o600 });
    }
  });

  it('settings 资源注入（未知字段 resources）→ 阻断派发', async () => {
    const wired = await integrityHandler();
    if (!wired) return;
    const settingsPath = path.join(GUARD_CONFIG.integrity.homeDir, 'settings.json');
    const backup = fs.readFileSync(settingsPath, 'utf-8');
    try {
      fs.writeFileSync(settingsPath, `${JSON.stringify({ ...JSON.parse(backup), resources: ['evil-skill'] }, null, 2)}\n`);
      const blocked = wired.handler({ toolName: 'task_resume', input: { handle: 'h1', message: 'm' } }) as { block: boolean; reason: string };
      expect(blocked.block).toBe(true);
      expect(blocked.reason).toContain('未知字段 resources');
    } finally {
      fs.writeFileSync(settingsPath, backup);
    }
  });

  it('settings 移除冻结键（packages）→ 阻断；retry 容忍形状不阻断（与 agentDirConfigMatchesSpec 同口径）', async () => {
    const wired = await integrityHandler();
    if (!wired) return;
    const settingsPath = path.join(GUARD_CONFIG.integrity.homeDir, 'settings.json');
    const backup = fs.readFileSync(settingsPath, 'utf-8');
    try {
      const noPackages = { ...JSON.parse(backup) } as Record<string, unknown>;
      delete noPackages.packages;
      fs.writeFileSync(settingsPath, `${JSON.stringify(noPackages, null, 2)}\n`);
      const removed = wired.handler({ toolName: 'task_submit', input: { agent: 'luban', task: 'x' } }) as { block: boolean; reason: string };
      expect(removed.block).toBe(true);
      expect(removed.reason).toContain('packages');
      // doctor 写入的 retry 容忍形状：照常放行
      fs.writeFileSync(settingsPath, `${JSON.stringify({ ...JSON.parse(backup), retry: { provider: { timeoutMs: 180000 } } }, null, 2)}\n`);
      expect(wired.handler({ toolName: 'task_submit', input: { agent: 'luban', task: 'x' } })).toBeUndefined();
    } finally {
      fs.writeFileSync(settingsPath, backup);
    }
  });

  it('包内容漂移（新增文件改变全量哈希）→ 阻断派发', async () => {
    const wired = await integrityHandler();
    if (!wired) return;
    const injected = path.join(GUARD_CONFIG.integrity.amagiPackage.packageRoot, 'injected.ts');
    try {
      fs.writeFileSync(injected, '// tamper\n');
      const blocked = wired.handler({ toolName: 'task_submit', input: { agent: 'luban', task: 'x' } }) as { block: boolean; reason: string };
      expect(blocked.block).toBe(true);
      expect(blocked.reason).toContain('哈希漂移');
    } finally {
      fs.rmSync(injected);
    }
  });

  it('workflow skill 运行中篡改 → 阻断派发（Leader steer 冻结资源接缝）', async () => {
    const wired = await integrityHandler();
    if (!wired) return;
    const skillPath = GUARD_CONFIG.integrity.workflowSkill.path;
    const backup = fs.readFileSync(skillPath, 'utf-8');
    try {
      fs.writeFileSync(skillPath, `${backup}\n<!-- 运行中注入的规则改动 -->`);
      const blocked = wired.handler({ toolName: 'task_submit', input: { agent: 'luban', task: 'x' } }) as { block: boolean; reason: string };
      expect(blocked.block).toBe(true);
      expect(blocked.reason).toContain('workflow skill 内容与冻结 workflowRevision 不一致');
    } finally {
      fs.writeFileSync(skillPath, backup);
    }
  });

  it('Leader agentDir 与冻结引用不一致 → 装载即 fail-closed（PI_CODING_AGENT_DIR 交叉核对）', async () => {
    if (!guardModule) return;
    // 启动面即拒绝（不再等到派发）：agentDir 不一致时 Leader 根本不起来
    await expect((async () => {
      const mod = await loadBuildFactory(
        JSON.stringify({ tools: BUILD_TOOLS, guard: GUARD_CONFIG }),
        guardModule,
        'http://127.0.0.1:9',
        { PI_CODING_AGENT_DIR: '/elsewhere/home' },
      );
      await mod.default(fakePi().pi);
    })()).rejects.toThrow(/agentDir/);
  });

  it('旧代次信封（无 integrity）→ 装载即 fail-closed（validateGuardConfig 拒绝）', async () => {
    if (!guardModule) return;
    const legacy = { ...GUARD_CONFIG, schemaVersion: 1 } as Partial<FrozenDispatchConfig>;
    delete legacy.integrity;
    await expect((async () => {
      const mod = await loadBuildFactory(JSON.stringify({ tools: BUILD_TOOLS, guard: legacy }), guardModule, 'http://127.0.0.1:9');
      await mod.default(fakePi().pi);
    })()).rejects.toThrow(/integrity/);
  });
});

describe('A3 factory 接线（构建模式）', () => {
  const guardModule = resolveDispatchGuardModule();
  let api: MockApi;
  beforeAll(async () => {
    api = await startMockApi([
      { name: 'task_submit', label: 'App task', description: '应用 task 工具（构建模式必须跳过注册）', parameters: { type: 'object' } },
      { name: 'task_cancel', label: 'App cancel', description: '同上', parameters: { type: 'object' } },
      { name: 'kb_build_probe', label: '构建工具', description: '应用构建 Leader 工具', parameters: { type: 'object' } },
    ]);
  });
  afterAll(async () => { await api.close(); });

  it('不注册应用 task 工具族；白名单工具照常注册；session_start 激活=白名单；外部插件开关不生效', async () => {
    if (!guardModule) { console.warn('skip: no dispatch-guard module'); return; }
    const mod = await loadBuildFactory(JSON.stringify({ tools: BUILD_TOOLS, guard: GUARD_CONFIG }), guardModule, api.url);
    const fake = fakePi([{ name: 'external_tool', sourceInfo: { path: '/somewhere/ext.js' } }]);
    await mod.default(fake.pi);
    const names = fake.state.registered.map((tool) => tool.name);
    expect(names).toContain('kb_build_probe');
    expect(names).not.toContain('task_submit');
    expect(names).not.toContain('task_cancel');
    fake.state.handlers.session_start[0](undefined, { modelRegistry: { refresh: async () => {} } });
    expect(fake.state.activeTools).toEqual(BUILD_TOOLS);
    const blocked = fake.state.handlers.tool_call[0]({ toolName: 'external_tool', input: {} });
    expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining('构建模式工具白名单未包含 external_tool') });
    expect(fake.state.handlers.tool_call[0]({ toolName: 'bash', input: { command: 'rm -rf' } })).toMatchObject({ block: true });
    expect(fake.state.handlers.tool_call[0]({ toolName: 'kb_build_probe', input: {} })).toBeUndefined();
  });
  it('fail-closed：坏 JSON / 缺守卫模块 / 守卫配置非法（schemaVersion）均拒绝启动', async () => {
    if (!guardModule) { console.warn('skip: no dispatch-guard module'); return; }
    const badJson = await loadBuildFactory('{bad', guardModule, api.url);
    await expect(badJson.default(fakePi().pi)).rejects.toThrow(/JSON/);
    const noModule = await loadExtension({
      FEISHU_SYNC_AGENT_URL: api.url,
      FEISHU_SYNC_AGENT_RUN_TOKEN: 'fixture-token',
      FEISHU_SYNC_AGENT_BUILD_SPEC_JSON: JSON.stringify({ tools: BUILD_TOOLS, guard: GUARD_CONFIG }),
    });
    await expect(noModule.default(fakePi().pi)).rejects.toThrow(/FEISHU_SYNC_BUILD_GUARD_MODULE/);
    const badConfig = await loadBuildFactory(
      JSON.stringify({ tools: BUILD_TOOLS, guard: { ...GUARD_CONFIG, schemaVersion: 99 } }),
      guardModule,
      api.url,
    );
    await expect(badConfig.default(fakePi().pi)).rejects.toThrow(/validateGuardConfig/);
  });
});

describe('A4 factory 接线（普通会话行为保留）', () => {
  let api: MockApi;
  beforeAll(async () => {
    api = await startMockApi([
      { name: 'task_submit', label: 'App task', description: '普通会话照常注册', parameters: { type: 'object' } },
      { name: 'kb_read', label: '读', description: '读工具', parameters: { type: 'object' } },
    ]);
  });
  afterAll(async () => { await api.close(); });

  it('无构建 env：注册全部工具（含 task 族），不挂守卫，未启用外部插件时不收窄', async () => {
    const mod = await loadExtension({ FEISHU_SYNC_AGENT_URL: api.url, FEISHU_SYNC_AGENT_RUN_TOKEN: 'fixture-token' });
    const fake = fakePi();
    await mod.default(fake.pi);
    expect(fake.state.registered.map((tool) => tool.name).sort()).toEqual(['kb_read', 'task_submit']);
    fake.state.handlers.session_start[0](undefined, { modelRegistry: { refresh: async () => {} } });
    expect(fake.state.activeTools).toBeNull();
    const handler = fake.state.handlers.tool_call[0];
    expect(handler({ toolName: 'kb_read', input: {} })).toBeUndefined();
    expect(handler({ toolName: 'task_submit', input: { agent: 'anyone', scope: { shell: 'guarded' } } })).toBeUndefined();
    expect(handler({ toolName: 'bash', input: {} })).toMatchObject({ block: true });
  });
  it('外部插件模式（非构建）：现有开关语义不变', async () => {
    const mod = await loadExtension({ FEISHU_SYNC_AGENT_URL: api.url, FEISHU_SYNC_AGENT_RUN_TOKEN: 'fixture-token' });
    const fake = fakePi([{ name: 'external_tool', sourceInfo: { path: '/somewhere/ext.js' } }]);
    await mod.default(fake.pi);
    process.env.FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS = '1';
    try {
      fake.state.handlers.session_start[0](undefined, { modelRegistry: { refresh: async () => {} } });
      expect([...(fake.state.activeTools ?? [])].sort()).toEqual(['external_tool', 'kb_read', 'task_submit']);
      expect(fake.state.handlers.tool_call[0]({ toolName: 'external_tool', input: {} })).toBeUndefined();
    } finally {
      delete process.env.FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS;
    }
  });
});

// ── B 层：真实 Pi 事件管线（本机 pi 1.4；缺失整层 skip）──
const B_TEST_TIMEOUT_MS = 180_000;

let bRuntime: Awaited<ReturnType<PiRuntimeResolver['resolveRuntime']>> | null = null;
let bRoot = '';
beforeAll(async () => {
  bRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-build-ext-it-'));
  const resolver = new PiRuntimeResolver();
  bRuntime = await resolver.resolveRuntime(buildDefaultAgentConfig(bRoot));
});
afterAll(async () => {
  // amagi 终态诊断文件可能在子进程退出通知后完成；仅清理阶段允许有界重试，
  // 不把异步落盘竞争误判为工具授权断言失败。持续写入仍会令清理失败。
  await fs.promises.rm(bRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await fs.promises.rm(INTEGRITY_TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const bPiAvailable = () => Boolean(bRuntime?.nodePath && bRuntime?.piCliPath);

type OpenAiMock = { url: string; close(): Promise<void>; conversations: Record<string, unknown>[] };

function startOpenAiMock(script: (payload: { messages?: { role?: string }[] }) => { chunks: unknown[] }): Promise<OpenAiMock> {
  const conversations: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const payload = JSON.parse(body);
      conversations.push(payload);
      const { chunks } = script(payload as never);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(() => done())), conversations });
    });
  });
}

function toolCallChunks(calls: { name: string; args: unknown }[]): unknown[] {
  const base = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1700000000, model: 'mock-1' };
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `call_${index + 1}_${call.name}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

function textChunks(text: string): unknown[] {
  const base = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1700000000, model: 'mock-1' };
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
}

function baseLeaderEnv(bRootDir: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  // 关键：从零构造（不继承 process.env）——本测试进程自身携带 AMAGI_* 身份变量，
  // 若泄漏进被测 pi 进程，amagi-core 会走子进程分支（Leader 工具面全部不注册）。
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: bRootDir,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    PI_CODING_AGENT_DIR: path.join(bRootDir, 'agent-dir'),
    ...extra,
  };
  return env;
}

describe('B1 真实 Pi 管线（mock 任务工具；守卫改参进入执行/越权阻断）', () => {
  it('真实 pi 进程内：白名单激活、task 族不注册、守卫改参进入执行、越权被阻断', async () => {
    const guardModule = resolveDispatchGuardModule();
    if (!bPiAvailable() || !guardModule) {
      console.warn('[build-runtime-extension] 本机无 pi 运行时或 dispatch-guard 模块，B1 跳过');
      return;
    }
    const workDir = path.join(bRoot, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    const api = await startMockApi([
      { name: 'task_submit', label: 'App task', description: '应用同名工具（构建模式必须跳过，否则与 probe 模拟的 amagi 注册冲突退出）', parameters: { type: 'object' } },
      { name: 'kb_build_probe', label: '构建', description: '应用构建工具', parameters: { type: 'object' } },
    ]);
    const openai = await startOpenAiMock((payload) => {
      const hasToolResult = (payload.messages ?? []).some((message) => message.role === 'tool');
      if (!hasToolResult) {
        return { chunks: toolCallChunks([
          { name: 'task_submit', args: JSON.parse(JSON.stringify(HOSTILE_SUBMIT)) },
          { name: 'task_submit', args: { agent: 'fuxi', task: '越界角色' } },
          { name: 'task_resume', args: { handle: 'deadbeef', message: '继续', model: 'zhipuai/glm-4' } },
          { name: 'probe_forbidden_tool', args: {} },
        ]) };
      }
      return { chunks: textChunks('done') };
    });
    const probeExtension = path.join(bRoot, 'probe-extension.js');
    fs.writeFileSync(probeExtension, `import fs from 'node:fs';
const dir = process.env.PROBE_DIR;
const record = (name, args) => fs.appendFileSync(dir + '/probe-calls.jsonl', JSON.stringify({ name, args }) + '\\n');
export default function (pi) {
  pi.registerTool({ name: 'task_submit', label: 'Probe submit', description: 'probe mimic of amagi task_submit', parameters: { type: 'object', additionalProperties: true }, execute: async (_id, args) => { record('task_submit', args); return { content: [{ type: 'text', text: JSON.stringify(args) }], details: undefined }; } });
  pi.registerTool({ name: 'task_resume', label: 'Probe resume', description: 'probe mimic of amagi task_resume', parameters: { type: 'object', additionalProperties: true }, execute: async (_id, args) => { record('task_resume', args); return { content: [{ type: 'text', text: JSON.stringify(args) }], details: undefined }; } });
  pi.registerTool({ name: 'probe_forbidden_tool', label: 'Forbidden', description: 'registered but outside build whitelist', parameters: { type: 'object' }, execute: async () => { record('probe_forbidden_tool', {}); return { content: [{ type: 'text', text: 'should-never-run' }], details: undefined }; } });
  pi.on('session_start', () => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), 'probe_forbidden_tool'])]);
    fs.writeFileSync(dir + '/active-tools.json', JSON.stringify(pi.getActiveTools()));
  });
}
`);
    const guardConfig = { ...GUARD_CONFIG, workDir };
    const env = baseLeaderEnv(bRoot, {
      PROBE_DIR: bRoot,
      // F12：派发前完整性重核验需要 Leader agentDir 与冻结引用一致且磁盘完整
      PI_CODING_AGENT_DIR: GUARD_CONFIG.integrity.homeDir,
      FEISHU_SYNC_AGENT_URL: api.url,
      FEISHU_SYNC_AGENT_RUN_TOKEN: 'fixture-token',
      FEISHU_SYNC_AGENT_API_KEY: 'fixture-key',
      FEISHU_SYNC_AGENT_PROVIDER_JSON: JSON.stringify({ api: 'openai-completions', baseUrl: `${openai.url}/v1`, models: [{ id: 'mock-1', name: 'Mock', contextWindow: 8192, maxTokens: 1024 }] }),
      FEISHU_SYNC_AGENT_BUILD_SPEC_JSON: JSON.stringify({ tools: BUILD_TOOLS, guard: guardConfig }),
      FEISHU_SYNC_BUILD_GUARD_MODULE: guardModule,
    });
    const stderr: string[] = [];
    const rpc = new PiRpcProcess({
      nodePath: bRuntime!.nodePath!,
      piCliPath: bRuntime!.piCliPath!,
      extensionPath: EXTENSION_PATH,
      additionalExtensionPaths: [probeExtension],
      tools: [],
      model: 'feishu-sync-llm/mock-1',
      noSession: false,
      noTools: false,
      sessionDir: path.join(bRoot, 'sessions'),
      cwd: workDir,
      env,
      promptTimeoutMs: 60_000,
    });
    rpc.on('stderr', (chunk: string) => stderr.push(chunk));
    try {
      await rpc.start(30_000);
      const outcome = await rpc.prompt('drive the fixture probe', { timeoutMs: 60_000 });
      expect(outcome.outcome).toBe('completed');
      const active = JSON.parse(fs.readFileSync(path.join(bRoot, 'active-tools.json'), 'utf8')).sort();
      expect(active).toEqual(['kb_build_probe', 'probe_forbidden_tool', 'task_resume', 'task_submit']);
      const calls = fs.readFileSync(path.join(bRoot, 'probe-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const executed = calls.filter((call) => call.name === 'task_submit');
      expect(executed).toHaveLength(1);
      const args = executed[0].args;
      expect(args.scope.shell).toBe('deny');
      expect(args.scope.write).toEqual(['agent-outputs/**', 'agent-outputs/report.md']);
      expect(args.scope.mcp).toEqual(['kb_read_material', 'kb_submit_draft']);
      expect(args.scope.deny).toEqual([...GUARD_CONFIG.forbiddenZones].sort());
      expect('advisor' in args.scope).toBe(false);
      expect('lsp' in args.scope).toBe(false);
      expect(args.workspace).toEqual({ cwd: workDir, mode: 'existing' });
      expect('profile' in args).toBe(false);
      expect(args.model).toBe('zhipuai/glm-5.3-flash');
      expect(calls.some((call) => call.name === 'probe_forbidden_tool')).toBe(false);
      expect(calls.some((call) => call.name === 'task_resume')).toBe(false);
      const followUpText = JSON.stringify(openai.conversations[openai.conversations.length - 1]);
      expect(followUpText).toContain('不在本次构建的角色表内');
      expect(followUpText).toContain('不在冻结模型集内');
      expect(followUpText).toContain('构建模式工具白名单未包含 probe_forbidden_tool');
      const guardLogs = stderr.join('').split('\n').filter((line) => line.includes('[feishu-sync-agent][build-guard]'));
      expect(guardLogs.some((line) => line.includes('"event":"guard_amended"'))).toBe(true);
      expect(guardLogs.some((line) => line.includes('"event":"guard_blocked"'))).toBe(true);
      expect(guardLogs.some((line) => line.includes('"taskSha256"'))).toBe(true);
    } finally {
      await rpc.terminate();
      await openai.close();
      await api.close();
    }
  }, B_TEST_TIMEOUT_MS);
});

describe('B2 真实 amagi-core 派发（守卫改参落入 amagi 冻结契约）', () => {
  it('真实 task_submit 经守卫后冻结 spec 与生效 grant；越界模型/思考档位被阻断且不建任务', async () => {
    const guardModule = resolveDispatchGuardModule();
    const amagiPackageRoot = process.env.FEISHU_TEST_AMAGI_PACKAGE_ROOT || '/Users/run.mao/workpace/amagi-pi';
    const amagiReady = fs.existsSync(path.join(amagiPackageRoot, 'extensions', 'amagi-core', 'index.ts'));
    if (!bPiAvailable() || !guardModule || !amagiReady) {
      console.warn('[build-runtime-extension] 本机无 pi/amagi-pi/dispatch-guard，B2 跳过');
      return;
    }
    const workDir = path.join(bRoot, 'amagi-work');
    fs.mkdirSync(workDir, { recursive: true });
    const agentDir = path.join(bRoot, 'agent-dir');
    fs.mkdirSync(agentDir, { recursive: true });
    const api = await startMockApi([
      { name: 'task_submit', label: 'App task', description: '应用同名工具（构建模式必须跳过，与 amagi-core 注册冲突会 error 退出）', parameters: { type: 'object' } },
      { name: 'kb_build_probe', label: '构建', description: '应用构建工具', parameters: { type: 'object' } },
    ]);
    const openai = await startOpenAiMock((payload) => {
      const hasToolResult = (payload.messages ?? []).some((message) => message.role === 'tool');
      if (!hasToolResult) {
        return { chunks: toolCallChunks([
          { name: 'task_submit', args: { ...JSON.parse(JSON.stringify(HOSTILE_SUBMIT)), model: 'feishu-sync-llm/mock-1' } },
          { name: 'task_submit', args: { agent: 'luban', task: '未冻结思考档位', model: 'feishu-sync-llm/mock-1:high', delivery: 'handle' } },
          { name: 'task_submit', args: { agent: 'diting', task: '他角色模型', model: 'feishu-sync-llm/mock-1', delivery: 'handle' } },
        ]) };
      }
      return { chunks: textChunks('done') };
    });
    // amagi v2 派发预检硬校验任务模型在 Leader modelRegistry 注册：冻结模型用转发
    // provider 自身的 mock 模型（子进程解析不到属预期——契约在 spawn 前已冻结）。
    const guardConfig = {
      ...GUARD_CONFIG, buildId: 'b_probe_amagi', workDir,
      roles: {
        luban: { key: 'writer', models: ['feishu-sync-llm/mock-1'], mcpTools: ['kb_read_material', 'kb_submit_draft'] },
        diting: { key: 'reviewer', models: ['feishu-sync-llm/mock-2'], mcpTools: ['kb_submit_review'] },
        baize: { key: 'research', models: ['feishu-sync-llm/mock-2'], mcpTools: [] },
      },
    };
    const env = baseLeaderEnv(bRoot, {
      FEISHU_SYNC_AGENT_URL: api.url,
      // F12：派发前完整性重核验（agentDir 与冻结引用一致 + 磁盘完整；v2-store 也落在该 home）
      PI_CODING_AGENT_DIR: GUARD_CONFIG.integrity.homeDir,
      FEISHU_SYNC_AGENT_RUN_TOKEN: 'fixture-token',
      FEISHU_SYNC_AGENT_API_KEY: 'fixture-key',
      FEISHU_SYNC_AGENT_PROVIDER_JSON: JSON.stringify({ api: 'openai-completions', baseUrl: `${openai.url}/v1`, models: [
        { id: 'mock-1', name: 'Mock writer', contextWindow: 8192, maxTokens: 1024 },
        { id: 'mock-2', name: 'Mock reviewer', contextWindow: 8192, maxTokens: 1024 },
      ] }),
      FEISHU_SYNC_AGENT_BUILD_SPEC_JSON: JSON.stringify({ tools: BUILD_TOOLS, guard: guardConfig }),
      FEISHU_SYNC_BUILD_GUARD_MODULE: guardModule,
      // amagi 自动行为冻结（environment.ts 同源语义）：确定性，避免子任务自动验证/续跑
      AMAGI_AUTO_VERIFY_OFF: '1',
      AMAGI_AUTO_CONTINUE_ROUNDS: '0',
      AMAGI_AUTO_REPAIR_ROUNDS: '0',
      AMAGI_AUTORETRY_IMPLICIT_ROUNDS: '0',
    });
    const stderr: string[] = [];
    const rpc = new PiRpcProcess({
      nodePath: bRuntime!.nodePath!,
      piCliPath: bRuntime!.piCliPath!,
      // 扩展顺序与运行时 adapter 一致：amagi-core 先加载，转发扩展后加载（session_start 收窄最后生效）
      additionalExtensionPaths: [amagiPackageRoot, EXTENSION_PATH],
      tools: BUILD_TOOLS,
      model: 'feishu-sync-llm/mock-1',
      noSession: false,
      noTools: false,
      sessionDir: path.join(bRoot, 'amagi-sessions'),
      cwd: workDir,
      env,
      promptTimeoutMs: 90_000,
    });
    rpc.on('stderr', (chunk: string) => stderr.push(chunk));
    try {
      await rpc.start(60_000);
      const outcome = await rpc.prompt('dispatch the fixture build task', { timeoutMs: 90_000 });
      expect(outcome.outcome).toBe('completed');
      // 1) 声明给模型的工具面=白名单∩已注册（真实 amagi 面上的收窄证据）
      const firstRequest = openai.conversations[0] as { tools?: { function?: { name?: string } }[] };
      const declared = (firstRequest.tools ?? []).map((tool) => tool.function?.name ?? '').sort();
      expect(declared).toContain('task_submit');
      expect(declared).toContain('amagi_resource');
      expect(declared).toContain('kb_build_probe');
      expect(declared).not.toContain('run_bg');
      expect(declared).not.toContain('codemode');
      expect(declared).not.toContain('bash');
      // 2) 守卫改参后 amagi 真实冻结契约：仅一个任务（两次越界被拦截未建任务）
      const specFiles: { file: string; spec: Record<string, any> }[] = [];
      const v2Root = path.join(GUARD_CONFIG.integrity.homeDir, 'amagi', 'v2-store');
      if (fs.existsSync(v2Root)) {
        for (const entry of fs.readdirSync(v2Root)) {
          const taskDir = path.join(v2Root, entry);
          if (!fs.statSync(taskDir).isDirectory()) continue;
          for (const file of fs.readdirSync(taskDir)) {
            if (/^spec-.*\.json$/.test(file)) {
              specFiles.push({ file: path.join(taskDir, file), spec: JSON.parse(fs.readFileSync(path.join(taskDir, file), 'utf8')) });
            }
          }
        }
      }
      expect(specFiles).toHaveLength(1);
      const spec = specFiles[0].spec;
      expect(spec.agent).toBe('luban');
      expect(spec.permission.shell).toBe('deny');
      const mcpTools = (spec.permission.mcp ?? []).map((grant: { tool?: string }) => grant.tool).sort();
      expect(mcpTools).toEqual(['kb_read_material', 'kb_submit_draft']);
      const writeValues = (spec.permission.write ?? []).map((rule: { value?: string }) => rule.value);
      expect(writeValues.some((value: string) => value.includes('agent-outputs'))).toBe(true);
      const denyValues = (spec.permission.deny ?? []).map((rule: { value?: string }) => rule.value);
      for (const zone of GUARD_CONFIG.forbiddenZones) {
        expect(denyValues.some((value: string) => value.includes(zone.replace('/**', '')))).toBe(true);
      }
      expect(spec.permission.lsp ?? []).toEqual([]);
      expect(spec.permission.advisor).toBeUndefined();
      expect(spec.workspace.cwd).toBe(workDir);
      expect(spec.workspace.mode).toBe('existing');
      // 3) 越界模型/思考档位被守卫阻断：不进 amagi、错误回执可见、无对应任务
      const followUpText = JSON.stringify(openai.conversations[openai.conversations.length - 1]);
      expect(followUpText).toContain('不在角色 luban 的冻结模型内');
      expect(followUpText).toContain('不在角色 diting 的冻结模型内');
      expect(stderr.join('')).toContain('"event":"guard_amended"');
      expect(stderr.join('')).toContain('"event":"guard_blocked"');
    } finally {
      await rpc.terminate(8_000);
      await openai.close();
      await api.close();
    }
  }, B_TEST_TIMEOUT_MS);
});
