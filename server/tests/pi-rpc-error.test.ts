import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiRpcProcess } from '../src/agent/pi-rpc-process.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-error-fixture-'));
const cli = path.join(root, 'fake-pi.cjs');
fs.writeFileSync(cli, `
const readline = require('node:readline');
const send = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type !== 'prompt') {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: {} });
    return;
  }
  if (process.env.FIXTURE_SCENARIO === 'rejected') {
    send({ type: 'response', id: command.id, command: 'prompt', success: false,
      error: 'No API key: fixture-api-secret fixture-run-secret' });
    return;
  }
  send({ type: 'response', id: command.id, command: 'prompt', success: true });
  if (process.env.FIXTURE_SCENARIO === 'large-frame') {
    process.stdout.write('x'.repeat(5000));
    return;
  }
  if (process.env.FIXTURE_SCENARIO === 'pending') return;
  const error = process.env.FIXTURE_SCENARIO === 'quota'
    ? { role: 'assistant', stopReason: 'error', content: [], errorMessage:
        '429: {"code":"1113","message":"余额不足或无可用资源包 fixture-run-secret", "api_key":"fixture-api-secret", "token":"other-provider-token"}' }
    : { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: '上游服务暂时不可用' }] };
  send({ type: 'message_end', message: error });
  if (process.env.FIXTURE_SCENARIO === 'recovered') {
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '已恢复' }] } });
  }
  send({ type: 'agent_settled' });
});
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function run(scenario: string) {
  const rpc = new PiRpcProcess({
    nodePath: process.execPath, piCliPath: cli, cwd: root, tools: [], noSession: true,
    env: { ...process.env, FIXTURE_SCENARIO: scenario,
      FEISHU_SYNC_AGENT_API_KEY: 'fixture-api-secret', FEISHU_SYNC_AGENT_RUN_TOKEN: 'fixture-run-secret' },
  });
  try {
    await rpc.start();
    return await rpc.prompt('fixture');
  } finally { await rpc.terminate(); }
}

describe('Pi RPC 模型错误传递', () => {
  it('保留额度不足原因并脱敏密钥和运行令牌', async () => {
    const outcome = await run('quota');
    expect(outcome).toMatchObject({ outcome: 'failed', error: { code: 'model_quota_exceeded', message: expect.stringContaining('1113') } });
    expect(outcome.error?.message).toContain('余额不足');
    expect(outcome.error?.message).not.toContain('fixture-api-secret');
    expect(outcome.error?.message).not.toContain('fixture-run-secret');
    expect(outcome.error?.message).not.toContain('other-provider-token');
  });

  it('缺少 errorMessage 时保留助手错误文本', async () => {
    expect(await run('fallback')).toMatchObject({ outcome: 'failed', error: { code: 'model_request_failed', message: '上游服务暂时不可用' } });
  });

  it('错误后恢复成功时不沿用旧错误', async () => {
    expect(await run('recovered')).toMatchObject({ outcome: 'completed', lastAssistantText: '已恢复' });
  });

  it('prompt 命令直接拒绝时也对错误脱敏', async () => {
    const outcome = await run('rejected');
    expect(outcome).toMatchObject({ outcome: 'failed', error: { code: 'model_auth_missing' } });
    expect(outcome.error?.message).not.toContain('fixture-api-secret');
    expect(outcome.error?.message).not.toContain('fixture-run-secret');
  });
});

describe('Pi RPC 宿主异常隔离', () => {
  it('stdin/stdout/stderr 的异步错误终止本次运行，不抛出宿主未捕获异常', async () => {
    for (const pipeName of ['stdin', 'stdout', 'stderr'] as const) {
      const rpc = new PiRpcProcess({ nodePath: process.execPath, piCliPath: cli, cwd: root, tools: [], noSession: true, env: { ...process.env, FIXTURE_SCENARIO: 'pending' } });
      try {
        await rpc.start();
        const outcome = rpc.prompt('fixture');
        const child = (rpc as unknown as { child: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream } }).child;
        expect(() => child[pipeName].emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).not.toThrow();
        expect(await outcome).toMatchObject({ outcome: 'failed', error: { code: 'pi_transport_failed' } });
      } finally { await rpc.terminate(); }
    }
  });

  it('未结束的超大 JSONL 帧会结算为失败并清空缓冲', async () => {
    const rpc = new PiRpcProcess({ nodePath: process.execPath, piCliPath: cli, cwd: root, tools: [], noSession: true,
      env: { ...process.env, FIXTURE_SCENARIO: 'large-frame' }, maxFrameBytes: 1024 });
    try {
      await rpc.start();
      expect(await rpc.prompt('fixture')).toMatchObject({ outcome: 'failed', error: { code: 'pi_frame_too_large' } });
      expect((rpc as unknown as { stdoutBuffer: string }).stdoutBuffer).toBe('');
    } finally { await rpc.terminate(); }
  });

  it('模型事件处理器抛错被收敛成运行失败', async () => {
    const rpc = new PiRpcProcess({ nodePath: process.execPath, piCliPath: cli, cwd: root, tools: [], noSession: true, env: { ...process.env, FIXTURE_SCENARIO: 'fallback' } });
    try {
      await rpc.start();
      rpc.on('event', () => { throw new Error('fixture listener failed'); });
      expect(await rpc.prompt('fixture')).toMatchObject({ outcome: 'failed', error: { code: 'pi_protocol_failed' } });
    } finally { await rpc.terminate(); }
  });
});
