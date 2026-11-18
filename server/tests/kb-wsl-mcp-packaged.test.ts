import { beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parse as parseToml } from 'smol-toml';
import { createHttpGateway } from '../src/kb-lan/http-gateway.js';
import { LanTokenStore, tokenDigest } from '../src/kb-lan/token-store.js';
import { McpClientInstaller } from '../src/kb/mcp-client-installer.js';
import { createWslMcpSupport } from '../src/kb/wsl-mcp-install.js';

beforeAll(async () => {
  if (process.platform !== 'win32') return;
  const { bundleWslBridge } = await import('../scripts/lib/mcp-bundle.mjs');
  await bundleWslBridge();
});

it.skipIf(process.platform !== 'win32')('一键安装生成的 Windows 启动器真实连接 HTTP 网关并保留其他配置', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-mcp-package-'));
  const home = path.join(root, 'home'); const dataRoot = path.join(root, 'data');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true }); fs.mkdirSync(dataRoot);
  const config = path.join(home, '.codex', 'config.toml');
  const original = '[mcp_servers.windows]\nurl = "http://127.0.0.1:47392/mcp"\n[mcp_servers.lan]\nurl = "http://192.168.1.20:47391/mcp"\n';
  fs.writeFileSync(config, original);
  const store = new LanTokenStore(dataRoot, 'kb-local-mcp.json'); store.ensure();
  const token = store.reveal(); if (!token) throw new Error('fixture token missing');
  const gateway = createHttpGateway({
    host: '127.0.0.1', port: 0, maxSessions: 4, allowCidrs: ['127.0.0.1/32'], digests: [tokenDigest(token)],
    register: (server) => {
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'fixture_lookup', description: '真实桥接', inputSchema: { type: 'object', properties: {} } }] }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: '来自本机 HTTP 网关' }] }));
    },
  });
  await gateway.listen();
  const address = gateway.server.address(); if (!address || typeof address === 'string') throw new Error('gateway address missing');
  const support = createWslMcpSupport(dataRoot);
  support.resolve = () => ({ path: config, linuxPath: '/home/fixture/.codex/config.toml', distro: 'fixture' });
  const installer = new McpClientInstaller({ homeDir: home, dataRoot, wsl: support,
    info: () => ({ available: true, url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: `Bearer ${token}` }, snippet: '' }),
  });
  let client: Client | undefined;
  try {
    expect(installer.install('codex-wsl').state).toBe('installed');
    const parsed = parseToml(fs.readFileSync(config, 'utf8')) as any;
    expect(parsed.mcp_servers.windows.url).toBe('http://127.0.0.1:47392/mcp');
    expect(parsed.mcp_servers.lan.url).toBe('http://192.168.1.20:47391/mcp');
    const entry = parsed.mcp_servers['feishu-kb-wsl'];
    expect(JSON.stringify(entry)).not.toContain(token);
    // cmd.exe must not parse metacharacters in an application's installation path.
    const special = path.join(root, '中文 & ! % (目录)'); fs.mkdirSync(special);
    const shim = path.join(special, 'kb-mcp-wsl.cmd'); fs.copyFileSync(entry.env.FEISHU_SYNC_BRIDGE_SHIM, shim);
    entry.env.FEISHU_SYNC_BRIDGE_SHIM = shim;
    const runtime = path.join(special, 'node & ! %.exe'); fs.copyFileSync(process.execPath, runtime);
    const bundle = path.join(special, 'bridge & ! %.cjs'); fs.copyFileSync(entry.env.FEISHU_SYNC_BRIDGE_BUNDLE, bundle);
    entry.env.FEISHU_SYNC_BRIDGE_APP = runtime; entry.env.FEISHU_SYNC_BRIDGE_BUNDLE = bundle;
    client = new Client({ name: 'packaged-wsl-fixture', version: '1' });
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...getDefaultEnvironment(), ...entry.env }, stderr: 'pipe' }));
    expect((await client.listTools()).tools[0].name).toBe('fixture_lookup');
    const result = await client.callTool({ name: 'fixture_lookup', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect((result.content as Array<{ text?: string }>)[0].text).toMatch(/来自本机 HTTP 网关/);
    await client.close(); client = undefined;
    expect(installer.remove('codex-wsl').state).toBe('not_installed');
    expect(fs.readFileSync(config, 'utf8')).toBe(original);
  } finally {
    await client?.close(); await gateway.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 20_000);
