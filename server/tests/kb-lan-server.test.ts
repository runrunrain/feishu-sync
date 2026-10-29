/** Main Hono server smoke, real sockets and temporary state; never enables a LAN listener. */
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let close: (() => Promise<void>) | undefined;
let root: string | undefined;
afterEach(async () => { await close?.(); vi.unstubAllEnvs(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
it('real main server stays loopback; desktop/CLI work, LAN token has no main privileges', async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-lan-main-')));
  vi.stubEnv('FEISHU_SYNC_HOME', root);
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ knowledgeBaseRoot: path.join(root, 'raw'), standardKb: { outputRoot: path.join(root, 'standard') }, agent: {}, cli: { enabled: false }, kbLanMcp: { enabled: false, bindAddress: '127.0.0.1', port: 47391, maxSessions: 16 } }));
  const { startServer } = await import('../src/index.js');
  const started = await startServer({ configPath: file, desktopMode: true, desktopToken: 'desktop-isolated-fixture', port: 0, hostname: '127.0.0.1' }); close = started.close;
  expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/); expect(started.port).not.toBe(0);
  if (process.platform === 'darwin') {
    const listeners = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(process.pid), `-iTCP:${started.port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    expect(listeners).toContain(`127.0.0.1:${started.port} (LISTEN)`);
    expect(listeners).not.toContain(`*:${started.port}`);
    console.info('Main loopback lsof evidence:', listeners.trim());
  }
  expect((await fetch(started.url + '/api/health')).status).toBe(200);
  const call = (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = { 'X-Desktop-Token': 'desktop-isolated-fixture' }) => fetch(started.url + route, { method, headers: { ...headers, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect((await call('/api/config')).status).toBe(200);
  expect((await call('/api/kb-lan-mcp/status')).status).toBe(200);
  expect((await call('/api/cli/enable', 'POST', { enabled: true })).status).toBe(200);
  const cliToken = JSON.parse(fs.readFileSync(path.join(root, 'run', 'endpoint.json'), 'utf8')).cliToken;
  expect((await call('/api/cli/commands', 'GET', undefined, { 'X-Cli-Token': cliToken })).status).toBe(200);
  const forbidden = await call('/api/cli/config.set', 'POST', { args: { path: 'kbLanMcp.enabled', value: true } }, { 'X-Cli-Token': cliToken });
  expect(forbidden.status).toBe(400); expect(await forbidden.text()).toContain('forbidden_path');
  // Rotation while disabled provisions a credential but opens no listener.
  expect((await call('/api/kb-lan-mcp/token/rotate', 'POST')).status).toBe(200);
  const kbToken = (await (await call('/api/kb-lan-mcp/token/reveal', 'POST')).json()).token;
  expect((await call('/api/config', 'GET', undefined, { 'X-Desktop-Token': kbToken })).status).toBe(401);
  expect((await call('/api/cli/commands', 'GET', undefined, { 'X-Cli-Token': kbToken })).status).toBe(401);
  expect((await call('/api/kb-lan-mcp/status', 'GET', undefined, { 'X-Desktop-Token': cliToken })).status).toBe(401);
  expect((await call('/api/cli/commands', 'GET', undefined, { 'X-Cli-Token': 'desktop-isolated-fixture' })).status).toBe(401);
  await started.close(); close = undefined;
  expect(fs.existsSync(path.join(root, 'run', 'endpoint.json'))).toBe(false);
  await expect(fetch(started.url + '/api/health')).rejects.toThrow();
}, 20_000);
