/** Read-only stdio entry. The same seven tools are registered by the isolated LAN gateway.
 * Single-file Node20 CJS bundle: no SQLite/native modules, outbound network or file writes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { KbQueryService } from '../kb/search/kb-query-service.js';
import { KB_MCP_INSTRUCTIONS, registerKbTools } from './kb-mcp-tools.js';

function resolveKbRoot(argv: string[]): string {
  const index = argv.indexOf('--kb-root');
  if (index >= 0) {
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--kb-root 需要一个目录');
    return path.resolve(argv[index + 1]);
  }
  const dataRoot = process.env.FEISHU_SYNC_HOME?.trim() || path.join(os.homedir(), '.feishu-sync');
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf8')) as { standardKb?: { outputRoot?: unknown } };
    if (typeof config.standardKb?.outputRoot === 'string' && config.standardKb.outputRoot.trim()) return path.resolve(config.standardKb.outputRoot);
  } catch { /* Missing configuration has the same read-only, not-published state as an empty library. */ }
  return path.join(dataRoot, 'standard-kb');
}

async function main(): Promise<void> {
  const service = new KbQueryService(resolveKbRoot(process.argv.slice(2)), {
    onWarmError: (error) => console.error('[kb-mcp] prewarm:', error instanceof Error ? error.message : String(error)),
  });
  const server = new Server({ name: 'feishu-sync-kb', version: '2.0.0' }, {
    capabilities: { tools: {} }, instructions: KB_MCP_INSTRUCTIONS,
  });
  registerKbTools(server, service, {});
  await server.connect(new StdioServerTransport());
  console.error('[kb-mcp] listening on stdio (toolsVersion=2)');
}
main().catch((error: unknown) => { console.error('[kb-mcp] fatal:', error); process.exitCode = 1; });
