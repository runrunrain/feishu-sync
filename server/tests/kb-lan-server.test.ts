/** Main Hono server smoke, real sockets and temporary state; never enables a LAN listener. */
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
import { execFileSync } from 'node:child_process';

let close: (() => Promise<void>) | undefined;
let root: string | undefined;
afterEach(async () => { await close?.(); vi.unstubAllEnvs(); if (root) await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
it('real main server stays loopback; desktop/CLI work, LAN token has no main privileges', async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-lan-main-')));
  vi.stubEnv('FEISHU_SYNC_HOME', root);
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ knowledgeBaseRoot: path.join(root, 'raw'), standardKb: { outputRoot: path.join(root, 'standard') }, agent: {}, cli: { enabled: false }, allowStandaloneKbMcp: false, kbLanMcp: { enabled: false, bindAddress: '127.0.0.1', port: 47391, maxSessions: 16 } }));
  writeSearchRelease(path.join(root, 'standard'), 'r_shared', [{ docId: 'shared', path: '入口.md', body: '# 分享正文' }]);
  const socket = net.createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const localMcpPort = (socket.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const { startServer } = await import('../src/index.js');
  const started = await startServer({ configPath: file, desktopMode: true, desktopToken: 'desktop-isolated-fixture', port: 0, hostname: '127.0.0.1', localMcpPort, webShare: { port: 0, hostname: '127.0.0.1' } }); close = started.close;
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
  expect((await call('/api/kb/distribution/shares', 'GET', undefined, {})).status).toBe(401);
  const shared = await call('/api/kb/distribution/shares', 'POST', { releaseId: 'r_shared', docIds: ['shared'], baseDocId: 'shared' });
  expect(shared.status).toBe(201);
  const share = await shared.json();
  expect(share.port).not.toBe(localMcpPort);
  const shareUrl = `http://127.0.0.1:${share.port}/s/${share.shares[0].id}/0.html`;
  expect(await (await fetch(shareUrl)).text()).toContain('分享正文');
  await vi.waitFor(async () => expect((await (await call('/api/kb/mcp')).json()).available).toBe(true), { timeout: 8000 });
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
  await expect(fetch(shareUrl)).rejects.toThrow();
  await vi.waitFor(async () => await expect(fetch(`http://127.0.0.1:${localMcpPort}/mcp`)).rejects.toThrow(), { timeout: 4000 });
}, 20_000);
