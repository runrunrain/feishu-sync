import { afterAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { buildDefaultAgentConfig } from '../src/types/agent-knowledge.js';
import { PiRpcProcess, buildPiProcessEnv } from '../src/agent/pi-rpc-process.js';
import { piExtensionPath } from '../src/agent/agent-assets.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-credential-isolation-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
it('Pi home应用隔离，正常Pi模型配置只读复用，无通用插件加载/认证复制/全局设置写入', async (ctx) => {
  const runtime = await new PiRuntimeResolver().resolveRuntime(buildDefaultAgentConfig(root));
  if (!runtime.nodePath || !runtime.piCliPath) { ctx.skip(); return; }
  const shared = path.join(root, 'generic-pi'); fs.mkdirSync(path.join(shared, 'extensions'), { recursive: true });
  const files: Record<string, string> = {
    'settings.json': '{"packages":[],"autoRetry":true}',
    'auth.json': '{}',
    'models.json': JSON.stringify({ providers: { 'fixture-shared': { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'fixture-local-key', models: [{ id: 'shared-test', name: 'Shared Test', contextWindow: 8192, maxTokens: 1024 }] } } }),
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(shared, name), content);
  const marker = path.join(root, 'unexpected-global-plugin');
  fs.writeFileSync(path.join(shared, 'extensions/global.js'), `import fs from 'node:fs'; export default function(){fs.writeFileSync(${JSON.stringify(marker)},'loaded');}`);
  const api = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const env = buildPiProcessEnv({ mode: 'pi-agent-dir', dataRoot: root, parentEnv: { PATH: process.env.PATH, HOME: process.env.HOME, PI_CODING_AGENT_DIR: shared },
    agentUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, runToken: 'fixture-only' });
  env.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT = runtime.piPackageRoot!;
  expect(env.PI_CODING_AGENT_DIR).not.toBe(shared);
  const rpc = new PiRpcProcess({ nodePath: runtime.nodePath, piCliPath: runtime.piCliPath, extensionPath: piExtensionPath()!, tools: [], noTools: true, noSession: true,
    cwd: path.join(root, 'empty'), env });
  try {
    await rpc.start();
    const { models } = await rpc.probeState(); expect(models).toContain('fixture-shared/shared-test');
    await rpc.sendCommand('set_auto_retry', { enabled: false });
    for (const [name, content] of Object.entries(files)) expect(fs.readFileSync(path.join(shared, name), 'utf8')).toBe(content);
    expect(fs.existsSync(marker)).toBe(false);
    const localAuth = path.join(env.PI_CODING_AGENT_DIR!, 'auth.json');
    if (fs.existsSync(localAuth)) expect(fs.readFileSync(localAuth, 'utf8')).not.toContain('fixture-local-key');
    expect(fs.existsSync(path.join(shared, 'models-store.json'))).toBe(false);
  } finally { await rpc.terminate(); await new Promise<void>((resolve) => api.close(() => resolve())); }
}, 45000);
