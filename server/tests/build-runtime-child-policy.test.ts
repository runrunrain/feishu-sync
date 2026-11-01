/**
 * child-policy 测试（设计 v2 §3.3/§13.1 子任务工具面缺口收口）
 *
 * 分层：
 * - 单元：源码确定性/hash/纯 JS 语法（node --check 真校验）；真实 import 物化文件后
 *   用最小 fake pi 验证 session_start/before_agent_start 面过滤与 tool_call 阻断、
 *   无 AMAGI_TASK_ID 时零行为。
 * - 配置：settings.extensions 声明、writeAgentDirConfig 物化与幂等、篡改/缺失
 *   fail-closed、agentDirConfigMatchesSpec 字段感知完整比对（资源注入缺口）、
 *   禁区含构建 homeDir。
 * - 真实链路（PI_PROBE_PI_CLI + PI_PROBE_SOURCE_AMAGI 提供时才跑，缺资源自动跳过）：
 *   真实 pi + 真实 amagi（installAmagiPackage source 物化）子进程，按 amagi
 *   task-run 的真实交付面 spawn（--mode json -p + --tools 含无条件追加的
 *   codemode/toolcall_continue），fixture OpenAI 兼容模型观测每轮模型请求的工具
 *   声明。对照组（无 policy）复现缺口；实验组证明面被移除且强制调用被拒。
 *   fixture 模型不是 LLM 质量/性能证据，仅驱动真实工具链路。
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CHILD_POLICY_DISABLED_TOOLS, CHILD_POLICY_FILE_PREFIX,
  childPolicyContentHash, childPolicyFileName, isStaleChildPolicyFile,
  materializeChildPolicyFile, renderChildPolicySource, verifyChildPolicyFile,
} from '../src/agent/build-runtime/child-policy.js';
import {
  agentDirConfigMatchesSpec, buildForbiddenZones, computeAgentDirConfigHash,
  planBuildDirectories, renderAgentDirConfigFiles, validateRenderedConfig,
  writeAgentDirConfig,
} from '../src/agent/build-runtime/agent-dir-config.js';
import { makeSpec } from './build-runtime-contracts.test.js';

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-policy-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

const BRIDGE = { bridgeCommand: '/usr/local/bin/node', bridgeArgs: ['/app/server/dist/agent/build-mcp-bridge.cjs'] };

// ── 单元：源码与文件名 ────────────────────────────────────────────────────

describe('renderChildPolicySource / 哈希 / 文件名', () => {
  it('确定性渲染：两次调用逐字节一致，hash/文件名稳定且文件名含内容 hash', () => {
    const a = renderChildPolicySource();
    const b = renderChildPolicySource();
    expect(a).toBe(b);
    expect(childPolicyContentHash(a)).toBe(childPolicyContentHash(b));
    expect(childPolicyFileName(a)).toBe(childPolicyFileName(b));
    expect(childPolicyFileName(a)).toMatch(/^child-policy-[0-9a-f]{12}\.js$/);
  });

  it('禁用名单 = 设计 §3.3 冻结的 codemode/tool_search，且完整出现在源码内', () => {
    expect(CHILD_POLICY_DISABLED_TOOLS).toEqual(['codemode', 'tool_search']);
    const src = renderChildPolicySource();
    for (const name of CHILD_POLICY_DISABLED_TOOLS) expect(src).toContain(`'${name}'`);
  });

  it('纯 JS：node --check 通过（真实语法校验）；无 import/require、不注册工具、不触网', async () => {
    const src = renderChildPolicySource();
    expect(src).not.toMatch(/^import\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toContain('registerTool');
    expect(src).not.toContain('registerMcpServer');
    expect(src).not.toContain('fetch(');
    const file = path.join(tmpRoot(), 'policy-syntax.mjs');
    fs.writeFileSync(file, src);
    const check = spawn(process.execPath, ['--check', file]);
    const code = await new Promise<number>((resolve) => {
      check.on('exit', (c) => resolve(c ?? -1));
      check.on('error', () => resolve(-1));
    });
    expect(code).toBe(0);
  }, 20_000);

  it('isStaleChildPolicyFile：仅识别其它内容寻址 policy 文件', () => {
    const current = childPolicyFileName();
    expect(isStaleChildPolicyFile('child-policy-000000000000.js', current)).toBe(true);
    expect(isStaleChildPolicyFile(current, current)).toBe(false);
    expect(isStaleChildPolicyFile('settings.json', current)).toBe(false);
    expect(isStaleChildPolicyFile('child-policy-short.js', current)).toBe(false);
  });
});

// ── 单元：扩展行为（真实 import 物化文件 + 最小 fake pi） ────────────────

function loadPolicyModule(): Promise<{ default: (pi: unknown) => void }> {
  const file = path.join(tmpRoot(), childPolicyFileName());
  fs.writeFileSync(file, renderChildPolicySource());
  return import(pathToFileURL(file).href);
}

function makeFakePi() {
  let active = ['read', 'codemode', 'tool_search', 'write', 'toolcall_continue'];
  const handlers = new Map<string, Array<(event: unknown) => unknown>>();
  const pi = {
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    on: (event: string, handler: (event: unknown) => unknown) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
  };
  return {
    pi,
    registeredEvents: () => [...handlers.keys()],
    emit: (event: string, ev: unknown) => {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) result = handler(ev);
      return result;
    },
    setActive: (names: string[]) => { active = [...names]; },
    activeTools: () => [...active],
  };
}

describe('child-policy 扩展行为', () => {
  const hadTaskId = Object.prototype.hasOwnProperty.call(process.env, 'AMAGI_TASK_ID');
  const prevTaskId = process.env.AMAGI_TASK_ID;
  afterAll(() => {
    if (hadTaskId) process.env.AMAGI_TASK_ID = prevTaskId;
    else delete process.env.AMAGI_TASK_ID;
  });

  it('无 AMAGI_TASK_ID：工厂零注册（非 amagi 子任务零行为）', async () => {
    delete process.env.AMAGI_TASK_ID;
    const mod = await loadPolicyModule();
    const fake = makeFakePi();
    mod.default(fake.pi);
    expect(fake.registeredEvents()).toEqual([]);
  });

  it('多锚点面过滤：session_start/before_agent_start/turn_start/turn_end/agent_end/tool_result/message_end/message_start 均重放', async () => {
    process.env.AMAGI_TASK_ID = 'unit-task-1';
    const mod = await loadPolicyModule();
    const fake = makeFakePi();
    mod.default(fake.pi);
    expect(fake.registeredEvents().sort()).toEqual(['agent_end', 'before_agent_start', 'message_end', 'message_start', 'session_start', 'tool_call', 'tool_result', 'turn_end', 'turn_start']);
    fake.emit('session_start', undefined);
    expect(fake.activeTools()).toEqual(['read', 'write', 'toolcall_continue']);
    // 运行中被重新激活（模拟宿主注册表重建/长度截断恢复对 --tools 点名工具的重激活），
    // 每个锚点都能独立把面清回来
    for (const anchor of ['before_agent_start', 'turn_start', 'turn_end', 'agent_end', 'tool_result'] as const) {
      fake.setActive(['read', 'codemode', 'tool_search', 'write']);
      fake.emit(anchor, {});
      expect(fake.activeTools(), anchor).toEqual(['read', 'write']);
    }
    // 角色限定的锚点：assistant 消息终结与系统面补丁
    fake.setActive(['read', 'codemode', 'tool_search', 'write']);
    fake.emit('message_end', { message: { role: 'assistant' } });
    expect(fake.activeTools()).toEqual(['read', 'write']);
    fake.setActive(['read', 'codemode', 'tool_search', 'write']);
    fake.emit('message_start', { message: { role: 'system', toolsAdded: [{ name: 'codemode' }] } });
    expect(fake.activeTools()).toEqual(['read', 'write']);
    // 非目标角色不触发（避免无谓重算；链式事件返回 undefined 透传）
    fake.setActive(['read', 'codemode', 'write']);
    expect(fake.emit('message_end', { message: { role: 'toolResult' } })).toBeUndefined();
    expect(fake.activeTools()).toEqual(['read', 'codemode', 'write']);
    expect(fake.emit('message_start', { message: { role: 'assistant' } })).toBeUndefined();
    expect(fake.activeTools()).toEqual(['read', 'codemode', 'write']);
  });

  it('tool_call：禁用名一律 block（含重激活后），其余透传 undefined', async () => {
    process.env.AMAGI_TASK_ID = 'unit-task-2';
    const mod = await loadPolicyModule();
    const fake = makeFakePi();
    mod.default(fake.pi);
    for (const name of CHILD_POLICY_DISABLED_TOOLS) {
      const decision = fake.emit('tool_call', { toolName: name, input: {} });
      expect(decision).toMatchObject({ block: true });
      expect(String((decision as { reason: string }).reason)).toContain('child-policy');
    }
    expect(fake.emit('tool_call', { toolName: 'read', input: {} })).toBeUndefined();
    expect(fake.emit('tool_call', { toolName: 'toolcall_continue', input: {} })).toBeUndefined();
  });

  it('面过滤抛错不外溢（tool_call 阻断独立生效，双路 fail-safe）', async () => {
    process.env.AMAGI_TASK_ID = 'unit-task-3';
    const mod = await loadPolicyModule();
    const handlers: Record<string, Array<(event: unknown) => unknown>> = {};
    const pi = {
      getActiveTools: () => { throw new Error('registry unavailable'); },
      setActiveTools: () => { throw new Error('unreachable'); },
      on: (event: string, handler: (event: unknown) => unknown) => { (handlers[event] ??= []).push(handler); },
    };
    mod.default(pi);
    expect(() => handlers.session_start![0]!(undefined)).not.toThrow();
    const decision = handlers.tool_call![0]!({ toolName: 'codemode', input: {} });
    expect(decision).toMatchObject({ block: true });
  });
});

// ── 配置集成：声明、物化、fail-closed、字段感知比对 ──────────────────────

describe('agentDir 配置 × child-policy', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('settings.json 显式声明内容寻址 policy；validateRenderedConfig 校验唯一条目', () => {
    const spec = makeSpec();
    const dirs = planBuildDirectories(root, spec.buildId);
    const files = renderAgentDirConfigFiles(spec, dirs, BRIDGE);
    const settings = JSON.parse(files.settings);
    expect(settings.extensions).toEqual([childPolicyFileName()]);
    expect(validateRenderedConfig(files, spec, dirs)).toEqual([]);
    settings.extensions = ['/evil/extension.js'];
    const issues = validateRenderedConfig({ ...files, settings: `${JSON.stringify(settings, null, 2)}\n` }, spec, dirs);
    expect(issues.join()).toContain('child-policy');
  });

  it('writeAgentDirConfig 物化 policy 文件（字节一致）且幂等；settings 含 hash 文件名（configHash 间接绑定）', () => {
    const spec = makeSpec();
    const dirs = planBuildDirectories(root, spec.buildId);
    const rendered = renderAgentDirConfigFiles(spec, dirs, BRIDGE);
    spec.agentDirConfigHash = computeAgentDirConfigHash(rendered);
    const { configHash } = writeAgentDirConfig(spec, dirs, BRIDGE);
    expect(configHash).toBe(spec.agentDirConfigHash);
    expect(verifyChildPolicyFile(dirs.homeDir).ok).toBe(true);
    const policyPath = path.join(dirs.homeDir, childPolicyFileName());
    expect(fs.readFileSync(policyPath, 'utf-8')).toBe(renderChildPolicySource());
    writeAgentDirConfig(spec, dirs, BRIDGE);
    expect(fs.readFileSync(policyPath, 'utf-8')).toBe(renderChildPolicySource());
    expect(JSON.parse(rendered.settings).extensions[0]).toBe(childPolicyFileName());
  });

  it('同名文件被篡改 → materialize fail-closed 拒绝覆盖', () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, childPolicyFileName()), '// tampered\n');
    expect(() => materializeChildPolicyFile(home)).toThrow(/篡改/);
  });

  it('陈旧 hash 的 policy 文件在物化时被清理（未声明即不加载，清理仅卫生）', () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, `${CHILD_POLICY_FILE_PREFIX}000000000000.js`), '// stale\n');
    const { fileName } = materializeChildPolicyFile(home);
    expect(fileName).toBe(childPolicyFileName());
    expect(fs.readdirSync(home).filter((n) => n.startsWith(CHILD_POLICY_FILE_PREFIX))).toEqual([fileName]);
  });

  it('agentDirConfigMatchesSpec：新鲜落盘 ok；policy 缺失/篡改 → fail（加载前验内容）', () => {
    const spec = makeSpec();
    const dirs = planBuildDirectories(root, spec.buildId);
    const rendered = renderAgentDirConfigFiles(spec, dirs, BRIDGE);
    spec.agentDirConfigHash = computeAgentDirConfigHash(rendered);
    writeAgentDirConfig(spec, dirs, BRIDGE);
    expect(agentDirConfigMatchesSpec(dirs.homeDir, spec, BRIDGE)).toEqual({ ok: true, issues: [] });
    const policyPath = path.join(dirs.homeDir, childPolicyFileName());
    fs.rmSync(policyPath);
    expect(agentDirConfigMatchesSpec(dirs.homeDir, spec, BRIDGE).issues.join()).toContain('缺失');
    fs.writeFileSync(policyPath, `${renderChildPolicySource()}\n// tampered\n`);
    expect(agentDirConfigMatchesSpec(dirs.homeDir, spec, BRIDGE).issues.join()).toContain('不一致');
  });

  it('settings 冻结面完整比对：extensions/skills/prompts/themes/defaultTools/未知字段均不得漂移', () => {
    const spec = makeSpec();
    const dirs = planBuildDirectories(root, spec.buildId);
    const rendered = renderAgentDirConfigFiles(spec, dirs, BRIDGE);
    spec.agentDirConfigHash = computeAgentDirConfigHash(rendered);
    writeAgentDirConfig(spec, dirs, BRIDGE);
    const settingsPath = path.join(dirs.homeDir, 'settings.json');
    const base = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const writeSettings = (mutate: (s: Record<string, unknown>) => void): void => {
      const next = JSON.parse(JSON.stringify(base));
      mutate(next);
      fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2));
    };
    const expectFail = (needle: string, mutate: (s: Record<string, unknown>) => void): void => {
      writeSettings(mutate);
      const { ok, issues } = agentDirConfigMatchesSpec(dirs.homeDir, spec, BRIDGE);
      expect(ok, `${needle}: ${issues.join()}`).toBe(false);
      expect(issues.join()).toContain(needle);
    };
    expectFail('extensions', (s) => { (s.extensions as string[])[0] = '/evil/other.js'; });
    expectFail('extensions', (s) => { delete s.extensions; });
    expectFail('skills', (s) => { s.skills = ['/evil/skill']; });
    expectFail('prompts', (s) => { s.prompts = ['/evil/prompt']; });
    expectFail('themes', (s) => { s.themes = ['/evil/theme']; });
    expectFail('defaultTools', (s) => { s.defaultTools = ['bash', '+codemode']; });
    expectFail('未知字段', (s) => { s.mcpServers = { evil: { command: 'x' } }; });
    expectFail('packages', (s) => { s.packages = [{ source: '/evil', skills: [] }]; });
    // amagi doctor 实测写入的 retry.provider.timeoutMs 是唯一容忍项；形状必须精确
    writeSettings((s) => { s.retry = { provider: { timeoutMs: 300000 } }; });
    expect(agentDirConfigMatchesSpec(dirs.homeDir, spec, BRIDGE).ok).toBe(true);
    expectFail('retry', (s) => { s.retry = { provider: { timeoutMs: 300000 }, enabled: false }; });
    expectFail('retry', (s) => { s.retry = { provider: { timeoutMs: 300000, maxRetries: 5 } }; });
    expectFail('retry', (s) => { s.retry = { enabled: true }; });
    expectFail('retry', (s) => { s.retry = { provider: { timeoutMs: 'large' } }; });
  });

  it('buildForbiddenZones：配置/policy 精确入禁区；home 其余（如 skills）不禁——子任务可读冻结 skill 正文', () => {
    const dirs = planBuildDirectories('/data', 'b_x');
    const zones = buildForbiddenZones({
      workDir: dirs.workDir,
      dataRoot: '/data',
      knowledgeBaseRoot: '/kb/raw',
      outputRoot: '/kb/std',
      userHome: '/home/u',
    });
    for (const file of ['settings.json', 'amagi.json', 'models.json', 'mcp.json', childPolicyFileName()]) {
      expect(zones).toContain(path.join(dirs.homeDir, file));
    }
    expect(zones).not.toContain(path.resolve(dirs.homeDir)); // 不整目录禁 home
    expect(zones).not.toContain(path.join(dirs.homeDir, 'skills')); // skill 正文可读
    expect(zones).not.toContain(path.resolve(dirs.workDir)); // 工作目录本身可写（任务写面）
  });
});

// ── 真实链路（gated：PI_PROBE_PI_CLI + PI_PROBE_SOURCE_AMAGI） ─────────────

const PI_CLI = process.env.PI_PROBE_PI_CLI ?? '';
const SOURCE_AMAGI = process.env.PI_PROBE_SOURCE_AMAGI ?? '';

describe.skipIf(!PI_CLI || !SOURCE_AMAGI)('真实 pi + 真实 amagi 子进程工具面（live）', () => {
  it(
    '对照组：无 policy 时 amagi 交付面把 codemode 送进模型工具面且可执行（复现缺口）',
    { timeout: 180_000 },
    async () => {
      const env = await prepareLiveEnv('ctrl');
      try {
        await runLiveChild(env, {
          marker: 'CHILD-POLICY-CTRL',
          steps: [{ toolCalls: [{ name: 'codemode', args: { code: "return 'CTRL-CODEMODE-EXECUTED';" } }] }],
          final: 'CTRL-DONE',
        });
        const entries = env.model.requestsFor('CHILD-POLICY-CTRL');
        expect(entries.length).toBeGreaterThanOrEqual(1);
        expect(entries[0].tools).toContain('codemode'); // 缺口复现：无 policy 时 codemode 在模型面内
        expect(env.model.allHistoryText('CHILD-POLICY-CTRL')).toContain('CTRL-CODEMODE-EXECUTED'); // 真实执行未被阻断
      } finally {
        await env.dispose();
      }
    },
  );

  it(
    '续传与直连路径：toolcall_continue 不能续接被禁工具；直接 mcp__ 调用不可绕过 wrapper；授权 mcp_call 正常',
    { timeout: 240_000 },
    async () => {
      const env = await prepareLiveEnv('live');
      try {
        // 步骤 1：制造截断的 codemode 调用（finish_reason=length）→ amagi 续传链保存 token；
        // 步骤 2：从历史 tool result 解析 token，用 toolcall_continue 尝试续接被禁工具；
        // 步骤 3：直接调用 mcp__feishu-kb-bridge__kb_echo（绕过 wrapper 的敌意路径）；
        // 步骤 4：合法 mcp_call（应用设计内唯一 MCP 通道）。
        await runLiveChild(env, {
          marker: 'CHILD-POLICY-RESUME',
          steps: [
            {
              delayMs: 900,
              finishReason: 'length',
              toolCalls: [{ name: 'codemode', raw: '{"code":"return ' }],
            },
            (historyText) => {
              const match = historyText.match(/token=(tc_[0-9a-f]{32}\.\d+)/);
              if (!match) return { toolCalls: [{ name: 'write', args: { path: `${env.workDir}/resume-token-miss.md`, content: historyText.slice(0, 2000) } }] };
              return {
                toolCalls: [{
                  name: 'toolcall_continue',
                  // append 与保存的 raw 拼接后须是完整 JSON；final=true 触发原工具执行判定
                  args: { token: match[1], append: "'pwned\"}", final: true },
                }],
              };
            },
            { toolCalls: [{ name: 'mcp__feishu-kb-bridge__kb_echo', args: { text: 'direct-bypass-attempt' } }] },
            { toolCalls: [{ name: 'mcp_call', args: { server: 'feishu-kb-bridge', tool: 'kb_echo', arguments: { text: 'legit-route' } } }] },
          ],
          final: 'RESUME-DONE',
        });
        const allText = env.model.allHistoryText('CHILD-POLICY-RESUME');
        // A. toolcall_continue 续接被禁工具：amagi 原生拒绝（保存时/执行时均不在 active 面），
        //    且嵌套执行路径过 policy tool_call 阻断——两层都不得出现 pwned 执行结果
        expect(allText).not.toContain("'pwned'");
        expect(allText).not.toContain('"pwned"');
        expect(allText).toMatch(/codemode not available in the active tool set|child-policy|无效续传 token|token (不存在|版本不匹配|持久记录)/);
        // B. 直接 mcp__ 调用：桥侧不落 direct-bypass-attempt（未触达）；结果为错误而非 echo
        const bridgeCalls = fs.existsSync(env.bridgeLog) ? fs.readFileSync(env.bridgeLog, 'utf-8') : '';
        expect(bridgeCalls).not.toContain('direct-bypass-attempt');
        expect(allText).not.toContain('echo:direct-bypass-attempt');
        // C. 授权 mcp_call 正常：桥侧落 legit-route 且回包可见
        expect(bridgeCalls).toContain('CALL:legit-route');
        expect(allText).toContain('echo:legit-route');
        // D. 全程工具面无禁用名（含续传轮）
        for (const entry of env.model.requestsFor('CHILD-POLICY-RESUME')) {
          expect(entry.tools).not.toContain('codemode');
          expect(entry.tools).not.toContain('tool_search');
        }
      } finally {
        await env.dispose();
      }
    },
  );

  it(
    '实验组：policy 加载后首/后续轮模型面无 codemode/tool_search，强制调用被拒，读写与 MCP 不受影响',
    { timeout: 240_000 },
    async () => {
      const env = await prepareLiveEnv('live');
      try {
        await runLiveChild(env, {
          marker: 'CHILD-POLICY-LIVE',
          steps: [
            { delayMs: 900, toolCalls: [{ name: 'read', args: { path: env.workFile } }] },
            { toolCalls: [{ name: 'codemode', args: { code: "return 'pwned';" } }] },
            { toolCalls: [{ name: 'tool_search', args: { query: 'bash' } }] },
            { toolCalls: [{ name: 'write', args: { path: env.reportFile, content: 'CHILD-POLICY-LIVE-REPORT' } }] },
            { toolCalls: [{ name: 'mcp_list_tools', args: { server: 'feishu-kb-bridge' } }] },
          ],
          final: 'LIVE-DONE',
        });
        const entries = env.model.requestsFor('CHILD-POLICY-LIVE');
        expect(entries.length).toBeGreaterThanOrEqual(6); // 5 步 + 终轮：多轮证据
        for (const entry of entries) {
          expect(entry.tools, `step${entry.step} 工具面含禁用名`).not.toContain('codemode');
          expect(entry.tools, `step${entry.step} 工具面含禁用名`).not.toContain('tool_search');
        }
        const face = entries[0].tools;
        for (const required of ['read', 'write', 'mcp_call', 'mcp_list_tools', 'amagi_resource', 'toolcall_continue']) {
          expect(face).toContain(required);
        }
        const allText = env.model.allHistoryText('CHILD-POLICY-LIVE');
        expect(allText).toContain('child-policy'); // 强制调用被 policy 阻断（理由进入工具结果）
        expect(allText).toContain('CHILD-POLICY-LIVE-WORKFILE'); // read 正常
        expect(allText).toContain('kb_echo'); // MCP 通道未受影响
        expect(fs.readFileSync(env.reportFile, 'utf-8')).toContain('CHILD-POLICY-LIVE-REPORT'); // 报告写不受影响
      } finally {
        await env.dispose();
      }
    },
  );
});

// ── live 支撑（fixture 模型服务器 / MCP 桥 / 子进程驱动） ─────────────────

interface FixtureStep {
  toolCalls: Array<{ name: string; args?: Record<string, unknown>; raw?: string }>;
  /** 该步响应前的人为延迟（ms）：给 MCP 桥连接留确定性窗口（测试轮次本地即回，无真实 LLM 延迟）。 */
  delayMs?: number;
  /** 覆盖 finish_reason（默认 tool_calls）；length 用于制造截断调用触发 amagi 续传链。 */
  finishReason?: 'tool_calls' | 'length';
}

/** 历史感知步（可从 tool result 文本解析 amagi 续传 token）。 */
type FixtureStepEntry = FixtureStep | ((historyText: string) => FixtureStep | null);

class LiveModelServer {
  private server: http.Server | null = null;
  private seq = 0;
  private readonly entries: Array<{ marker: string; step: number; tools: string[]; messages: unknown[] }> = [];
  readonly configs: Array<{ marker: string; steps: FixtureStepEntry[]; final: string }> = [];

  get port(): number { return (this.server!.address() as { port: number }).port; }
  get baseUrl(): string { return `http://127.0.0.1:${this.port}`; }

  requestsFor(marker: string): Array<{ marker: string; step: number; tools: string[]; messages: unknown[] }> {
    return this.entries.filter((entry) => entry.marker === marker);
  }

  allHistoryText(marker: string): string {
    return this.requestsFor(marker)
      .flatMap((entry) => entry.messages as Array<Record<string, unknown>>)
      .map((message) => LiveModelServer.textOf(message))
      .join('\n');
  }

  private static textOf(message: Record<string, unknown>): string {
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((block) =>
      block && typeof block === 'object' && (block as { type?: string }).type === 'text'
        ? String((block as { text?: string }).text ?? '') : '').join('');
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => { this.server!.close(() => resolve()); });
    this.server = null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end('{}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: { messages?: Array<Record<string, unknown>>; tools?: unknown; stream?: boolean };
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); }
    catch { res.writeHead(400).end('{}'); return; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const cfg = this.configs.find((entry) => messages.some((message) => LiveModelServer.textOf(message).includes(entry.marker)));
    let priorSteps = 0;
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const match = LiveModelServer.textOf(message).match(/live-step:(\d+)/);
      if (match) priorSteps = Math.max(priorSteps, Number(match[1]));
    }
    const tools = Array.isArray(body.tools)
      ? body.tools.map((tool) => {
          const record = tool as { function?: { name?: string }; name?: string };
          return String(record.function?.name ?? record.name ?? '');
        }).filter(Boolean)
      : [];
    if (cfg) this.entries.push({ marker: cfg.marker, step: priorSteps + 1, tools, messages });
    const requestId = ++this.seq;
    const stepTag = `live-step:${priorSteps + 1}`;
    const historyText = messages.map((message) => LiveModelServer.textOf(message)).join('\n');
    const rawStep = cfg ? cfg.steps[priorSteps] : undefined;
    const step = typeof rawStep === 'function' ? rawStep(historyText) : rawStep;
    if (step?.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    if (step) {
      writeCompletion(res, body.stream === true, requestId, stepTag, {
        toolCalls: step.toolCalls.map((call, index) => ({
          id: `call_${requestId}_${index}`,
          function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.args ?? {}) },
        })),
        finishReason: step.finishReason,
      });
      return;
    }
    writeCompletion(res, body.stream === true, requestId, stepTag, { text: cfg?.final ?? 'DONE' });
  }
}

function writeCompletion(
  res: http.ServerResponse,
  stream: boolean,
  requestId: number,
  stepTag: string,
  payload: { text?: string; finishReason?: 'tool_calls' | 'length'; toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }> },
): void {
  const model = 'glm-5.3-flash';
  const finish = payload.finishReason ?? (payload.toolCalls && payload.toolCalls.length > 0 ? 'tool_calls' : 'stop');
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-${requestId}`, object: 'chat.completion', model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: `[${stepTag}]${payload.text ? ` ${payload.text}` : ''}`, tool_calls: payload.toolCalls },
        finish_reason: finish,
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
  const send = (data: unknown): void => { res.write(`data: ${JSON.stringify(data)}\n\n`); };
  send({ id: `chatcmpl-${requestId}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: `[${stepTag}]${payload.text ? ` ${payload.text}` : ''}` }, finish_reason: null }] });
  (payload.toolCalls ?? []).forEach((call, index) => {
    send({
      id: `chatcmpl-${requestId}`, object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: call.function }] }, finish_reason: null }],
    });
  });
  send({ id: `chatcmpl-${requestId}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

interface LiveEnv {
  workDir: string;
  homeDir: string;
  userHome: string;
  workFile: string;
  reportFile: string;
  /** fixture 桥的调用记录文件（tools/call 每次追加一行）。 */
  bridgeLog: string;
  model: LiveModelServer;
  dispose: () => Promise<void>;
}

async function prepareLiveEnv(mode: 'ctrl' | 'live'): Promise<LiveEnv> {
  const { installAmagiPackage } = await import('../src/agent/build-runtime/amagi-package.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'child-policy-live-')));
  tmpDirs.push(root);
  const dataRoot = path.join(root, 'feishu-home');
  const userHome = path.join(root, 'user-home');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  const amagiVersion = (JSON.parse(fs.readFileSync(path.join(SOURCE_AMAGI, 'package.json'), 'utf-8')) as { version: string }).version;
  const install = await installAmagiPackage({
    nodePath: process.execPath, piCliPath: PI_CLI, dataRoot, version: amagiVersion, sourceDir: SOURCE_AMAGI,
  });
  const model = new LiveModelServer();
  await model.start();
  const spec = makeSpec();
  spec.modelDescriptors = spec.modelDescriptors.map((descriptor) => ({ ...descriptor, baseUrl: model.baseUrl }));
  spec.workflowSkillPath = path.join(root, 'skill', 'kb-build', 'SKILL.md');
  fs.mkdirSync(path.dirname(spec.workflowSkillPath), { recursive: true });
  fs.writeFileSync(spec.workflowSkillPath, '---\nname: kb-build\ndescription: live child-policy 验证 skill。\n---\n\n# live\n');
  spec.amagiPackage = { version: install.version, installDir: install.installDir, packageRoot: install.packageRoot, contentHash: install.contentHash };
  const dirs = planBuildDirectories(dataRoot, spec.buildId);
  fs.mkdirSync(dirs.workDir, { recursive: true });
  // fixture MCP 桥（stdio JSON-RPC）：mcp.json 指向它；tools/call 追加记录到 bridgeLog（验证 MCP 通道未被 policy 过度阻断、直连 mcp__ 不可绕过）
  const bridgeLog = path.join(root, 'bridge-calls.log');
  const bridgeScript = path.join(root, 'fixture-bridge.cjs');
  fs.writeFileSync(bridgeScript, fixtureBridgeCjs(bridgeLog), { mode: 0o755 });
  const bridge = { bridgeCommand: process.execPath, bridgeArgs: [bridgeScript] };
  const rendered = renderAgentDirConfigFiles(spec, dirs, bridge);
  spec.agentDirConfigHash = computeAgentDirConfigHash(rendered);
  writeAgentDirConfig(spec, dirs, bridge);
  if (mode === 'ctrl') {
    // 对照组：还原到修复前形态（无 extensions 声明、无 policy 文件）
    const settings = JSON.parse(rendered.settings) as Record<string, unknown>;
    delete settings.extensions;
    fs.writeFileSync(path.join(dirs.homeDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
    fs.rmSync(path.join(dirs.homeDir, childPolicyFileName()));
  }
  const workFile = path.join(dirs.workDir, 'workfile.md');
  fs.writeFileSync(workFile, 'CHILD-POLICY-LIVE-WORKFILE\n');
  return {
    workDir: dirs.workDir,
    homeDir: dirs.homeDir,
    userHome,
    workFile,
    reportFile: path.join(dirs.workDir, 'agent-outputs', 'child-policy-live.md'),
    bridgeLog,
    model,
    dispose: async () => { await model.stop(); },
  };
}

async function runLiveChild(
  env: LiveEnv,
  script: { marker: string; steps: FixtureStepEntry[]; final: string },
): Promise<void> {
  env.model.configs.push(script);
  const tools = ['read', 'write', 'grep', 'find', 'ls', 'mcp_call', 'mcp_list_tools', 'amagi_resource', 'codemode', 'tool_search', 'toolcall_continue'];
  const args = [
    PI_CLI, '--mode', 'json', '-p', '--name', `child-policy-${script.marker.toLowerCase()}`,
    '--tools', tools.join(','),
    '--provider', 'zhipuai', '--model', 'glm-5.3-flash',
    '--', `${script.marker} 任务：按工具说明逐步执行，不要提问。`,
  ];
  const child = spawn(process.execPath, args, {
    cwd: env.workDir,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: env.userHome,
      PI_CODING_AGENT_DIR: env.homeDir,
      AMAGI_TASK_ID: `live-${script.marker.toLowerCase()}`,
      AMAGI_AGENT: 'luban',
      AMAGI_SUBAGENT: '1',
      ZHIPU_API_KEY: 'fixture-dummy-key',
      FEISHU_SYNC_BUILD_MCP_URL: 'http://127.0.0.1:9',
      FEISHU_SYNC_BUILD_MCP_TOKEN: 'fixture-dummy-token',
      TMPDIR: os.tmpdir(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(-9); }, 150_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c ?? -1); });
    child.on('error', () => { clearTimeout(timer); resolve(-1); });
  });
  if (code !== 0) {
    throw new Error(`live 子进程退出码 ${code}；stderr 尾部：${stderr.slice(-1200)}；stdout 尾部：${stdout.slice(-400)}`);
  }
}

/** fixture 桥：tools/call 把入参追加到 logPath（证据用），返回 echo 文本。 */
function fixtureBridgeCjs(logPath: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = ${JSON.stringify(logPath)};
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture-bridge', version: '0.0.1' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'kb_echo', description: 'fixture echo 工具（child-policy live 验证）', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (msg.method === 'tools/call') {
    const text = String(msg.params && msg.params.arguments && msg.params.arguments.text || '');
    try { fs.appendFileSync(path, 'CALL:' + text + '\\n'); } catch { /* 记录失败不影响应答 */ }
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + text }] } });
  } else if (msg.id !== undefined && msg.method !== 'notifications/initialized') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } });
  }
});
`;
}
