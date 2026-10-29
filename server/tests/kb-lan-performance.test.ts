/** Explicit opt-in local benchmark, not a default test or real-traffic evaluation.
 * KB_LAN_PERF_GENERATOR points to the upstream synthetic fixture generator.
 * Only loopback, temporary releases and synthetic queries; starts the actual
 * manager/CJS gateway and existing SDK bench in separate processes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { KbLanGatewayManager } from '../src/kb-lan/gateway-manager.js';
import { defaultLanConfig } from '../src/kb-lan/network.js';
import type { Config } from '../src/types/index.js';

const roots: string[] = []; const managers: KbLanGatewayManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function freePort() {
  const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p;
}
async function runBench(url: string, token: string, queries: string, count: number, parallel: number) {
  const cli = path.resolve('../node_modules/tsx/dist/cli.mjs');
  const cmd = [cli, path.resolve('scripts/kb-lan-bench.ts'), '--url', url, '--queries', queries, '--clients', String(count), '--parallel', String(parallel), '--rounds', String(count === 1 ? 30 : 10)];
  return await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, cmd, { env: { ...process.env, FEISHU_KB_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout += chunk.toString());
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); process.stdout.write(chunk); });
    child.once('error', reject); child.once('close', (code) => resolve({ stdout, stderr, code }));
  });
}
function percentile(values: number[], p: number) {
  return values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
for (const mb of [10, 30] as const) it.skipIf(!process.env.KB_LAN_PERF_GENERATOR)(`synthetic ${mb}MiB: real CJS manager, single and 3x4 load`, async () => {
  const modulePath = process.env.KB_LAN_PERF_GENERATOR!;
  const generator = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kb-lan-perf-${mb}-`))); roots.push(root);
  const kb = path.join(root, 'kb'), releaseId = `synthetic-perf-${mb}mib-v1`;
  generator.materializeSynthetic(path.join(kb, 'releases', releaseId), mb, (message: string) => console.info(message));
  fs.writeFileSync(path.join(kb, 'CURRENT.json'), JSON.stringify({ schemaVersion: 1, releaseId, publishedAt: '2026-10-29T00:00:00.000Z' }));
  const queries = path.join(root, 'queries.jsonl');
  fs.writeFileSync(queries, generator.BENCH_QUERIES.map((query: string) => JSON.stringify({ query })).join('\n') + '\n');
  const port = await freePort();
  let config = { standardKb: { outputRoot: kb }, kbLanMcp: { ...defaultLanConfig(), bindAddress: '127.0.0.1', port } } as Config;
  const manager = new KbLanGatewayManager({ dataRoot: root, artifact: path.resolve('dist/mcp/kb-mcp-gateway.cjs'),
    config: { getConfig: () => config, updateConfig: async (patch) => { config = { ...config, ...patch }; return config; } }, localHostname: () => null });
  managers.push(manager); await manager.start();
  for (const [count, parallel] of [[1, 1], [3, 4]]) {
    const baseline = monitorEventLoopDelay({ resolution: 10 }); baseline.enable(); await sleep(1000); baseline.disable();
    const baselineP99 = baseline.percentile(99) / 1e6;
    const auditBefore = manager.audit.recent(200).length;
    const spawned = performance.now(); await manager.enable({});
    await vi.waitFor(() => expect(manager.status().state).toBe('running'), { timeout: 15_000, interval: 25 });
    const readyMs = performance.now() - spawned;
    const measured = monitorEventLoopDelay({ resolution: 10 }); measured.enable();
    const url = `http://127.0.0.1:${port}/mcp`, token = manager.reveal().token!;
    // Initiate a real first client immediately after the child's ready message,
    // before launching tsx (which could hide cold index work behind startup).
    const cold = new Client({ name: 'cold-index-benchmark', version: '1' });
    const coldAt = performance.now();
    try {
      await cold.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const response = await cold.callTool({ name: 'search_knowledge', arguments: { query: generator.BENCH_QUERIES[0] } });
      expect(response.isError).not.toBe(true);
    } finally { await cold.close(); }
    const coldClientMs = performance.now() - coldAt, coldStartMs = performance.now() - spawned;
    const bench = await runBench(url, token, queries, count, parallel);
    measured.disable();
    expect(bench.code, bench.stderr + bench.stdout).toBe(0);
    const results = JSON.parse(bench.stdout);
    await sleep(100);
    const audit = manager.audit.recent(200);
    const newCount = audit.length - auditBefore;
    const fresh = audit.slice(0, newCount);
    const calls = fresh.filter((row) => row.event === 'tool_call');
    const build = fresh.filter((row) => row.event === 'index_build');
    expect(calls.length).toBe(results.calls + count + 1);
    expect(build.length).toBe(1); expect(build[0].releaseId).toBe(releaseId);
    const queueValues = calls.map((r) => Number(r.queueMs));
    const loopP99 = measured.percentile(99) / 1e6;
    console.info(JSON.stringify({ kind: 'gateway-synthetic-benchmark', mb, bodyBytes: mb * 1024 * 1024, clients: count, parallel,
      readyMs, coldClientMs, coldStartMs, ...results, indexBuildMs: build[0].indexBuildMs, auditCalls: calls.length, queueP95Ms: percentile(queueValues, .95),
      parentLoopBaselineP99Ms: baselineP99, parentLoopLoadedP99Ms: loopP99, parentLoopDeltaP99Ms: loopP99 - baselineP99 }));
    await manager.disable();
  }
}, 180_000);
