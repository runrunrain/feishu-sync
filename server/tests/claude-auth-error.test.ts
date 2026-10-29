import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ClaudeCodeProcess, claudeFatalApiError } from '../src/agent/claude-code-process.js';
import { resolveClaudeCodePath } from '../src/agent/claude-runtime.js';

it('only treats permanent authentication errors as fatal and redacts secrets', () => {
  expect(claudeFatalApiError({ type: 'system', subtype: 'api_error', error: { status: 429 } }, [])).toBeNull();
  expect(claudeFatalApiError({ type: 'system', subtype: 'api_error', error: { status: 401, message: 'secret-token' } }, ['secret-token'])).toContain('[redacted]');
});

const executable = resolveClaudeCodePath();
it.skipIf(!executable)('returns a 401 error instead of waiting through Claude Code retries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-check-'));
  const server = http.createServer((_req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid fixture key' } })); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const cli = new ClaudeCodeProcess({ executable: executable!, nodePath: process.execPath, bridgePath: path.resolve('src/agent/claude-bridge.cjs'),
    cwd: path.join(root, 'cwd'), sessionDir: path.join(root, 'sessions'), sessionId: 'auth-test', tools: [], model: 'fixture',
    baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key', agentUrl: `http://127.0.0.1:${port}`, runToken: 'test-token', parentEnv: process.env });
  try {
    await cli.start();
    const outcome = await cli.prompt('hello', { timeoutMs: 20_000 });
    expect(outcome).toMatchObject({ outcome: 'failed', error: { code: 'model_request_failed', message: expect.stringContaining('认证失败') } });
  } finally { await cli.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
