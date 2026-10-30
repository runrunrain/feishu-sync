import fs from 'node:fs';
import path from 'node:path';
import { serverDistRoot } from '../agent/agent-assets.js';
import type { KbMcpInfoDto } from '../types/agent-knowledge.js';

/** The same executable and arguments are used for copying and installing MCP. */
export function kbMcpInfo(kbRoot: string): KbMcpInfoDto {
  const root = serverDistRoot();
  const dist = path.basename(root) === 'src' ? path.join(root, '..', 'dist') : root;
  const script = path.join(dist, 'mcp', 'kb-mcp.cjs');
  const env: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  const entry = {
    command: process.execPath,
    args: [script, '--kb-root', kbRoot],
    ...(Object.keys(env).length ? { env } : {}),
  };
  return {
    available: fs.existsSync(script),
    command: entry.command,
    args: entry.args,
    env,
    alternative: { command: 'node', args: entry.args, note: '外部 Node ≥20 亦可运行（kb-mcp.cjs 无原生依赖、不打开 SQLite）' },
    snippet: JSON.stringify({ mcpServers: { 'feishu-kb': entry } }, null, 2),
  };
}
