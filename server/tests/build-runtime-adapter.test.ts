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

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installAmagiPackage } from '../src/agent/build-runtime/amagi-package.js';
import {
  computeAgentDirConfigHash, planBuildDirectories, renderAgentDirConfigFiles,
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
    resolveZhipuApiKey: () => 'k',
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
    const result = await runtime.cancel(binding);
    expect(result.credentialsRevoked).toBe(true);
    expect(revoked.count).toBe(1);
    expect(result.leaderExit).not.toBeNull();
    expect(result.residualNote).toContain('已确认退出');
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

  it('spec 哈希与落盘不一致 → start 明确拒绝（先 render+compute 冻结）', async () => {
    const { spec, deps } = await prepare(root);
    const runtime = new PiAmagiBuildRuntime(deps);
    const bad = { ...spec, agentDirConfigHash: '0'.repeat(16) };
    await expect(runtime.start(bad)).rejects.toThrow('先以相同 deps');
  });

  it('probeWith：静态面就绪（fixture 包）且 fail-closed 断言可用', async () => {
    const { spec, deps } = await prepare(root);
    const runtime = new PiAmagiBuildRuntime(deps);
    const report = await runtime.probeWith({
      dataRoot: root,
      amagiVersion: '2.21.31',
      knowledgeBaseRoot: path.join(root, 'raw'),
      outputRoot: path.join(root, 'std'),
      hasZhipuApiKey: true,
      piVersion: '1.4.0',
    });
    expect(report.staticOk).toBe(true);
    expect(report.fullyVerified).toBe(false);
    const failed = await runtime.probeWith({
      dataRoot: root, amagiVersion: '9.9.9',
      knowledgeBaseRoot: path.join(root, 'raw'), outputRoot: path.join(root, 'std'),
      hasZhipuApiKey: true, piVersion: '1.4.0',
    }).catch((error: Error) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain('拒绝启用');
    void spec;
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
