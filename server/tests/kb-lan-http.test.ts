/** Real HTTP + MCP SDK, with explicitly synthetic transport-only tool handlers.
 * These are NOT integration evidence for the not-yet-provided KB engine/tools.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHttpGateway, type HttpGatewayOptions } from '../src/kb-lan/http-gateway.js';
import { DEFAULT_CIDRS } from '../src/kb-lan/network.js';
import { tokenDigest } from '../src/kb-lan/token-store.js';

const token = 'fskb_' + 'a'.repeat(43);
const gateways: ReturnType<typeof createHttpGateway>[] = [];
const clients: Client[] = [];
const initBody = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } };
const records: Record<string, unknown>[] = [];
let release = 'r1';
async function start(patch: Partial<HttpGatewayOptions> = {}) {
  const gateway = createHttpGateway({ host: '127.0.0.1', port: 0, maxSessions: 16, allowCidrs: DEFAULT_CIDRS, digests: [tokenDigest(token)], emit: (e) => records.push(e), register(server, state) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'get_release_info', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      const notice = state.lastServedCurrent && state.lastServedCurrent !== release ? 'changed' : undefined;
      state.lastServedCurrent = release;
      return { content: [{ type: 'text', text: JSON.stringify({ releaseId: release, notice }) }] };
    });
  }, ...patch });
  gateways.push(gateway); await gateway.listen();
  return { gateway, url: `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}/mcp` };
}
const headers = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra });
async function initialize(url: string) {
  const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(initBody) });
  expect(res.status).toBe(200); await res.text(); return res.headers.get('mcp-session-id')!;
}
afterEach(async () => { await Promise.allSettled(clients.splice(0).map((c) => c.close())); await Promise.all(gateways.splice(0).map((g) => g.close())); records.length = 0; release = 'r1'; });
describe('LAN HTTP security, actual sockets', () => {
  it('is closed until listened, only /mcp, GET405, standard Bearer401 without OAuth metadata', async () => {
    const { gateway, url } = await start();
    expect(gateway.server.headersTimeout).toBe(10_000); expect(gateway.server.requestTimeout).toBe(60_000); expect(gateway.server.keepAliveTimeout).toBe(5000);
    for (const supplied of ['', 'Bearer wrong', 'Bearer desktop', 'Bearer cli']) {
      const res = await fetch(url, { method: 'POST', headers: headers({ Authorization: supplied }), body: JSON.stringify(initBody) });
      expect(res.status).toBe(401); expect(res.headers.get('www-authenticate')).toBe('Bearer realm="feishu-sync-kb"'); expect(await res.text()).not.toContain('resource_metadata');
    }
    const get = await fetch(url, { headers: headers() }); expect(get.status).toBe(405);
    const other = await fetch(url.replace('/mcp', '/api/config')); expect(other.status).toBe(404);
    const discovery = await fetch(url.replace('/mcp', '/.well-known/oauth-protected-resource')); expect(discovery.status).toBe(404);
    const origin = await fetch(url, { headers: headers({ Origin: 'http://evil.example' }) }); expect(origin.status).toBe(403);
    const foreign = await fetch(url, { headers: { 'X-Desktop-Token': token, 'X-Cli-Token': token } }); expect(foreign.status).toBe(401);
    expect((await fetch(url, { headers: headers({ 'X-Cli-Token': 'foreign' }) })).status).toBe(401);
    expect(records.filter((e) => e.event === 'foreign_token_header')).toHaveLength(2);
    await gateway.close();
    await expect(fetch(url, { headers: headers() })).rejects.toThrow();
  });
  it('checks socket source before Origin/auth, and ignores forwarded addresses', async () => {
    const { url } = await start({ allowCidrs: ['10.0.0.0/8'] });
    const response = await fetch(url, { headers: headers({ 'X-Forwarded-For': '10.1.2.3', Origin: 'http://evil' }) });
    expect(response.status).toBe(403); expect(await response.text()).toContain('kb_lan_forbidden_source');
    expect(records.map((r) => r.event)).toEqual(['forbidden_source']);
  });
  it('blocks IP for five minutes after ten authentication failures, even correct bearer', async () => {
    let clock = 0; const { url } = await start({ now: () => clock });
    for (let i = 0; i < 10; i++) { const res = await fetch(url, { headers: headers({ Authorization: 'Bearer wrong' }) }); expect(res.status).toBe(401); }
    expect((await fetch(url, { headers: headers() })).status).toBe(429);
    clock = 300_001; expect((await fetch(url, { headers: headers() })).status).toBe(405);
  });
  it('limits declared and chunked bodies to 64KB, without creating a session', async () => {
    const { url, gateway } = await start();
    const large = await fetch(url, { method: 'POST', headers: headers(), body: ' '.repeat(65_537) }); expect(large.status).toBe(413);
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers: headers() }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.write(' '.repeat(40_000)); req.end(' '.repeat(30_000));
    });
    expect(chunked).toBe(413); expect(gateway.metrics().sessions).toBe(0);
  });
});
describe('stateful MCP sessions on real HTTP', () => {
  it('session requires bearer each time, IP binding, JSON responses, TTL, DELETE', async () => {
    let clock = 0; const { url } = await start({ now: () => clock, sessionTtlMs: 100 });
    const id = await initialize(url); expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect((await fetch(url, { method: 'DELETE', headers: headers({ 'Mcp-Session-Id': 'unknown' }) })).status).toBe(404);
    expect((await fetch(url, { method: 'DELETE', headers: { 'Mcp-Session-Id': id } })).status).toBe(401);
    clock = 101; expect((await fetch(url, { method: 'DELETE', headers: headers({ 'Mcp-Session-Id': id }) })).status).toBe(404);
    const next = await initialize(url);
    const deleted = await fetch(url, { method: 'DELETE', headers: headers({ 'Mcp-Session-Id': next }) }); expect(deleted.status).toBe(200);
    expect((await fetch(url, { method: 'DELETE', headers: headers({ 'Mcp-Session-Id': next }) })).status).toBe(404);
  });
  it('enforces source-IP binding (changed socket address fixture, no second device)', async () => {
    const { url, gateway } = await start(); const id = await initialize(url);
    gateway.server.prependListener('request', (req) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '127.0.0.2', configurable: true });
    });
    const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers: headers({ 'Mcp-Session-Id': id, 'X-Forwarded-For': '127.0.0.1' }) }, (res) => {
        let text = ''; res.on('data', (c) => text += c); res.on('end', () => resolve({ status: res.statusCode!, text }));
      });
      req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    });
    expect(response.status).toBe(404);
  });
  it('caps concurrent initialize reservations and evicts the oldest >5-minute idle session', async () => {
    let clock = 0; const { url, gateway } = await start({ maxSessions: 1, now: () => clock });
    const responses = await Promise.all([0, 1].map(() => fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(initBody) })));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 503]);
    const id = responses.find((r) => r.status === 200)!.headers.get('mcp-session-id')!;
    await Promise.all(responses.map((r) => r.text())); expect(gateway.metrics().sessions).toBe(1);
    clock = 300_001; const next = await initialize(url); expect(next).not.toBe(id);
    expect((await fetch(url, { method: 'DELETE', headers: headers({ 'Mcp-Session-Id': id }) })).status).toBe(404);
    expect(records.some((e) => e.event === 'session_evicted')).toBe(true);
  });
  it('SDK multi-client calls keep separate registration state; audit excludes query contents', async () => {
    const { url } = await start();
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: 'synthetic-transport-fixture', version: '1' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: headers() } }));
    }
    const call = async (c: Client) => JSON.parse(((await c.callTool({ name: 'get_release_info', arguments: { query: 'PRIVATE_QUERY' } })).content as Array<{ text: string }>)[0].text);
    expect(await call(clients[0])).toEqual({ releaseId: 'r1' }); expect(await call(clients[1])).toEqual({ releaseId: 'r1' });
    release = 'r2'; expect(await call(clients[0])).toEqual({ releaseId: 'r2', notice: 'changed' }); expect(await call(clients[0])).toEqual({ releaseId: 'r2' });
    expect(await call(clients[1])).toEqual({ releaseId: 'r2', notice: 'changed' });
    expect(JSON.stringify(records)).not.toContain('PRIVATE_QUERY');
    expect(records.filter((e) => e.event === 'tool_call')).toHaveLength(5);
  });
});
