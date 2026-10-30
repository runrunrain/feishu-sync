/** Dedicated desktop API + generic config/ops bypass tests, temporary roots only. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { KbLanGatewayManager } from '../src/kb-lan/gateway-manager.js';
import { defaultLanConfig } from '../src/kb-lan/network.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import { kbLanMcpRoutes } from '../src/routes/kb-lan-mcp.js';
import { configRoutes } from '../src/routes/config.js';
import { findOpsCommand } from '../src/ops/command-table.js';

const roots: string[] = []; const managers: KbLanGatewayManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.close())); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-lan-config-'))); roots.push(root);
  const config = new ConfigManager(path.join(root, 'config.json'));
  await config.load();
  const manager = new KbLanGatewayManager({ dataRoot: root, config, artifact: path.join(root, 'absent.cjs'), interfaces: () => [], localHostname: () => null }); managers.push(manager);
  const app = new Hono(); app.use('*', async (c, next) => { (c as any).configManager = config; await next(); });
  app.route('/', kbLanMcpRoutes({ manager, desktopToken: 'desktop-secret' })); app.route('/', configRoutes);
  return { app, config, manager, root };
}
function request(app: Hono, method: string, route: string, body?: unknown, headers: Record<string, string> = { 'X-Desktop-Token': 'desktop-secret' }) {
  return app.request(`http://127.0.0.1${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const paths = [['GET', '/status'], ['POST', '/enable'], ['POST', '/disable'], ['PUT', '/settings'], ['POST', '/token/rotate'], ['POST', '/token/reveal'], ['GET', '/audit']] as const;
describe('desktop-only dedicated LAN management', () => {
  it('all seven endpoints reject absent/wrong/LAN tokens and explicit CLI actors', async () => {
    const { app } = await setup();
    for (const [method, suffix] of paths) {
      const route = '/api/kb-lan-mcp' + suffix;
      for (const headers of [{}, { 'X-Desktop-Token': 'wrong' }, { Authorization: 'Bearer fskb_' + 'a'.repeat(43) }, { 'X-Desktop-Token': 'fskb_' + 'a'.repeat(43) }]) expect((await request(app, method, route, undefined, headers)).status).toBe(401);
      for (const headers of [{ 'X-Desktop-Token': 'desktop-secret', 'X-Feishu-Sync-Actor': 'cli' }, { 'X-Desktop-Token': 'desktop-secret', 'X-Cli-Token': 'cli-secret' }]) {
        const res = await request(app, method, route, undefined, headers); expect(res.status).toBe(403); expect(await res.text()).toContain('kb_lan_forbidden_actor');
      }
    }
  });
  it('status matches the table; enable/reveal/rotate/disable and settings validate server-side', async () => {
    const { app, manager, config } = await setup();
    const status = await request(app, 'GET', '/api/kb-lan-mcp/status');
    expect(Object.keys(await status.json()).sort()).toEqual(['enabled', 'state', 'bindAddress', 'resolvedHost', 'port', 'urls', 'sessions', 'inflight', 'queued', 'heapUsed', 'lastError', 'tokenMasked', 'interfaces'].sort());
    expect((await request(app, 'POST', '/api/kb-lan-mcp/enable', { bindAddress: '8.8.8.8' })).status).toBe(400);
    expect((await request(app, 'POST', '/api/kb-lan-mcp/enable', { bindAddress: '127.0.0.1', port: 47391 })).status).toBe(200);
    expect(manager.status().state).toBe('artifact_missing');
    expect(manager.status().lastError).toBe('artifact_missing');
    const reveal = await request(app, 'POST', '/api/kb-lan-mcp/token/reveal'); expect(reveal.headers.get('cache-control')).toContain('no-store');
    const old = (await reveal.json()).token;
    expect((await request(app, 'POST', '/api/kb-lan-mcp/token/rotate')).status).toBe(200); expect(manager.reveal().token).not.toBe(old);
    const invalid = await request(app, 'PUT', '/api/kb-lan-mcp/settings', { bindAddress: '0.0.0.0', port: 47391, maxSessions: 2, allowCidrs: ['::/0'] }); expect(invalid.status).toBe(400);
    expect((await request(app, 'PUT', '/api/kb-lan-mcp/settings', { bindAddress: '0.0.0.0', port: 47391, maxSessions: 2, allowCidrs: ['127.0.0.0/8'] })).status).toBe(200);
    expect(config.getConfig()?.kbLanMcp?.allowCidrs).toEqual(['127.0.0.0/8']);
    expect((await request(app, 'PUT', '/api/kb-lan-mcp/settings', { bindAddress: '127.0.0.1', port: 47391, maxSessions: 2 })).status).toBe(200);
    expect(config.getConfig()?.kbLanMcp?.allowCidrs).toBeUndefined();
    expect(Array.isArray(await (await request(app, 'GET', '/api/kb-lan-mcp/audit')).json())).toBe(true);
    expect((await request(app, 'GET', '/api/kb-lan-mcp/audit?limit=201')).status).toBe(400);
    expect((await request(app, 'POST', '/api/kb-lan-mcp/disable', { revokeToken: true })).status).toBe(200);
    expect(manager.status().state).toBe('disabled'); expect(manager.reveal().token).toBeNull();
  });
});
describe('generic config and shared command table cannot enable LAN sharing', () => {
  it('PUT /api/config drops the entire segment for desktop, CLI-forwarded, and anonymous subjects', async () => {
    const { app, config } = await setup();
    for (const headers of [{}, { 'X-Desktop-Token': 'desktop-secret' }, { 'X-Desktop-Token': 'desktop-secret', 'X-Feishu-Sync-Actor': 'cli' }]) {
      const response = await request(app, 'PUT', '/api/config', { kbLanMcp: { enabled: true, bindAddress: '0.0.0.0', token: 'MUST_NOT_PERSIST' }, pollIntervalMinutes: 10 }, headers);
      expect(response.status).toBe(200); expect(config.getConfig()?.kbLanMcp).toEqual(defaultLanConfig());
    }
  });
  it('config.set blocks segment and every child for CLI/app_command shared definition', () => {
    const command = findOpsCommand('config.set')!; expect(command.agentExposed).toBe(true);
    for (const field of ['kbLanMcp', 'kbLanMcp.enabled', 'kbLanMcp.port', 'kbLanMcp.allowCidrs', 'kbLanMcp.anything.deep']) {
      expect(() => command.request({ path: field, value: true })).toThrow(/禁止路径/);
    }
  });
  it('missing config segment is memory-only, invalid on-disk settings fail closed', async () => {
    const { config, root } = await setup();
    const file = path.join(root, 'config.json'); const raw = JSON.parse(fs.readFileSync(file, 'utf8')); delete raw.kbLanMcp;
    fs.writeFileSync(file, JSON.stringify(raw)); const before = fs.readFileSync(file, 'utf8');
    await config.load(); expect(config.getConfig()?.kbLanMcp).toEqual(defaultLanConfig()); expect(fs.readFileSync(file, 'utf8')).toBe(before);
    raw.kbLanMcp = { ...defaultLanConfig(), enabled: true, allowCidrs: ['0.0.0.0/0'] }; fs.writeFileSync(file, JSON.stringify(raw));
    await config.load(); expect(config.getConfig()?.kbLanMcp?.enabled).toBe(false);
    await expect(config.updateConfig({ kbLanMcp: { ...defaultLanConfig(), port: 80 } })).rejects.toThrow();
  });
});
