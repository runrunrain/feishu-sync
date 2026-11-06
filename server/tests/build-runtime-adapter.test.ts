/**
 * PiAmagiBuildRuntime adapter 集成测试（设计v2 §8/§9；Leader 调整 #9 A17/A18/A24）
 *
 * 用假 pi CLI fixture（同 build-runtime-pi-rpc-process.test.ts）+ source 模式安装的
 * 迷你 amagi-pi fixture 包，真实走 start/cancel/resume 链路：
 * - start 绑定真实 leaderPid；
 * - cancel 后 exitInfo + 残留如实核对（isProcessAlive 钩子）；
 * - 应用重启（新 adapter 实例、内存 Map 为空）后 resume 按 binding 自描述重建；
 *   旧 Leader pid 存活 → 拒绝双 Leader；死后 → 原会话续接成功；
 * - spec 哈希与落盘不一致 → start 明确拒绝。
 */

import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installAmagiPackage } from '../src/agent/build-runtime/amagi-package.js';
import { appendProcessLedgerEntry, readProcessLedger } from '../src/agent/build-runtime/process-ledger.js';
import { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import { readBirthIdentities } from '../src/agent/build-runtime/process-identity.js';
import {
  computeAgentDirConfigHash, planBuildDirectories, renderAgentDirConfigFiles, writeAgentDirConfig,
} from '../src/agent/build-runtime/agent-dir-config.js';
import { PiAmagiBuildRuntime, type PiAmagiRuntimeDeps } from '../src/agent/build-runtime/adapter.js';
import type { BuildRunSpec } from '../src/agent/build-runtime/contracts.js';
import { makeSpec } from './build-runtime-contracts.test.js';

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-adapter-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function makeFakePi(root: string): string {
  const file = path.join(root, 'fake-pi.mjs');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = await import('node:fs');
const path = await import('node:path');
const readline = await import('node:readline');
if (process.argv[2] === 'install') {
  fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ packages: [process.argv[3]] }));
  process.exit(0);
}
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'guard-env.json'), JSON.stringify({
  spec: process.env.FEISHU_SYNC_AGENT_BUILD_SPEC_JSON,
  module: process.env.FEISHU_SYNC_BUILD_GUARD_MODULE,
  argv: process.argv.slice(2),
}));
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
send({ type: 'state', hint: 'fake-ready' });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let cmd; try { cmd = JSON.parse(line); } catch { return; }
  send({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: {} });
});
rl.on('close', () => process.exit(0));
`, { mode: 0o755 });
  return file;
}

/** 迷你 amagi-pi fixture 包（source 模式安装用；不是真实 amagi-pi，测的是本模块链路）。 */
function makeMiniAmagiSource(root: string): string {
  const src = path.join(root, 'amagi-src');
  fs.mkdirSync(path.join(src, 'extensions', 'amagi-core'), { recursive: true });
  fs.mkdirSync(path.join(src, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'amagi-pi', version: '2.21.31', pi: { extensions: ['./extensions'] } }, null, 2));
  fs.writeFileSync(path.join(src, 'extensions', 'amagi-core', 'index.ts'), '// mini\n');
  for (const a of ['luban', 'diting', 'baize']) fs.writeFileSync(path.join(src, 'agents', `${a}.md`), 'x\n');
  return src;
}

it('Leader在跨入spawn前持久化意图；PID登记前断流不能被当无旧事实', async () => {
  const root = tmpRoot();
  const { spec, deps } = await prepare(root);
  const buildRoot = planBuildDirectories(root, spec.buildId, 1).buildRoot;
  const spy = vi.spyOn(PiRpcProcess.prototype, 'start').mockImplementationOnce(async () => {
    expect(readProcessLedger(buildRoot).entries).toEqual([
      expect.objectContaining({ pid: 0, launchState: 'intent', kind: 'leader' }),
    ]);
    throw new Error('INJECTED_SPAWN_GAP'); // 故障夹具，不宣称真实硬崩测试
  });
  try {
    await expect(new PiAmagiBuildRuntime(deps).start(spec)).rejects.toThrow('INJECTED_SPAWN_GAP');
  } finally { spy.mockRestore(); }
  const restarted = new PiAmagiBuildRuntime(deps);
  const result = await restarted.reconcileBuildResiduals({ buildId: spec.buildId, binding: null });
  expect(result?.state).toBe('unconfirmed');
  expect(result?.note).toContain('启动意图');
});

function pidAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function prepare(root: string): Promise<{
  spec: BuildRunSpec;
  deps: PiAmagiRuntimeDeps;
  revoked: { count: number };
}> {
  const fakePi = makeFakePi(root);
  const installed = await installAmagiPackage({
    nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '2.21.31',
    sourceDir: makeMiniAmagiSource(root),
  });
  const skillPath = path.join(root, 'workflow', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, '# skill\n');
  const spec = makeSpec();
  spec.workflowSkillPath = skillPath;
  spec.workflowRevision = createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex');
  spec.amagiPackage = {
    version: installed.version, installDir: installed.installDir,
    packageRoot: installed.packageRoot, contentHash: installed.contentHash,
  };
  const dirs = planBuildDirectories(root, spec.buildId);
  const bridge = { bridgeCommand: process.execPath, bridgeArgs: [path.join(root, 'bridge.cjs')] };
  fs.writeFileSync(bridge.bridgeArgs[0], '// placeholder\n');
  spec.agentDirConfigHash = computeAgentDirConfigHash(renderAgentDirConfigFiles(spec, dirs, bridge));
  const revoked = { count: 0 };
  const deps: PiAmagiRuntimeDeps = {
    nodePath: process.execPath,
    piCliPath: fakePi,
    dataRoot: root,
    knowledgeBaseRoot: path.join(root, 'raw'),
    outputRoot: path.join(root, 'std'),
    forwardingExtensionPath: path.join(root, 'forward.js'),
    bridgeScriptPath: bridge.bridgeArgs[0],
    agentUrl: 'http://127.0.0.1:39999',
    resolveModelApiKey: () => 'k',
    issueLeaderRunToken: () => 't',
    issueMcpBridgeCredentials: () => ({ url: 'http://127.0.0.1:39999/mcp', token: 'b' }),
    revokeGenerationCredentials: () => { revoked.count += 1; return true; },
    leaderTools: ['task_submit', 'task_query', 'task_control', 'task_resume', 'amagi_resource'],
    roleMcpTools: { luban: ['raw_read', 'kb_write_doc'], diting: ['raw_read', 'kb_submit_review'], baize: ['raw_read'] },
    getLeaderModel: () => 'zhipuai/glm-5.3',
    isProcessAlive: pidAlive,
  };
  return { spec, deps, revoked };
}

describe('PiAmagiBuildRuntime（真实子进程，假 pi CLI fixture）', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('start 绑定真实 leaderPid；cancel 撤销凭据并如实核对残留', async () => {
    const { spec, deps, revoked } = await prepare(root);
    const runtime = new PiAmagiBuildRuntime(deps);
    const binding = await runtime.start(spec);
    expect(binding.leaderPid).toBeGreaterThan(0);
    expect(pidAlive(binding.leaderPid)).toBe(true);
    const rpc = runtime.getRpcProcess(binding);
    expect(rpc?.getPid()).toBe(binding.leaderPid);
    const captured = JSON.parse(fs.readFileSync(path.join(binding.agentDir, 'guard-env.json'), 'utf8'));
    const envelope = JSON.parse(captured.spec);
    expect(envelope.tools).toEqual(deps.leaderTools);
    expect(envelope.guard.roles.luban.mcpTools).toEqual(deps.roleMcpTools.luban);
    expect(envelope.guard.workDir).toBe(binding.workDir);
    expect(fs.existsSync(captured.module)).toBe(true);
    expect(captured.argv[captured.argv.indexOf('--append-system-prompt') + 1]).toBe(spec.workflowSkillPath);
    const result = await runtime.cancel(binding);
    expect(result.credentialsRevoked).toBe(true);
    expect(revoked.count).toBe(1);
    expect(result.leaderExit).not.toBeNull();
    // F10：终止对账结构化结果（fixture 无锚点 → 无个体可对账，如实 confirmed）
    expect(result.termination?.state).toBe('confirmed');
    expect(result.residualNote).toContain('Leader 已终止');
    expect(pidAlive(binding.leaderPid)).toBe(false);
  });

  it('应用重启后 resume：binding 自描述重建；旧 pid 存活拒绝，死后原会话续接', async () => {
    const { spec, deps } = await prepare(root);
    const first = new PiAmagiBuildRuntime(deps);
    const binding1 = await first.start(spec);
    // 模拟应用重启：新实例（内存 Map 空），但保留 binding（来自 checkpoint）
    const second = new PiAmagiBuildRuntime(deps);
    const checkpoint = { buildId: spec.buildId, generation: spec.generation, spec, binding: binding1, artifactReceiptRefs: [], eventCursor: null };
    // 旧 Leader 仍存活（binding1.leaderPid 是真进程）→ 拒绝双 Leader
    await expect(second.resume(binding1, checkpoint)).rejects.toThrow('仍存活');
    // 杀掉旧 Leader 后（模拟崩溃），resume 成功并以原 session id 重启
    await first.cancel(binding1);
    const binding2 = await second.resume(binding1, checkpoint);
    expect(binding2.leaderSessionId).toBe(binding1.leaderSessionId);
    expect(binding2.leaderPid).toBeGreaterThan(0);
    expect(binding2.resumeCapability).toEqual({ session: true, artifact: true });
    await second.cancel(binding2);
  });

  it('binding 路径与 dataRoot 推导不一致 → 拒绝恢复（不采信外部路径）', async () => {
    const { spec, deps } = await prepare(root);
    const runtime = new PiAmagiBuildRuntime(deps);
    const binding = await runtime.start(spec);
    await runtime.cancel(binding);
    const forged = { ...binding, agentDir: '/elsewhere/home' };
    const checkpoint = { buildId: spec.buildId, generation: spec.generation, spec, binding: forged, artifactReceiptRefs: [], eventCursor: null };
    await expect(runtime.resume(forged, checkpoint)).rejects.toThrow('路径与 dataRoot 推导不一致');
  });

  it('无注入存活探针仍拒绝第二Leader；冻结包路径不可替换为未核验代码', async () => {
    const { spec, deps } = await prepare(root);
    delete deps.isProcessAlive;
    const first = new PiAmagiBuildRuntime(deps);
    await expect(first.start({ ...spec, amagiPackage: { ...spec.amagiPackage, packageRoot: root } })).rejects.toThrow('冻结版本');
    const binding = await first.start(spec);
    try {
      const second = new PiAmagiBuildRuntime(deps);
      await expect(second.resume(binding, { buildId: spec.buildId, generation: spec.generation, spec, binding, artifactReceiptRefs: [], eventCursor: null })).rejects.toThrow('仍存活');
    } finally { await first.cancel(binding); }
  });

  it('工作流规则被篡改不能注入系统提示或恢复', async () => {
    const { spec, deps } = await prepare(root);
    fs.appendFileSync(spec.workflowSkillPath, 'changed rules');
    await expect(new PiAmagiBuildRuntime(deps).start(spec)).rejects.toThrow('工作流规则与冻结哈希不一致');
  });

  it('spec 哈希与落盘不一致 → start 明确拒绝（先 render+compute 冻结）', async () => {
    const { spec, deps } = await prepare(root);
    const runtime = new PiAmagiBuildRuntime(deps);
    const bad = { ...spec, agentDirConfigHash: '0'.repeat(16) };
    await expect(runtime.start(bad)).rejects.toThrow('先以相同 deps');
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('F10-R3：reconcileBuildResiduals 跨 epoch 对账（旧 epoch 锚点不因换目录被绕过；无事实返回 null）', async () => {
    const { spec, deps } = await prepare(root);
    const buildRoot = planBuildDirectories(deps.dataRoot, spec.buildId, 1).buildRoot;
    // 旧 epoch（e1）锚点指向无关存活进程（令牌不匹配 → not-ours 不杀）；
    // 账本登记旧 Leader（归因锚点 + 旧运行事实，includeLeaders=false 不回收它）
    const audits = path.join(buildRoot, 'epochs', 'e1', 'home', 'amagi', 'data', 'process-audits', 'old');
    fs.mkdirSync(audits, { recursive: true });
    appendProcessLedgerEntry(buildRoot, {
      launchId: 'l_old', buildId: spec.buildId, runtimeEpoch: 1, generation: 1, kind: 'leader',
      pid: process.pid, startedAt: new Date().toISOString(), cwd: '/w',
    });
    const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},60000)'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(path.join(audits, 'launch-anchor.json'), JSON.stringify({
        version: 1,
        taskId: 'old-task',
        runs: [{ rootPid: victim.pid, pgid: victim.pid, rootIdentityToken: 'darwin:1:1', leaderPid: process.pid, at: Date.now() }],
      }));
      // 新 epoch（e2）v2-store 活跃任务无锚点（spawn→锚点窗口硬崩形态）
      const v2dir = path.join(buildRoot, 'epochs', 'e2', 'home', 'amagi', 'v2-store', 'task-x');
      fs.mkdirSync(v2dir, { recursive: true });
      fs.writeFileSync(path.join(v2dir, 'current.json'), JSON.stringify({ execution: 'running', processState: 'alive' }));
      const runtime = new PiAmagiBuildRuntime(deps);
      const outcome = await runtime.reconcileBuildResiduals({ buildId: spec.buildId, binding: null }, { reap: true });
      expect(outcome).not.toBeNull();
      expect(outcome?.state).toBe('unconfirmed'); // 两个 epoch 各自的缺口都可见
      expect(outcome?.note).toContain('跨 2 个 epoch');
      expect(outcome?.children.some((child) => child.pid === victim.pid && child.verdict === 'not-ours')).toBe(true);
      expect(outcome?.children.some((child) => child.taskId === 'task-x' && child.source === 'v2-store')).toBe(true);
      try { process.kill(victim.pid!, 0); } catch { throw new Error('not-ours 个体不应被发信号'); }
      // 无任何旧运行事实（无 home/账本/binding）→ null（fresh 构建无据可对，不冒充 confirmed）
      const empty = await runtime.reconcileBuildResiduals({ buildId: 'b_nofacts', binding: null }, { reap: true });
      expect(empty).toBeNull();
    } finally {
      try { victim.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }, 30_000);

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('F10-R3（steer 调整 #1）：账本未收口 Leader 存活 → 守卫对账阻断（binding 未落盘窗口，不发信号）', async () => {
    const { spec, deps } = await prepare(root);
    const buildRoot = planBuildDirectories(deps.dataRoot, spec.buildId, 1).buildRoot;
    const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},60000)'], { stdio: 'ignore' });
    try {
      const tokens = await readBirthIdentities([victim.pid!]);
      const token = tokens.get(victim.pid!);
      expect(token).toBeTruthy();
      // 模拟硬崩：Leader 启动登记账本（含真实出生令牌）但 binding/exit 均未落
      appendProcessLedgerEntry(buildRoot, {
        launchId: 'l_alive', buildId: spec.buildId, runtimeEpoch: 1, generation: 1, kind: 'leader',
        pid: victim.pid!, startedAt: new Date().toISOString(), cwd: '/w', birthToken: token,
      });
      const runtime = new PiAmagiBuildRuntime(deps);
      const outcome = await runtime.reconcileBuildResiduals({ buildId: spec.buildId, binding: null }, { reap: true });
      expect(outcome?.state).toBe('unconfirmed');
      const finding = outcome?.children.find((child) => child.pid === victim.pid);
      expect(finding).toMatchObject({ source: 'ledger', verdict: 'unconfirmed' });
      expect(finding?.detail).toContain('仍存活');
      try { process.kill(victim.pid!, 0); } catch { throw new Error('存活 Leader 不应被发信号'); }
    } finally {
      try { victim.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }, 30_000);

  it('probeWith：静态面就绪（fixture 包）且 fail-closed 断言可用', async () => {
    const { spec, deps } = await prepare(root);
    const runtime = new PiAmagiBuildRuntime(deps);
    const report = await runtime.probeWith({
      dataRoot: root,
      amagiVersion: '2.21.31',
      knowledgeBaseRoot: path.join(root, 'raw'),
      outputRoot: path.join(root, 'std'),
      hasModelApiKey: true,
      piVersion: '1.4.0',
    });
    expect(report.staticOk).toBe(true);
    expect(report.fullyVerified).toBe(false);
    const failed = await runtime.probeWith({
      dataRoot: root, amagiVersion: '9.9.9',
      knowledgeBaseRoot: path.join(root, 'raw'), outputRoot: path.join(root, 'std'),
      hasModelApiKey: true, piVersion: '1.4.0',
    }).catch((error: Error) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain('拒绝启用');
    void spec;
  });

  it('F09：start 绑定 epoch 目录与 epoch 唯一会话 id；不同 epoch 不同 agentDir/sessionId', async () => {
    const { spec, deps } = await prepare(root);
    const runtime = new PiAmagiBuildRuntime(deps);
    const binding1 = await runtime.start(spec);
    expect(binding1.runtimeEpoch).toBe(1);
    expect(binding1.agentDir).toBe(path.join(root, 'agent', 'builds', spec.buildId, 'epochs', 'e1', 'home'));
    expect(binding1.workDir).toBe(path.join(root, 'agent', 'builds', spec.buildId, 'epochs', 'e1', 'work'));
    expect(binding1.sessionDir).toBe(path.join(root, 'agent', 'builds', spec.buildId, 'epochs', 'e1', 'home', 'sessions'));
    expect(binding1.leaderSessionId).toBe(`build-${spec.buildId}-e1`);
    expect(binding1.launchId).toMatch(/^l_[0-9a-f]+$/);
    await runtime.cancel(binding1);
    // 同一 build 第二 epoch：全新 agentDir（全新 amagi 内部库）与新会话 id
    const binding2 = await runtime.start(spec, { runtimeEpoch: 2 });
    expect(binding2.agentDir).toBe(path.join(root, 'agent', 'builds', spec.buildId, 'epochs', 'e2', 'home'));
    expect(binding2.leaderSessionId).toBe(`build-${spec.buildId}-e2`);
    expect(binding2.leaderSessionId).not.toBe(binding1.leaderSessionId);
    // 两 epoch 配置各自存在且互不影响（rebuild 不复用旧内部库）
    expect(fs.existsSync(path.join(binding1.agentDir, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(binding2.agentDir, 'settings.json'))).toBe(true);
    // 进程账本登记两次启动（跨 epoch 共享、launchId 各异）
    const ledger = JSON.parse(fs.readFileSync(path.join(root, 'agent', 'builds', spec.buildId, 'process-ledger.json'), 'utf8')) as { entries: Array<{ launchId: string; runtimeEpoch: number | null; pid: number }> };
    expect(ledger.entries).toHaveLength(2);
    expect(new Set(ledger.entries.map((entry) => entry.launchId)).size).toBe(2);
    expect(ledger.entries.map((entry) => entry.runtimeEpoch).sort()).toEqual([1, 2]);
    await runtime.cancel(binding2);
  });

  it('F09：原会话续接复用同 epoch/同 sessionId；rebuild 换 epoch 后不打开旧会话', async () => {
    const { spec, deps } = await prepare(root);
    const first = new PiAmagiBuildRuntime(deps);
    const binding1 = await first.start(spec);
    await first.cancel(binding1);
    const second = new PiAmagiBuildRuntime(deps);
    const checkpoint = { buildId: spec.buildId, generation: spec.generation, spec, binding: binding1, artifactReceiptRefs: [], eventCursor: null };
    const bindingResumed = await second.resume(binding1, checkpoint);
    // 原会话续接：同 epoch、同 sessionId、新 launchId
    expect(bindingResumed.runtimeEpoch).toBe(1);
    expect(bindingResumed.leaderSessionId).toBe(binding1.leaderSessionId);
    expect(bindingResumed.launchId).not.toBe(binding1.launchId);
    await second.cancel(bindingResumed);
    // rebuild：host 传新 epoch → 全新会话 id（Pi --session-id 存在即打开，
    // 新 id 保证不会带回旧对话）
    const third = new PiAmagiBuildRuntime(deps);
    const bindingRebuild = await third.start(spec, { runtimeEpoch: 2 });
    expect(bindingRebuild.leaderSessionId).not.toBe(binding1.leaderSessionId);
    expect(bindingRebuild.agentDir).not.toBe(binding1.agentDir);
    await third.cancel(bindingRebuild);
  });

  it('F09：legacy binding（无 epoch）按旧布局路径恢复（旧检查点兼容）', async () => {
    const { spec, deps } = await prepare(root);
    const runtime = new PiAmagiBuildRuntime(deps);
    // 旧布局：手写配置到 <buildRoot>/home，构造无 epoch 的 legacy binding
    const legacyDirs = planBuildDirectories(root, spec.buildId);
    const bridge = { bridgeCommand: process.execPath, bridgeArgs: [path.join(root, 'bridge.cjs')] };
    writeAgentDirConfig(spec, legacyDirs, bridge);
    const legacyBinding = {
      buildId: spec.buildId,
      generation: spec.generation,
      launchId: 'legacy',
      agentDir: legacyDirs.homeDir,
      workDir: legacyDirs.workDir,
      sessionDir: legacyDirs.sessionDir,
      leaderSessionId: `build-${spec.buildId}`,
      leaderPid: null,
      resumeCapability: { session: true, artifact: true },
    };
    // leaderPid=null：无法安全会话恢复（如实拒绝，不伪造）
    await expect(runtime.resume(legacyBinding, { buildId: spec.buildId, generation: spec.generation, spec, binding: legacyBinding, artifactReceiptRefs: [], eventCursor: null }))
      .rejects.toThrow('缺少进程身份');
    void runtime;
  });

  it('observe：RPC 记录包装为 RuntimeEvent（e<N> 游标单调）', async () => {
    const { spec, deps } = await prepare(root);
    const runtime = new PiAmagiBuildRuntime(deps);
    const binding = await runtime.start(spec);
    const rpc = runtime.getRpcProcess(binding)!;
    const events: import('../src/agent/build-runtime/contracts.js').RuntimeEvent[] = [];
    const iterator = runtime.observe(binding)[Symbol.asyncIterator]();
    // fake pi 就绪即发一条 state 事件；再触发一条 response
    await rpc.sendCommand('get_state', {});
    const first = await iterator.next();
    expect(first.done).toBe(false);
    events.push(first.value);
    const second = await iterator.next();
    expect(second.done).toBe(false);
    events.push(second.value);
    expect(events[0].source).toBe('leader-rpc');
    expect(events[0].eventId).toMatch(/^e\d+$/);
    expect(Number(events[1].eventId.slice(1))).toBeGreaterThan(Number(events[0].eventId.slice(1)));
    expect(events[0].generation).toBe(spec.generation);
    await runtime.cancel(binding);
  });
});
