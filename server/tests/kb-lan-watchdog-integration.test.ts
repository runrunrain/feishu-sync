/** Actual HTTP grep -> blocked regex -> parent watchdog -> CJS child restart.
 * Synthetic release and loopback only; shortened parent thresholds are injected.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { KbLanGatewayManager } from '../src/kb-lan/gateway-manager.js';
import { defaultLanConfig } from '../src/kb-lan/network.js';
import type { Config } from '../src/types/index.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';

const roots: string[] = []; const managers: KbLanGatewayManager[] = []; const clients: Client[] = [];
beforeAll(async () => { const { bundleGateway } = await import('../scripts/lib/mcp-bundle.mjs'); await bundleGateway(); });
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function freePort() {
  const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p;
}
async function connect(url: string, token: string) {
  const client = new Client({ name: 'watchdog-real-tool-test', version: '1' }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
it('real grep regex blocks child, watchdog kills and new child serves calls', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-real-redos-'))); roots.push(root);
  const kb = path.join(root, 'kb'), port = await freePort();
  writeSearchRelease(kb, 'r1', [{ path: 'fixture.md', title: 'fixture', body: '# fixture\n' + 'a'.repeat(60) + 'b\n' }]);
  let config = { standardKb: { outputRoot: kb }, kbLanMcp: { ...defaultLanConfig(), bindAddress: '127.0.0.1', port } } as Config;
  const children: ChildProcess[] = [];
  const manager = new KbLanGatewayManager({ dataRoot: root, artifact: path.resolve('dist/mcp/kb-mcp-gateway.cjs'),
    config: { getConfig: () => config, updateConfig: async (patch) => { config = { ...config, ...patch }; return config; } },
    spawn: ((cmd: string, args: string[], opts: any) => { const child = spawn(cmd, args, opts); children.push(child); return child; }) as typeof spawn,
    timing: { tickMs: 100, heartbeatMs: 3000, driftMs: 5000, backoffMs: 100 }, localHostname: () => null });
  managers.push(manager); await manager.start(); await manager.enable({});
  await vi.waitFor(() => expect(manager.status().state).toBe('running'), { timeout: 5000, interval: 25 });
  const token = manager.reveal().token!; const url = `http://127.0.0.1:${port}/mcp`;
  const client = await connect(url, token);
  const initial = await client.callTool({ name: 'get_release_info', arguments: {} }); expect(initial.isError).not.toBe(true);
  const before = performance.now();
  const pending = client.callTool({ name: 'grep_knowledge', arguments: { pattern: '(a|aa)+$', mode: 'regex' } }).then(() => 'unexpected-success', () => 'disconnected');
  await vi.waitFor(() => expect(manager.audit.recent().some((entry) => entry.event === 'watchdog_kill')).toBe(true), { timeout: 7000, interval: 25 });
  const kill = manager.audit.recent().find((entry) => entry.event === 'watchdog_kill')!;
  expect(kill.session).toMatch(/^[a-f0-9-]{8}$/);
  await vi.waitFor(() => { expect(children.length).toBeGreaterThan(1); expect(manager.status().state).toBe('running'); }, { timeout: 5000, interval: 25 });
  expect(children[0].signalCode).toBe('SIGKILL');
  expect(await pending).toBe('disconnected');
  const recovered = await connect(url, token);
  const result = await recovered.callTool({ name: 'grep_knowledge', arguments: { pattern: 'fixture', mode: 'literal' } });
  expect(result.isError).not.toBe(true);
  const elapsed = performance.now() - before;
  expect(elapsed).toBeLessThan(15_000);
  await vi.waitFor(() => expect(manager.audit.recent().some((entry) => entry.event === 'index_build' && entry.releaseId === 'r1' && typeof entry.indexBuildMs === 'number')).toBe(true));
  const records = manager.audit.recent();
  const built = records.filter((entry) => entry.event === 'index_build' && entry.releaseId === 'r1');
  expect(built.length).toBe(2); // exactly once in each real child, including warmup
  expect(JSON.stringify(records)).not.toContain('(a|aa)');
  console.info(JSON.stringify({ test: 'real-grep-watchdog', elapsedMs: elapsed, injectedHeartbeatMs: 3000, injectedTickMs: 100, childPids: children.map((c) => c.pid), signal: children[0].signalCode, indexBuilds: built.map((e) => e.indexBuildMs) }));
}, 20_000);
