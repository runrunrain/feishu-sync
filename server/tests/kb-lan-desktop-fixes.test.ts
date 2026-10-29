import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import { DEFAULT_CIDRS, allowedSource } from '../src/kb-lan/network.js';
import { startServer } from '../src/index.js';

beforeAll(async () => {
  const { bundleGateway } = await import('../scripts/lib/mcp-bundle.mjs');
  await bundleGateway();
});
const roots: string[] = [];
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function temporary() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-desktop-fix-')));
  roots.push(root); vi.stubEnv('FEISHU_SYNC_HOME', root); return root;
}

it('settings omission resets CIDRs through the real API, disk and reloaded ConfigManager', async () => {
  const root = temporary();
  const configPath = path.join(root, 'config.json');
  const kb = path.join(root, 'standard');
  writeSearchRelease(kb, 'synthetic', [{ path: 'example.md', docId: 'example', title: 'example', body: '# example\n' }]);
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  fs.writeFileSync(configPath, JSON.stringify({ knowledgeBaseRoot: path.join(root, 'raw'), standardKb: { outputRoot: kb }, agent: {}, kbLanMcp: { enabled: false, bindAddress: '127.0.0.1', port, maxSessions: 8 } }));
  const main = await startServer({ configPath, port: 0, desktopMode: true, desktopToken: 'synthetic-desktop-test' });
  close.push(main.close);
  const api = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(main.url + route, { method, headers: { 'X-Desktop-Token': 'synthetic-desktop-test', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status).toBe(200); return response.json();
  };
  const base = { bindAddress: '127.0.0.1', port, maxSessions: 8 };
  await api('/api/kb-lan-mcp/settings', 'PUT', { ...base, allowCidrs: ['127.0.0.0/8'] });
  expect((await api('/api/config')).kbLanMcp.allowCidrs).toEqual(['127.0.0.0/8']);
  await api('/api/kb-lan-mcp/settings', 'PUT', base);
  const current = (await api('/api/config')).kbLanMcp;
  expect(current.allowCidrs).toBeUndefined(); expect(current.maxSessions).toBe(8);
  const disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  expect(disk.kbLanMcp.allowCidrs).toBeUndefined();
  const reloaded = (await new ConfigManager(configPath).load()).kbLanMcp!;
  expect(reloaded.allowCidrs).toBeUndefined(); expect(reloaded.maxSessions).toBe(8);
  expect(allowedSource('10.1.2.3', reloaded.allowCidrs ?? DEFAULT_CIDRS)).toBe(true);
  await api('/api/kb-lan-mcp/enable', 'POST', {});
  await vi.waitFor(async () => expect((await api('/api/kb-lan-mcp/status')).state).toBe('running'), { timeout: 5000 });
  await main.close();
  const restarted = await startServer({ configPath, port: 0, desktopMode: true, desktopToken: 'synthetic-desktop-test' });
  close.push(restarted.close);
  await vi.waitFor(async () => {
    const response = await fetch(restarted.url + '/api/kb-lan-mcp/status', { headers: { 'X-Desktop-Token': 'synthetic-desktop-test' } });
    expect((await response.json()).state).toBe('running');
  }, { timeout: 5000 });
  const afterRestart = (await new ConfigManager(configPath).load()).kbLanMcp!;
  expect(afterRestart.allowCidrs).toBeUndefined(); expect(afterRestart.maxSessions).toBe(8);
  const denyAll = await fetch(restarted.url + '/api/kb-lan-mcp/settings', { method: 'PUT', headers: { 'X-Desktop-Token': 'synthetic-desktop-test', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, allowCidrs: [] }) });
  expect(denyAll.status).toBe(200);
  expect((await new ConfigManager(configPath).load()).kbLanMcp!.allowCidrs).toEqual([]);
}, 20000);

it('actual server startup never logs options secrets', async () => {
  const root = temporary();
  const spies = ['info', 'warn', 'error', 'log'].map((key) => vi.spyOn(console, key as 'info').mockImplementation(() => {}));
  const syntheticDesktop = 'synthetic-desktop-sentinel-123';
  const syntheticUnknown = 'synthetic-unknown-sentinel-456';
  const main = await startServer({ configPath: path.join(root, 'config.json'), port: 0, desktopMode: true, desktopToken: syntheticDesktop, futureSecret: syntheticUnknown } as Parameters<typeof startServer>[0]);
  close.push(main.close);
  const output = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
  expect(output.includes(syntheticDesktop)).toBe(false);
  expect(output.includes(syntheticUnknown)).toBe(false);
}, 20000);
