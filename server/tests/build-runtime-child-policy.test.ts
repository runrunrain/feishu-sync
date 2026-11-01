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

  it('禁用名单 = §3.3 codemode/tool_search + F12-R1 递归/目录工具 grep/find/ls，且完整出现在源码内', () => {
    expect(CHILD_POLICY_DISABLED_TOOLS).toEqual(['codemode', 'tool_search', 'grep', 'find', 'ls']);
    const src = renderChildPolicySource();
    for (const name of CHILD_POLICY_DISABLED_TOOLS) expect(src).toContain(`'${name}'`);
    // F12-R1 替代指引文案进入阻断理由（模型可消费的替代通道）
    expect(src).toContain('raw_search');
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
  let active = ['read', 'codemode', 'tool_search', 'grep', 'find', 'ls', 'write', 'toolcall_continue'];
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
    emit: async (event: string, ev: unknown): Promise<unknown> => {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) result = await handler(ev);
      return result;
    },
    setActive: (names: string[]) => { active = [...names]; },
    activeTools: () => [...active],
  };
}

describe('child-policy 扩展行为', () => {
  const hadTaskId = Object.prototype.hasOwnProperty.call(process.env, 'AMAGI_TASK_ID');
  const prevTaskId = process.env.AMAGI_TASK_ID;
  const hadRoots = Object.prototype.hasOwnProperty.call(process.env, 'PI_BUILD_CHILD_ROOTS_JSON');
  const prevRoots = process.env.PI_BUILD_CHILD_ROOTS_JSON;
  const hadCwd = Object.prototype.hasOwnProperty.call(process.env, 'AMAGI_PERMISSION_CWD');
  const prevCwd = process.env.AMAGI_PERMISSION_CWD;
  afterAll(() => {
    if (hadTaskId) process.env.AMAGI_TASK_ID = prevTaskId;
    else delete process.env.AMAGI_TASK_ID;
    if (hadRoots) process.env.PI_BUILD_CHILD_ROOTS_JSON = prevRoots;
    else delete process.env.PI_BUILD_CHILD_ROOTS_JSON;
    if (hadCwd) process.env.AMAGI_PERMISSION_CWD = prevCwd;
    else delete process.env.AMAGI_PERMISSION_CWD;
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
    await fake.emit('session_start', undefined);
    expect(fake.activeTools()).toEqual(['read', 'write', 'toolcall_continue']);
    // 运行中被重新激活（模拟宿主注册表重建/长度截断恢复对 --tools 点名工具的重激活，
    // 含 F12-R1 新增的 grep/find/ls——amagi deriveTools 从 read 派生 grep/find，
    // 重激活面同样会出现），每个锚点都能独立把面清回来
    const hostile = ['read', 'codemode', 'tool_search', 'grep', 'find', 'ls', 'write'];
    for (const anchor of ['before_agent_start', 'turn_start', 'turn_end', 'agent_end', 'tool_result'] as const) {
      fake.setActive([...hostile]);
      await fake.emit(anchor, {});
      expect(fake.activeTools(), anchor).toEqual(['read', 'write']);
    }
    // 角色限定的锚点：assistant 消息终结与系统面补了
    fake.setActive([...hostile]);
    await fake.emit('message_end', { message: { role: 'assistant' } });
    expect(fake.activeTools()).toEqual(['read', 'write']);
    fake.setActive([...hostile]);
    await fake.emit('message_start', { message: { role: 'system', toolsAdded: [{ name: 'grep' }] } });
    expect(fake.activeTools()).toEqual(['read', 'write']);
    // 非目标角色不触发（避免无谓重算；链式事件返回 undefined 透传）
    fake.setActive(['read', 'codemode', 'write']);
    expect(await fake.emit('message_end', { message: { role: 'toolResult' } })).toBeUndefined();
    expect(fake.activeTools()).toEqual(['read', 'codemode', 'write']);
    expect(await fake.emit('message_start', { message: { role: 'assistant' } })).toBeUndefined();
    expect(fake.activeTools()).toEqual(['read', 'codemode', 'write']);
  });

  it('tool_call：禁用名一律 block（含重激活后），其余透传 undefined', async () => {
    process.env.AMAGI_TASK_ID = 'unit-task-2';
    const mod = await loadPolicyModule();
    const fake = makeFakePi();
    mod.default(fake.pi);
    for (const name of CHILD_POLICY_DISABLED_TOOLS) {
      const decision = await fake.emit('tool_call', { toolName: name, input: {} });
      expect(decision).toMatchObject({ block: true });
      expect(String((decision as { reason: string }).reason)).toContain('child-policy');
    }
    // read 无路径参数（防御拒）与 toolcall_continue 透传；后续根约束用例覆盖正例
    expect(await fake.emit('tool_call', { toolName: 'toolcall_continue', input: {} })).toBeUndefined();
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
    const decision = await handlers.tool_call![0]!({ toolName: 'codemode', input: {} });
    expect(decision).toMatchObject({ block: true });
  });

  // F12-R1 二段：read/write/edit 冻结信封根复核（缺元数据 fail-closed；词法/落点双判）
  it('根约束：白名单根双形态归一——词法根在 symlink 前缀下（macOS /var→/private/var）正例不误拒', async () => {
    process.env.AMAGI_TASK_ID = 'unit-roots-symprefix';
    // 用 os.tmpdir() 原始形态（mac 上 /var/folders/...，realpath 为 /private/var/...）
    const rawTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-symprefix-'));
    tmpDirs.push(rawTmp);
    const skillDir = path.join(rawTmp, 'skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'skill-symprefix');
    process.env.PI_BUILD_CHILD_ROOTS_JSON = JSON.stringify({ readRoots: [skillDir], writeRoots: [path.join(rawTmp, 'agent-outputs')] });
    delete process.env.AMAGI_PERMISSION_CWD;
    const mod = await loadPolicyModule();
    const fake = makeFakePi();
    mod.default(fake.pi);
    const decision = await fake.emit('tool_call', { toolName: 'read', input: { path: path.join(skillDir, 'SKILL.md') } });
    expect(decision, '词法根未经 realpath 时正例被误拒（symlink 前缀回归）').toBeUndefined();
  });

  it('报告根尚未创建且工作区有symlink前缀时，首次报告写入仍在受控真实落点内', async () => {
    process.env.AMAGI_TASK_ID = 'unit-new-report-root';
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-new-report-')));
    tmpDirs.push(root);
    const actualWork = path.join(root, 'actual-work');
    const workAlias = path.join(root, 'work-alias');
    fs.mkdirSync(actualWork);
    fs.symlinkSync(actualWork, workAlias, 'dir');
    const reportRoot = path.join(workAlias, 'agent-outputs');
    process.env.PI_BUILD_CHILD_ROOTS_JSON = JSON.stringify({ readRoots: [workAlias], writeRoots: [reportRoot] });
    process.env.AMAGI_PERMISSION_CWD = workAlias;
    const mod = await loadPolicyModule();
    const fake = makeFakePi();
    mod.default(fake.pi);
    expect(fs.existsSync(reportRoot)).toBe(false);
    expect(await fake.emit('tool_call', {
      toolName: 'write', input: { path: path.join(reportRoot, 'nested', 'report.md'), content: 'report' },
    })).toBeUndefined();
  });

  it('拒绝SDK会重新解释的路径别名及不存在的read目标，防校验目标与实际读取目标不同', async () => {
    process.env.AMAGI_TASK_ID = 'unit-sdk-path-interpretation';
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-sdk-path-')));
    tmpDirs.push(root);
    const work = path.join(root, 'work');
    const outside = path.join(root, 'outside.md');
    fs.mkdirSync(work);
    fs.writeFileSync(outside, 'SYNTHETIC-OUTSIDE');
    process.env.AMAGI_PERMISSION_CWD = work;
    process.env.PI_BUILD_CHILD_ROOTS_JSON = JSON.stringify({ readRoots: [work], writeRoots: [path.join(work, 'agent-outputs')] });
    const mod = await loadPolicyModule();
    const fake = makeFakePi();
    mod.default(fake.pi);
    for (const target of [`@${outside}`, pathToFileURL(outside).href, path.join(work, 'missing.md')]) {
      expect(await fake.emit('tool_call', { toolName: 'read', input: { path: target } }), target).toMatchObject({ block: true });
    }
  });

  it('落点解析（Leader 边界①）：write 经父目录 symlink 新建到外部被拒且外部未产生；dangling leaf/parent fail-closed；edit 经 symlink 不改外部文件；正常报告嵌套新建放行', async () => {
    process.env.AMAGI_TASK_ID = 'unit-landing-1';
    const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-landing-')));
    tmpDirs.push(workDir);
    const reportRoot = path.join(workDir, 'agent-outputs');
    fs.mkdirSync(reportRoot, { recursive: true });
    const outsideRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-landing-out-')));
    tmpDirs.push(outsideRoot);
    // 外部已有目标（edit 反例）与外部目录（write 经父 symlink 新建反例）
    const outsideExisting = path.join(outsideRoot, 'edit-target.md');
    fs.writeFileSync(outsideExisting, 'ORIGINAL-CONTENT');
    fs.symlinkSync(outsideRoot, path.join(reportRoot, 'symdir-to-outside'), 'dir');
    fs.symlinkSync(outsideExisting, path.join(reportRoot, 'link-to-outside-file'));
    // dangling：指向外部不存在文件/目录的叶子与父链
    fs.symlinkSync(path.join(outsideRoot, 'never-exists.md'), path.join(reportRoot, 'dangling-leaf'));
    fs.symlinkSync(path.join(outsideRoot, 'never-dir'), path.join(reportRoot, 'dangling-parent'), 'dir');
    process.env.PI_BUILD_CHILD_ROOTS_JSON = JSON.stringify({ readRoots: [workDir], writeRoots: [reportRoot] });
    process.env.AMAGI_PERMISSION_CWD = workDir;
    const mod = await loadPolicyModule();
    const fake = makeFakePi();
    mod.default(fake.pi);
    const decisionOf = async (tool: string, args: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined> =>
      (await fake.emit('tool_call', { toolName: tool, input: args })) as { block?: boolean; reason?: string } | undefined;
    // write 经父 symlink 新建（目标不存在，realpath(目标) ENOENT——必须按最近既存祖先落点判拒）
    const viaSym = await decisionOf('write', { path: path.join(reportRoot, 'symdir-to-outside', 'new.md'), content: 'x' });
    expect(viaSym).toMatchObject({ block: true });
    expect(fs.existsSync(path.join(outsideRoot, 'new.md'))).toBe(false); // 外部未产生
    // write dangling leaf（底层 write 会跟随 dangling symlink 在外部创建——既存但无法解析 → fail-closed）
    const danglingLeaf = await decisionOf('write', { path: path.join(reportRoot, 'dangling-leaf'), content: 'x' });
    expect(danglingLeaf).toMatchObject({ block: true });
    expect(String(danglingLeaf?.reason)).toContain('fail-closed');
    expect(fs.existsSync(path.join(outsideRoot, 'never-exists.md'))).toBe(false);
    // write dangling parent（父链 dangling → 新建目标落点不可证 → fail-closed）
    const danglingParent = await decisionOf('write', { path: path.join(reportRoot, 'dangling-parent', 'new.md'), content: 'x' });
    expect(danglingParent).toMatchObject({ block: true });
    expect(fs.existsSync(path.join(outsideRoot, 'never-dir'))).toBe(false);
    // edit 经 symlink 指向外部已有文件（词法在报告根内）→ 拒且外部文件未改
    const editViaLink = await decisionOf('edit', { path: path.join(reportRoot, 'link-to-outside-file'), oldText: 'ORIGINAL', newText: 'PWNED' });
    expect(editViaLink).toMatchObject({ block: true });
    expect(fs.readFileSync(outsideExisting, 'utf-8')).toBe('ORIGINAL-CONTENT');
    // 正例：报告根内嵌套新目录首次 write（父目录不存在——最近既存=报告根，落点可证 → 放行）
    const nested = await decisionOf('write', { path: path.join(reportRoot, 'new-sub', 'deep', 'report.md'), content: 'ok' });
    expect(nested).toBeUndefined();
    // read 经父 symlink 到外部仍拒（落点判）
    const readViaSym = await decisionOf('read', { path: path.join(reportRoot, 'symdir-to-outside', 'edit-target.md') });
    expect(readViaSym).toMatchObject({ block: true });
  });

  it('落点解析：报告根内已存在正常文件 read/edit 放行（不因落点解析误伤正例）', async () => {
    process.env.AMAGI_TASK_ID = 'unit-landing-2';
    const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-landing2-')));
    tmpDirs.push(workDir);
    const reportRoot = path.join(workDir, 'agent-outputs');
    fs.mkdirSync(reportRoot, { recursive: true });
    fs.writeFileSync(path.join(reportRoot, 'report.md'), 'REPORT-BODY');
    process.env.PI_BUILD_CHILD_ROOTS_JSON = JSON.stringify({ readRoots: [workDir], writeRoots: [reportRoot] });
    delete process.env.AMAGI_PERMISSION_CWD;
    const mod = await loadPolicyModule();
    const fake = makeFakePi();
    mod.default(fake.pi);
    expect(await fake.emit('tool_call', { toolName: 'read', input: { path: path.join(reportRoot, 'report.md') } })).toBeUndefined();
    expect(await fake.emit('tool_call', { toolName: 'edit', input: { path: path.join(reportRoot, 'report.md'), oldText: 'a', newText: 'b' } })).toBeUndefined();
  });

  it('win32 词法（Leader 边界②）：盘符/UNC/相对/父级逃逸按 node:path win32 语义判定，不因 POSIX 手写必败', async () => {
    process.env.AMAGI_TASK_ID = 'unit-win32-1';
    process.env.PI_BUILD_CHILD_PATH_FLAVOR = 'win32';
    process.env.AMAGI_PERMISSION_CWD = 'C:\\build\\work';
    process.env.PI_BUILD_CHILD_ROOTS_JSON = JSON.stringify({
      readRoots: ['C:\\build\\work', 'C:\\build\\skill', '\\\\srv\\share\\skill'],
      writeRoots: ['C:\\build\\work\\agent-outputs'],
    });
    try {
      const mod = await loadPolicyModule();
      const fake = makeFakePi();
      mod.default(fake.pi);
      const decisionOf = async (tool: string, args: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined> =>
        (await fake.emit('tool_call', { toolName: tool, input: args })) as { block?: boolean; reason?: string } | undefined;
      // 反例（词法层必拒）：跨盘符 / 白名单外盘符路径 / UNC 外部 / 相对父级逃逸 / 绝对父级逃逸
      for (const [tool, target] of [
        ['read', 'D:\\secret\\token.env'],
        ['read', 'C:\\Windows\\system32\\drivers\\etc\\hosts'],
        ['read', '\\\\evil\\share\\secret.md'],
        ['read', '..\\..\\..\\secret.md'],
        ['read', 'C:\\build\\work\\..\\..\\secret.md'],
        ['write', 'C:\\build\\work\\amagi.json'],
        ['write', 'C:\\build\\work\\agent-outputs\\NUL.txt'],
        ['write', 'C:\\build\\work\\agent-outputs\\report.md:stream'],
        ['write', 'C:\\build\\work\\agent-outputs\\new\\.. \\.. \\escape.md'],
        ['write', '\\\\srv\\share\\skill\\x.md'],
      ] as const) {
        const decision = await decisionOf(tool, { path: target });
        expect(decision, `${tool} ${target} 应被词法层拒绝`).toMatchObject({ block: true });
        expect(String(decision?.reason)).not.toContain('落点无法解析'); // 拒在词法层，非落点层
      }
      // 「词法放行」断言口径：允许 undefined（真实 Windows 会放行）或在非 Windows 宿主上
      // 进入落点解析层（fail-closed 拒，理由含「落点」字样）——唯独不得是词法层的裸
      // ROOT_REASON（词法层拒绝没有落点后缀正文）。
      const lexicalPass = (decision: { block?: boolean; reason?: string } | undefined): boolean =>
        decision === undefined || /落点/.test(String(decision?.reason ?? ''));
      // UNC 白名单内（同 share 前缀）：词法放行
      const uncInside = await decisionOf('read', { path: '\\\\srv\\share\\skill\\\\SKILL.md' });
      expect(lexicalPass(uncInside), `UNC 白名单内被词法拒：${String(uncInside?.reason).slice(0, 60)}`).toBe(true);
      // UNC 同 host 不同 share = 父级逃逸（win32 relative 产生 .. 前缀）
      const uncSibling = await decisionOf('read', { path: '\\\\srv\\share2\\\\x.md' });
      expect(uncSibling).toMatchObject({ block: true });
      // 盘符白名单内正例（含 '..' 字面的合法目录名不误伤）：词法放行
      const dotName = await decisionOf('read', { path: 'a..b\\\\c.md' });
      expect(lexicalPass(dotName), `合法目录名 a..b 被词法拒：${String(dotName?.reason).slice(0, 60)}`).toBe(true);
      // write 盘符报告根内正例：词法放行
      const writeInside = await decisionOf('write', { path: 'C:\\\\build\\\\work\\\\agent-outputs\\\\r.md' });
      expect(lexicalPass(writeInside), `write 盘符报告根被词法拒：${String(writeInside?.reason).slice(0, 60)}`).toBe(true);
    } finally {
      delete process.env.PI_BUILD_CHILD_PATH_FLAVOR;
    }
  });

  it('根约束：缺 PI_BUILD_CHILD_ROOTS_JSON → read/write/edit 全部 fail-closed 阻断', async () => {
    process.env.AMAGI_TASK_ID = 'unit-roots-0';
    delete process.env.PI_BUILD_CHILD_ROOTS_JSON;
    const mod = await loadPolicyModule();
    const fake = makeFakePi();
    mod.default(fake.pi);
    for (const tool of ['read', 'write', 'edit']) {
      const decision = await fake.emit('tool_call', { toolName: tool, input: { path: '/any/where.md' } });
      expect(decision).toMatchObject({ block: true });
      expect(String((decision as { reason: string }).reason)).toContain('fail-closed');
    }
  });

  it('根约束：read=skill/工作区白名单、write/edit=仅报告根；绝对/相对/symlink/缺参反例全拒', async () => {
    process.env.AMAGI_TASK_ID = 'unit-roots-1';
    const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-roots-')));
    tmpDirs.push(workDir);
    const reportRoot = path.join(workDir, 'agent-outputs');
    const skillDir = path.join(workDir, 'skill');
    fs.mkdirSync(reportRoot, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'skill-body');
    fs.writeFileSync(path.join(skillDir, 'protocol.md'), 'protocol-body');
    fs.writeFileSync(path.join(workDir, 'task-brief.md'), 'task brief');
    fs.writeFileSync(path.join(reportRoot, 'report.md'), 'existing report');
    const outsideRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-outside-')));
    tmpDirs.push(outsideRoot);
    const outsideSecret = path.join(outsideRoot, 'secret-outside.md');
    fs.writeFileSync(outsideSecret, 'SYNTHETIC-OUTSIDE-SECRET（不在任何白名单）');
    const alias = path.join(workDir, 'alias-to-outside');
    fs.symlinkSync(outsideRoot, alias, 'dir');
    process.env.PI_BUILD_CHILD_ROOTS_JSON = JSON.stringify({
      readRoots: [skillDir, workDir],
      writeRoots: [reportRoot],
    });
    process.env.AMAGI_PERMISSION_CWD = workDir;
    const mod = await loadPolicyModule();
    const fake = makeFakePi();
    mod.default(fake.pi);
    const blocked = async (tool: string, args: Record<string, unknown>): Promise<void> => {
      const decision = await fake.emit('tool_call', { toolName: tool, input: args });
      expect(decision, `${tool} ${String(args.path ?? '(无路径)')} 应被拒`).toMatchObject({ block: true });
    };
    const allowed = async (tool: string, args: Record<string, unknown>): Promise<void> => {
      const decision = await fake.emit('tool_call', { toolName: tool, input: args });
      expect(decision, `${tool} ${String(args.path ?? '')} 不应被拒`).toBeUndefined();
    };
    // 正例：read skill 同目录协议 / 工作区文件；write/edit 报告根
    await allowed('read', { path: path.join(skillDir, 'SKILL.md') });
    await allowed('read', { path: path.join(skillDir, 'protocol.md') });
    await allowed('read', { path: path.join(workDir, 'task-brief.md') });
    await allowed('read', { path: path.join(reportRoot, 'report.md') });
    await allowed('write', { path: path.join(reportRoot, 'report.md') });
    await allowed('edit', { path: path.join(reportRoot, 'report.md') });
    // 反例：白名单外绝对路径（黑名单不枚举的任意系统路径同样拒）
    await blocked('read', { path: outsideSecret });
    await blocked('write', { path: outsideSecret });
    // 反例：相对路径穿越到白名单外
    await blocked('read', { path: path.relative(workDir, outsideSecret) });
    await blocked('write', { path: path.relative(workDir, outsideRoot) + '/escape.md' });
    // 反例：symlink 别名词法在内、落点在外（真实落点双判）
    await blocked('read', { path: alias + '/secret-outside.md' });
    await blocked('write', { path: path.relative(workDir, alias) + '/escape.md' });
    // 反例：write/edit 越报告根（工作区内非报告路径、配置面）
    await blocked('write', { path: path.join(workDir, 'amagi.json') });
    await blocked('edit', { path: path.join(workDir, 'notes.md') });
    // 反例：~ 展开到 HOME（不在白名单）
    await blocked('read', { path: '~/.ssh/config-is-synthetic.md' });
    // 反例：缺路径参数
    await blocked('read', {});
    await blocked('write', {});
    // 禁用名不受根元数据影响（仍拒）
    const grepDecision = await fake.emit('tool_call', { toolName: 'grep', input: { pattern: 'x', path: workDir } });
    expect(grepDecision).toMatchObject({ block: true });
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
    '对照组：无 policy 时 amagi 交付面把 codemode/grep 送进模型工具面且可执行（复现缺口）',
    { timeout: 180_000 },
    async () => {
      const env = await prepareLiveEnv('ctrl');
      try {
        await runLiveChild(env, {
          marker: 'CHILD-POLICY-CTRL',
          steps: [
            { toolCalls: [{ name: 'codemode', args: { code: "return 'CTRL-CODEMODE-EXECUTED';" } }] },
            // F12-R1 缺口形状：无 policy 时祖先目录递归 grep 可执行（live 环境无 amagi deny，
            // grep 会真实递归并读出 sentinel 正文）
            { toolCalls: [{ name: 'grep', args: { pattern: 'SENTINEL-SECRET-live', path: env.ancestorDir } }] },
          ],
          final: 'CTRL-DONE',
        });
        const entries = env.model.requestsFor('CHILD-POLICY-CTRL');
        expect(entries.length).toBeGreaterThanOrEqual(1);
        expect(entries[0].tools).toContain('codemode'); // 缺口复现：无 policy 时 codemode 在模型面内
        expect(entries[0].tools).toContain('grep'); // F12-R1 缺口复现：grep 在模型面内
        expect(env.model.allHistoryText('CHILD-POLICY-CTRL')).toContain('CTRL-CODEMODE-EXECUTED'); // 真实执行未被阻断
        expect(env.model.allHistoryText('CHILD-POLICY-CTRL')).toContain('SENTINEL-SECRET-live'); // 祖先递归真实读出 sentinel 正文
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
        const outsideFile = path.join(env.rawRoot, '..', '..', 'outside', 'synthetic-secret.md');
        await runLiveChild(env, {
          marker: 'CHILD-POLICY-LIVE',
          steps: [
            { delayMs: 900, toolCalls: [{ name: 'read', args: { path: env.workFile } }] },
            { toolCalls: [{ name: 'read', args: { path: `${env.skillDir}/SKILL.md` } }] },
            // F12-R1 二段：read 根约束反例（白名单外绝对路径 / 相对路径穿越 / symlink 别名落点）
            { toolCalls: [{ name: 'read', args: { path: outsideFile } }] },
            // SDK会重解释@/file URL；必须在执行前拒绝，不能只验证字面路径。
            { toolCalls: [{ name: 'read', args: { path: `@${outsideFile}` } }] },
            { toolCalls: [{ name: 'read', args: { path: pathToFileURL(outsideFile).href } }] },
            { toolCalls: [{ name: 'read', args: { path: `${env.workDir}/not-created.md` } }] },
            { toolCalls: [{ name: 'read', args: { path: path.relative(env.workDir, outsideFile) } }] },
            { toolCalls: [{ name: 'read', args: { path: 'alias-to-ancestor/raw/sentinel/secret-token.md' } }] },
            // write 越报告根拒 + 报告根正例
            { toolCalls: [{ name: 'write', args: { path: `${env.workDir}/config-face.md`, content: 'x' } }] },
            // Leader 边界①：write 经父 symlink 新建到外部 / dangling leaf / edit 经 symlink 不改外部
            { toolCalls: [{ name: 'write', args: { path: `${env.workDir}/agent-outputs/symdir-to-outside/new.md`, content: 'x' } }] },
            { toolCalls: [{ name: 'write', args: { path: `${env.workDir}/agent-outputs/dangling-leaf`, content: 'x' } }] },
            { toolCalls: [{ name: 'edit', args: { path: `${env.workDir}/agent-outputs/symdir-to-outside/edit-target.md`, oldText: 'ORIGINAL', newText: 'PWNED' } }] },
            // 正例：报告根嵌套新目录首次 write（最近既存祖先=报告根，落点可证）
            { toolCalls: [{ name: 'write', args: { path: `${env.workDir}/agent-outputs/nested/sub/first.md`, content: 'NESTED-REPORT-OK' } }] },
            { toolCalls: [{ name: 'codemode', args: { code: "return 'pwned';" } }] },
            { toolCalls: [{ name: 'tool_search', args: { query: 'bash' } }] },
            // F12-R1：递归/目录工具强制调用（祖先目录/禁区根/别名形态一律到不了执行层）
            { toolCalls: [{ name: 'grep', args: { pattern: 'SENTINEL-SECRET-live', path: env.ancestorDir } }] },
            { toolCalls: [{ name: 'find', args: { pattern: 'secret-*', path: env.ancestorDir } }] },
            { toolCalls: [{ name: 'ls', args: { path: env.ancestorDir } }] },
            { toolCalls: [{ name: 'write', args: { path: env.reportFile, content: 'CHILD-POLICY-LIVE-REPORT' } }] },
            { toolCalls: [{ name: 'mcp_list_tools', args: { server: 'feishu-kb-bridge' } }] },
          ],
          final: 'LIVE-DONE',
        });
        const entries = env.model.requestsFor('CHILD-POLICY-LIVE');
        expect(entries.length).toBeGreaterThanOrEqual(20); // 含SDK路径别名反例的多轮证据
        for (const entry of entries) {
          for (const banned of CHILD_POLICY_DISABLED_TOOLS) {
            expect(entry.tools, `step${entry.step} 工具面含禁用名 ${banned}`).not.toContain(banned);
          }
        }
        const face = entries[0].tools;
        for (const required of ['read', 'write', 'mcp_call', 'mcp_list_tools', 'amagi_resource', 'toolcall_continue']) {
          expect(face, `首面缺 ${required}（受支持 amagi-pi 2.21.31 应注册 length-continuation）`).toContain(required);
        }
        // 断言基线：正式验证环境 = 受支持冻结 amagi-pi 2.21.31（capabilityEnabledByVersion
        // 放行 lengthContinuation，toolcall_continue 在面）。此前在演进中的 2.21.32 工作树
        // 观测到未注册，仅作兼容探索记录，不据此降低必需断言。
        const allText = env.model.allHistoryText('CHILD-POLICY-LIVE');
        expect(allText).toContain('child-policy'); // 强制调用被 policy 阻断（理由进入工具结果）
        // F12-R1 零后端内容：祖先目录递归 grep/find/ls 全部到不了执行层，
        // sentinel 正文不得出现在任何消息（含工具结果/错误文本）
        expect(allText).not.toContain('SENTINEL-SECRET-live');
        // F12-R1 二段：read 根约束——outside 合成文件（绝对/相对/symlink 别名）零内容返回；
        // write 越报告根被拒且目标未落盘
        expect(allText).not.toContain('SYNTHETIC-OUTSIDE-LIVE');
        expect(fs.existsSync(`${env.workDir}/config-face.md`)).toBe(false);
        // Leader 边界①：write 经父 symlink 新建/dangling leaf 均被拒——外部未产生任何新文件，
        // edit 经 symlink 未改外部既有文件；报告根嵌套新建正例真实落盘
        expect(fs.readdirSync(env.outsideDir).sort()).toEqual(['edit-target.md', 'synthetic-secret.md']);
        expect(fs.readFileSync(path.join(env.outsideDir, 'edit-target.md'), 'utf-8')).toBe('ORIGINAL-CONTENT');
        expect(fs.readFileSync(`${env.workDir}/agent-outputs/nested/sub/first.md`, 'utf-8')).toBe('NESTED-REPORT-OK');
        expect(allText).toContain('CHILD-POLICY-LIVE-WORKFILE'); // read 工作区正例
        expect(allText).toContain('live child-policy 验证 skill'); // read skill 正文正例（同目录协议可读）
        expect(allText).toContain('kb_echo'); // MCP 通道未受影响
        expect(fs.readFileSync(env.reportFile, 'utf-8')).toContain('CHILD-POLICY-LIVE-REPORT'); // 报告写正例
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
  /** F12-R1：包含敏感 sentinel 的原始库根（live 环境无 amagi grant，deny 不执法；仅递归面反例目标）。 */
  rawRoot: string;
  /** F12-R1：raw 禁区的祖先目录（不在任何 deny 内——递归泄漏反例的搜索根）。 */
  ancestorDir: string;
  /** F12-R1 二段：冻结 skill 目录（read 白名单正例目标）。 */
  skillDir: string;
  /** Leader 边界①：合成外部目录（write/edit 落点反例目标与未产生/未改断言基准）。 */
  outsideDir: string;
  /** F12-R1 二段：注入子进程的冻结信封根元数据（与生产 buildLeaderEnv 同构）。 */
  rootsJson: string;
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
  // F12-R1 反例目标：raw 禁区（含 sentinel）+ 其祖先目录（搜索根不落 deny 的递归泄漏形态）
  const rawRoot = path.join(root, 'fixtures', 'raw');
  const ancestorDir = path.join(root, 'fixtures');
  fs.mkdirSync(path.join(rawRoot, 'sentinel'), { recursive: true });
  fs.writeFileSync(path.join(rawRoot, 'sentinel', 'secret-token.md'), '# 内部凭据\n\nSENTINEL-SECRET-live：不允许出现在子任务输出。\n');
  // F12-R1 二段：read 根约束目标（skill 白名单正例 + outside 反例 + symlink 别名）
  const skillDir = path.dirname(spec.workflowSkillPath);
  const outsideFile = path.join(root, 'outside', 'synthetic-secret.md');
  fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
  fs.writeFileSync(outsideFile, 'SYNTHETIC-OUTSIDE-LIVE：合成反例（不读真凭据）。\n');
  fs.symlinkSync(ancestorDir, path.join(dirs.workDir, 'alias-to-ancestor'), 'dir');
  // Leader 边界①：报告根内 symlink 目录→外部 + dangling leaf/parent（write 新建落点反例）
  const reportRoot = path.join(dirs.workDir, 'agent-outputs');
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.symlinkSync(path.dirname(outsideFile), path.join(reportRoot, 'symdir-to-outside'), 'dir');
  fs.symlinkSync(path.join(path.dirname(outsideFile), 'never-exists.md'), path.join(reportRoot, 'dangling-leaf'));
  fs.writeFileSync(path.join(path.dirname(outsideFile), 'edit-target.md'), 'ORIGINAL-CONTENT');
  const rootsJson = JSON.stringify({
    readRoots: [skillDir, dirs.workDir],
    writeRoots: [path.join(dirs.workDir, 'agent-outputs')],
  });
  return {
    workDir: dirs.workDir,
    homeDir: dirs.homeDir,
    userHome,
    workFile,
    reportFile: path.join(dirs.workDir, 'agent-outputs', 'child-policy-live.md'),
    bridgeLog,
    rawRoot,
    ancestorDir,
    skillDir,
    outsideDir: path.dirname(outsideFile),
    rootsJson,
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
      AMAGI_PERMISSION_CWD: env.workDir,
      PI_BUILD_CHILD_ROOTS_JSON: env.rootsJson,
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
