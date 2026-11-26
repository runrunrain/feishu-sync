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
import { sharedBridgeHotfixEntry } from '../src/kb/local-mcp-bridge-entry.js';
import { createWslMcpSupport } from '../src/kb/wsl-mcp-install.js';

beforeAll(async () => {
  if (process.platform !== 'win32') return;
  const { bundleWslBridge } = await import('../scripts/lib/mcp-bundle.mjs');
  await bundleWslBridge();
});

it.skipIf(process.platform !== 'win32')('迁移临时桥接并通过应用安装的 Windows 启动器自动重连', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-mcp-package-'));
  const home = path.join(root, 'home'); const dataRoot = path.join(root, 'data');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true }); fs.mkdirSync(dataRoot);
  const config = path.join(home, '.codex', 'config.toml');
  const original = '[mcp_servers.windows]\nurl = "http://127.0.0.1:47392/mcp"\n[mcp_servers.lan]\nurl = "http://192.168.1.20:47391/mcp"\n';
  fs.writeFileSync(config, original);
  const store = new LanTokenStore(dataRoot, 'kb-local-mcp.json'); store.ensure();
  const token = store.reveal(); if (!token) throw new Error('fixture token missing');
  let clock = 0;
  let handshakes = 0;
  const gateway = createHttpGateway({
    host: '127.0.0.1', port: 0, maxSessions: 4, allowCidrs: ['127.0.0.1/32'], digests: [tokenDigest(token)],
    now: () => clock, sessionTtlMs: 100,
    emit: ({ event }) => { if (event === 'session_open') handshakes++; },
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
    // The previous shared HTTP entry used the same JSON shape as the Claude entry.
    expect(installer.install('claude').state).toBe('installed');
    const sharedFile = path.join(home, '.agents', '.mcp.json');
    fs.mkdirSync(path.dirname(sharedFile));
    const receiptFile = path.join(dataRoot, 'mcp-client-installs.json');
    const receipts = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const hotfix = { type: 'stdio', ...sharedBridgeHotfixEntry(dataRoot, String(address.port))! };
    const other = { command: 'other-mcp' };
    const writeShared = (entry: unknown) => fs.writeFileSync(sharedFile, JSON.stringify({ mcpServers: { 'feishu-kb': entry, other } }));
    writeShared(hotfix);
    const sharedStatus = () => installer.status().find(({ target }) => target === 'agents')?.state;
    expect(sharedStatus()).toBe('conflict');
    receipts.entries.agents = { ...receipts.entries.claude, path: sharedFile };
    fs.writeFileSync(receiptFile, JSON.stringify(receipts));
    writeShared({ ...hotfix, args: ['user-override'] });
    expect(sharedStatus()).toBe('modified');
    installer.migrateManaged();
    expect(sharedStatus()).toBe('modified');
    writeShared(hotfix);
    expect(sharedStatus()).toBe('needs_update');
    installer.migrateManaged();
    expect(sharedStatus()).toBe('installed');

    const sharedConfig = JSON.parse(fs.readFileSync(sharedFile, 'utf8')).mcpServers;
    expect(sharedConfig.other).toEqual(other);
    const shared = sharedConfig['feishu-kb'];
    expect(shared).toMatchObject({ type: 'stdio', command: 'cmd.exe' });
    expect(JSON.stringify(shared)).not.toContain(token);
    client = new Client({ name: 'packaged-shared-fixture', version: '1' });
    await client.connect(new StdioClientTransport({ command: shared.command, args: shared.args, env: shared.env, stderr: 'pipe' }));
    expect(handshakes).toBe(1);
    clock += 101;
    const replay = await client.callTool({ name: 'fixture_lookup', arguments: {} });
    expect(replay.isError).not.toBe(true);
    expect(handshakes).toBe(2);
    await client.close(); client = undefined;

    expect(installer.install('codex-wsl').state).toBe('installed');
    const parsed = parseToml(fs.readFileSync(config, 'utf8')) as any;
    expect(parsed.mcp_servers.windows.url).toBe('http://127.0.0.1:47392/mcp');
    expect(parsed.mcp_servers.lan.url).toBe('http://192.168.1.20:47391/mcp');
    const entry = parsed.mcp_servers['feishu-kb-wsl'];
    expect(entry).toMatchObject({ command: shared.command, args: shared.args, env: {
      FEISHU_SYNC_BRIDGE_BUNDLE: shared.env.FEISHU_SYNC_BRIDGE_BUNDLE,
      WSLENV: shared.env.WSLENV,
    } });
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
