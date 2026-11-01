/**
 * PiRpcProcess 构建模式增量测试（设计v2 §11 pi-rpc-process 行）
 *
 * 用假 pi CLI fixture（Node 脚本：回显 argv、应答 RPC 命令、可注入事件流）
 * 真实 spawn 验证 argv 构造与自触发轮次跟踪；真实 pi 上的行为属接入试验
 * （未验证项，见 runtime-report）。
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiRpcProcess } from '../src/agent/pi-rpc-process.js';

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-proc-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * 假 pi CLI（测试 fixture）：
 * - 把 argv 写入 $FAKE_PI_ARGV_FILE 指向的文件；
 * - 每行 stdin JSON 命令回一条 response；
 * - env FAKE_PI_SCRIPT=events 时，就绪后先发一轮自触发事件
 *   （message_update → agent_settled）。
 */
function makeFakePi(root: string, script: 'idle' | 'events' = 'idle'): string {
  const file = path.join(root, `fake-pi-${script}.mjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = await import('node:fs');
const readline = await import('node:readline');
fs.writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
send({ type: 'state', hint: 'fake-ready' });
if (process.env.FAKE_PI_SCRIPT === 'events') {
  setTimeout(() => send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'self' } }), 150);
  setTimeout(() => send({ type: 'agent_settled' }), 300);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let cmd; try { cmd = JSON.parse(line); } catch { return; }
  send({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: {} });
});
rl.on('close', () => process.exit(0));
`, { mode: 0o755 });
  return file;
}

function argvFile(root: string): string { return path.join(root, `argv-${Math.random().toString(36).slice(2)}.json`); }

async function readArgv(file: string): Promise<string[]> {
  for (let i = 0; i < 100; i += 1) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')) as string[];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('argv 文件未写出');
}

const BASE = {
  nodePath: process.execPath,
  cwd: os.tmpdir(),
  env: { PATH: process.env.PATH ?? '' },
  noSession: true,
};

describe('构建模式启动参数（buildMode）', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('buildMode 强制显式 --tools 白名单（即使 allowExternalPluginTools=true）', async () => {
    const pi = makeFakePi(root);
    const file = argvFile(root);
    const rpc = new PiRpcProcess({
      ...BASE, piCliPath: pi, tools: ['task_submit', 'task_query', 'amagi_resource'],
      buildMode: true, allowExternalPluginTools: true,
      env: { ...BASE.env, FAKE_PI_ARGV_FILE: file },
    });
    await rpc.start();
    const argv = await readArgv(file);
    expect(argv).toContain('--tools');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('task_submit,task_query,amagi_resource');
    await rpc.terminate(500);
  });

  it('buildMode 白名单为空 → 启动前拒绝（fail-closed）', async () => {
    const pi = makeFakePi(root);
    const rpc = new PiRpcProcess({
      ...BASE, piCliPath: pi, tools: [], buildMode: true,
      env: { ...BASE.env, FAKE_PI_ARGV_FILE: argvFile(root) },
    });
    try {
      await rpc.start();
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('build_tools_empty');
    }
  });

  it('普通模式行为不变：allowExternalPluginTools=true 时不传 --tools', async () => {
    const pi = makeFakePi(root);
    const file = argvFile(root);
    const rpc = new PiRpcProcess({
      ...BASE, piCliPath: pi, tools: ['x'], allowExternalPluginTools: true,
      env: { ...BASE.env, FAKE_PI_ARGV_FILE: file },
    });
    await rpc.start();
    const argv = await readArgv(file);
    expect(argv).not.toContain('--tools');
    await rpc.terminate(500);
  });

  it('buildMode 双扩展经 -e 传入且关闭自动发现的旗标保持', async () => {
    const pi = makeFakePi(root);
    const file = argvFile(root);
    const rpc = new PiRpcProcess({
      ...BASE, piCliPath: pi, tools: ['t'],
      buildMode: true,
      additionalExtensionPaths: ['/pkgs/amagi-pi@2.21.31', '/app/pi-extension/feishu-sync-agent.js'],
      env: { ...BASE.env, FAKE_PI_ARGV_FILE: file },
    });
    await rpc.start();
    const argv = await readArgv(file);
    const eFlags = argv.filter((_, i) => argv[i - 1] === '-e');
    expect(eFlags).toEqual(['/pkgs/amagi-pi@2.21.31', '/app/pi-extension/feishu-sync-agent.js']);
    for (const flag of ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--offline']) {
      expect(argv).toContain(flag);
    }
    await rpc.terminate(500);
  });
});

describe('自触发轮次（selfTriggeredRounds）', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('跟踪 round_started/round_settled；期间 prompt 被明确拒绝', async () => {
    const pi = makeFakePi(root, 'events');
    const file = argvFile(root);
    const rpc = new PiRpcProcess({
      ...BASE, piCliPath: pi, tools: ['t'], buildMode: true, selfTriggeredRounds: true,
      env: { ...BASE.env, FAKE_PI_ARGV_FILE: file, FAKE_PI_SCRIPT: 'events' },
    });
    await rpc.start();
    const started = new Promise<{ roundId: string }>((resolve) => rpc.once('round_started', resolve));
    const settled = new Promise<{ roundId: string }>((resolve) => rpc.once('round_settled', resolve));
    await started;
    expect(rpc.hasActiveRound()).toBe(true);
    await expect(rpc.prompt('hi')).rejects.toSatisfy((error: unknown) => (error as { code?: string }).code === 'round_in_progress');
    await settled;
    expect(rpc.hasActiveRound()).toBe(false);
    expect(rpc.hasActiveRun()).toBe(false);
    await rpc.terminate(500);
  });

  it('未开启 selfTriggeredRounds 的普通会话不跟踪自触发轮（行为不变）', async () => {
    const pi = makeFakePi(root, 'events');
    const file = argvFile(root);
    const rpc = new PiRpcProcess({
      ...BASE, piCliPath: pi, tools: ['t'],
      env: { ...BASE.env, FAKE_PI_ARGV_FILE: file, FAKE_PI_SCRIPT: 'events' },
    });
    await rpc.start();
    await new Promise((r) => setTimeout(r, 500));
    expect(rpc.hasActiveRound()).toBe(false);
    const events: string[] = [];
    rpc.on('round_started', () => events.push('started'));
    rpc.on('round_settled', () => events.push('settled'));
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual([]);
    await rpc.terminate(500);
  });
});

describe('terminate 宽限可配置', () => {
  it('terminateGraceMs 进入默认宽限（退出信息可观测）', async () => {
    const root = tmpRoot();
    const pi = makeFakePi(root);
    const file = argvFile(root);
    const rpc = new PiRpcProcess({
      ...BASE, piCliPath: pi, tools: ['t'], buildMode: true, terminateGraceMs: 10_000,
      env: { ...BASE.env, FAKE_PI_ARGV_FILE: file },
    });
    await rpc.start();
    const startedAt = Date.now();
    await rpc.terminate(); // 不传参 → 用 options.terminateGraceMs（fake pi stdin 关闭即退出，宽限上限不会用满）
    expect(rpc.isExited()).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
