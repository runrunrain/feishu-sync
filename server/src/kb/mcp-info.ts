import fs from 'node:fs';
import path from 'node:path';
import { serverDistRoot } from '../agent/agent-assets.js';
import type { KbMcpStdioInfo } from '../types/agent-knowledge.js';
import { runtimeExecutable } from '../modules/runtime-executable.js';
import { resolveDataRoot } from '../modules/data-root.js';

/** The same executable and arguments are used for copying and installing MCP. */
export function kbMcpInfo(kbRoot: string, rawCatalog?: string): KbMcpStdioInfo {
  const root = serverDistRoot();
  const dist = path.basename(root) === 'src' ? path.join(root, '..', 'dist') : root;
  const script = path.join(dist, 'mcp', 'kb-mcp.cjs');
  const env: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  const dataRootArgs = process.env.FEISHU_SYNC_HOME?.trim() ? ['--data-root', path.resolve(resolveDataRoot())] : [];
  const entry = {
    command: runtimeExecutable(),
    args: [script, '--kb-root', kbRoot, ...(rawCatalog ? ['--raw-catalog', rawCatalog] : []), ...dataRootArgs],
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
