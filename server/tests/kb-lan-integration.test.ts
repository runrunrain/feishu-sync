/** Real product chain: desktop API -> managed CJS child -> shared MCP tools -> published files.
 * Synthetic fixtures, loopback only, no production state or external network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatewayScript = path.join(serverRoot, 'dist/mcp/kb-mcp-gateway.cjs');
const stdioScript = path.join(serverRoot, 'dist/mcp/kb-mcp.cjs');
const closers: Array<() => Promise<unknown>> = [], roots: string[] = [];
beforeAll(async () => { const { bundleGateway, bundleMcp } = await import('../scripts/lib/mcp-bundle.mjs'); await bundleGateway(); await bundleMcp(); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => {}); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temporary() { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-lan-product-'))); roots.push(root); return root; }
async function freePort() {
  const socket = net.createServer(); await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>((resolve) => socket.close(() => resolve())); return port;
}
function publish(root: string, id: string) { return writeSearchRelease(root, id, [{ path: '战斗/伤害.md', docId: 'damage', title: '伤害结算', body: `# 伤害结算\n## 暴击\n暴击伤害按倍率结算。版本${id}。\n### 技能表\n| skill_id | 倍率 |\n| --- | --- |\n| 1001 | 120% |\n` }]); }
function text(response: Awaited<ReturnType<Client['callTool']>>) { return (response.content as Array<{ text: string }>)[0].text; }
async function connect(url: string, token: string) {
  const client = new Client({ name: 'product-integration', version: '2' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport); closers.push(() => client.close()); return { client, transport };
}

it('desktop manages the real gateway, three readers agree, notices are per session, rotation and disable revoke access', async () => {
  const root = temporary(), kb = path.join(root, 'standard'), port = await freePort();
  publish(kb, 'r1'); vi.stubEnv('FEISHU_SYNC_HOME', root);
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ knowledgeBaseRoot: path.join(root, 'raw'), standardKb: { outputRoot: kb }, agent: {}, cli: { enabled: false }, kbLanMcp: { enabled: false, bindAddress: '127.0.0.1', port, maxSessions: 16 } }));
  const { startServer } = await import('../src/index.js');
  const main = await startServer({ configPath, desktopMode: true, desktopToken: 'synthetic-desktop-control', hostname: '127.0.0.1', port: 0 });
  closers.push(main.close);
  const api = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(main.url + route, { method, headers: { 'X-Desktop-Token': 'synthetic-desktop-control', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status).toBe(200); return response.json();
  };
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  expect((await api('/api/kb-lan-mcp/status')).state).toBe('disabled');
  await expect(fetch(endpoint)).rejects.toThrow();
  await api('/api/kb-lan-mcp/enable', 'POST', {});
  await vi.waitFor(async () => expect((await api('/api/kb-lan-mcp/status')).state).toBe('running'), { timeout: 5000, interval: 25 });
  const tokenA = (await api('/api/kb-lan-mcp/token/reveal', 'POST')).token;
  expect(tokenA).toMatch(/^fskb_/);
  const invalidHeaders: Record<string, string>[] = [{}, { Authorization: 'Bearer wrong' }, { 'X-Desktop-Token': 'synthetic-desktop-control' }, { 'X-Cli-Token': 'foreign-fixture' }];
  for (const headers of invalidHeaders) {
    expect((await fetch(endpoint, { headers })).status).toBe(401);
  }
  expect((await fetch(endpoint, { headers: { Authorization: `Bearer ${tokenA}`, Origin: 'http://untrusted.invalid' } })).status).toBe(403);
  expect((await fetch(endpoint, { headers: { Authorization: `Bearer ${tokenA}`, 'X-Forwarded-For': '8.8.8.8' } })).status).toBe(405);
  const a = await connect(endpoint, tokenA), b = await connect(endpoint, tokenA);
  const stdio = new Client({ name: 'stdio-comparison', version: '2' });
  await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [stdioScript, '--kb-root', kb, '--raw-catalog', path.join(root, 'mcp/raw-catalog.json')], env: { ...process.env, FEISHU_SYNC_HOME: root } as Record<string, string> }));
  expect((await stdio.listTools()).tools).toEqual((await a.client.listTools()).tools);
  expect((await stdio.listTools()).tools).toHaveLength(10);
  closers.push(() => stdio.close());
  const args = { query: '暴击 伤害', limit: 10 };
  const httpSearch = JSON.parse(text(await a.client.callTool({ name: 'search_knowledge', arguments: args })));
  const stdioSearch = JSON.parse(text(await stdio.callTool({ name: 'search_knowledge', arguments: args })));
  const serverSearch = await api('/api/kb/search?q=' + encodeURIComponent(args.query) + '&limit=10');
  expect(JSON.stringify(httpSearch)).toBe(JSON.stringify(stdioSearch));
  expect(JSON.stringify(httpSearch.results)).toBe(JSON.stringify(serverSearch.results));
  for (const [name, input] of [['grep_knowledge', { pattern: '1001' }], ['get_outline', { pathPrefix: '战斗' }], ['get_knowledge', { docId: 'damage', section: '暴击' }],
    ['get_knowledge_bundle', { pathPrefix: '战斗', dryRun: true }], ['list_knowledge', {}], ['get_release_info', {}]] as Array<[string, Record<string, unknown>]>) {
    expect((await a.client.callTool({ name, arguments: input })).isError).not.toBe(true);
  }
  await b.client.callTool({ name: 'get_release_info', arguments: {} });
  publish(kb, 'r2');
  for (const session of [a, b]) {
    const changed = JSON.parse(text(await session.client.callTool({ name: 'get_release_info', arguments: {} })));
    expect(changed.releaseId).toBe('r2'); expect(changed.notice).toContain('r1 → r2');
    expect(JSON.parse(text(await session.client.callTool({ name: 'get_release_info', arguments: {} })))).not.toHaveProperty('notice');
  }
  const oldSession = a.transport.sessionId!;
  await api('/api/kb-lan-mcp/token/rotate', 'POST');
  await vi.waitFor(async () => expect((await api('/api/kb-lan-mcp/status')).state).toBe('running'), { timeout: 5000, interval: 25 });
  const tokenB = (await api('/api/kb-lan-mcp/token/reveal', 'POST')).token;
  expect(tokenB).not.toBe(tokenA);
  expect((await fetch(endpoint, { headers: { Authorization: `Bearer ${tokenA}` } })).status).toBe(401);
  expect((await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${tokenB}`, 'Mcp-Session-Id': oldSession, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }) })).status).toBe(404);
  const c = await connect(endpoint, tokenB);
  await c.client.callTool({ name: 'search_knowledge', arguments: { query: '不可记录的合成查询_1234' } });
  // Heartbeats/audit are consumed by the actual parent manager, not test fixtures.
  await vi.waitFor(async () => expect((await api('/api/kb-lan-mcp/audit?limit=200')).some((entry: { event: string }) => entry.event === 'tool_call')).toBe(true), { timeout: 3000 });
  const audit = JSON.stringify(await api('/api/kb-lan-mcp/audit?limit=200'));
  expect(audit).not.toContain(tokenA); expect(audit).not.toContain(tokenB); expect(audit).not.toContain('不可记录的合成查询_1234');
  if (process.platform !== 'win32') {
    expect(fs.statSync(path.join(root, 'secrets/kb-lan-mcp.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, 'secrets')).mode & 0o777).toBe(0o700);
  }
  await api('/api/kb-lan-mcp/disable', 'POST', { revokeToken: false }); await expect(fetch(endpoint)).rejects.toThrow();
  expect((await api('/api/kb-lan-mcp/token/reveal', 'POST')).token).toBe(tokenB);
  await api('/api/kb-lan-mcp/disable', 'POST', { revokeToken: true }); expect((await api('/api/kb-lan-mcp/token/reveal', 'POST')).token).toBeNull();
}, 20000);

const electron = path.resolve(serverRoot, '../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
it.skipIf(process.platform !== 'darwin' || !fs.existsSync(electron))('Node20/Electron RunAsNode launches the actual HTTP bundle and serves all seven tools', async () => {
  const root = temporary(), port = await freePort(); publish(root, 'r20');
  const token = 'fskb_' + crypto.randomBytes(32).toString('base64url');
  const child: ChildProcess = spawn(electron, [gatewayScript, '--kb-root', root, '--host', '127.0.0.1', '--port', String(port)], {
    env: { ELECTRON_RUN_AS_NODE: '1', KB_LAN_TOKEN_SHA256: crypto.createHash('sha256').update(token).digest('hex') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  closers.push(() => new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; } const timer = setTimeout(() => child.kill('SIGKILL'), 3000); child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); }));
  let output = ''; child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); }); child.stderr!.resume();
  await vi.waitFor(() => expect(output).toContain('"type":"ready"'), { timeout: 5000, interval: 25 });
  const { client } = await connect(`http://127.0.0.1:${port}/mcp`, token);
  expect((await client.listTools()).tools).toHaveLength(7);
  const result = JSON.parse(text(await client.callTool({ name: 'search_knowledge', arguments: { query: '暴击 伤害' } })));
  expect(result.releaseId).toBe('r20'); expect(result.results[0].docId).toBe('damage');
  const code = fs.readFileSync(gatewayScript, 'utf8'); expect(code).not.toMatch(/better-sqlite3|\.node["'`]/);
}, 10000);
