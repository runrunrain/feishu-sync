/** Read-only stdio entry. The isolated LAN gateway uses the same standard/raw registration.
 * Single-file Node20 CJS bundle. Only probes the loopback desktop API when required.
 */
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { KbQueryService } from '../kb/search/kb-query-service.js';
import { KB_MCP_INSTRUCTIONS, RAW_MCP_INSTRUCTIONS, registerKbTools } from './kb-mcp-tools.js';
import { RawQueryService } from '../kb/raw-query-service.js';
import fs from 'node:fs';
import { resolveDataRoot } from '../modules/data-root.js';
import { canRunLocalMcp, readLocalMcpConfig } from '../kb/local-mcp-policy.js';

function readPathArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个路径`);
  return path.resolve(value);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dataRoot = readPathArg(argv, '--data-root') ?? resolveDataRoot();
  const unavailable = '本机 MCP 独立运行已关闭。请先打开 Feishu Sync，或在设置中允许独立运行。';
  if (!await canRunLocalMcp(dataRoot)) throw new Error(unavailable);
  const outputRoot = readLocalMcpConfig(dataRoot).standardKb?.outputRoot;
  const configuredRoot = typeof outputRoot === 'string' && outputRoot.trim() ? path.resolve(outputRoot) : undefined;
  const kbRoot = readPathArg(argv, '--kb-root') ?? configuredRoot ?? path.join(dataRoot, 'standard-kb');
  let rawFile = readPathArg(argv, '--raw-catalog');
  // Upgrade existing app-owned stdio configs without touching the client's other settings.
  // An explicitly unrelated --kb-root must never inherit this application's raw library.
  if (!rawFile && configuredRoot === kbRoot) {
    const candidate = path.join(dataRoot, 'mcp', 'raw-catalog.json');
    if (fs.existsSync(candidate)) rawFile = candidate;
  }
  const raw = rawFile ? new RawQueryService(rawFile) : undefined;
  const service = new KbQueryService(kbRoot, {
    onWarmError: (error) => console.error('[kb-mcp] prewarm:', error instanceof Error ? error.message : String(error)),
  });
  const server = new Server({ name: 'feishu-sync-kb', version: '2.0.0' }, {
    capabilities: { tools: {} }, instructions: KB_MCP_INSTRUCTIONS + (raw ? RAW_MCP_INSTRUCTIONS : ''),
  });
  registerKbTools(server, service, {}, raw);
  await server.connect(new StdioServerTransport());
  const policyTimer = setInterval(async () => {
    if (await canRunLocalMcp(dataRoot)) return;
    console.error('[kb-mcp]', unavailable);
    await server.close();
  }, 2000);
  policyTimer.unref();
  server.onclose = () => clearInterval(policyTimer);
  console.error('[kb-mcp] listening on stdio (toolsVersion=2)');
}
main().catch((error: unknown) => { console.error('[kb-mcp] fatal:', error); process.exitCode = 1; });
