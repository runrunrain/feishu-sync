/** Build a credential-free stdio entry for the existing loopback HTTP service. */
import fs from 'node:fs';
import path from 'node:path';
import { serverDistRoot } from '../agent/agent-assets.js';
import { runtimeExecutable } from '../modules/runtime-executable.js';
import type { KbMcpInfoDto } from '../types/agent-knowledge.js';

export interface LocalMcpBridgeEntry { command: string; args: string[]; env: Record<string, string> }

function windowsBridgeEntry(env: Record<string, string>): LocalMcpBridgeEntry {
  // Delayed expansion keeps metacharacters in the installation path literal.
  // The same command can be launched from Windows or through WSL interop.
  return {
    command: 'cmd.exe', args: ['/d', '/v:on', '/c', '!FEISHU_SYNC_BRIDGE_SHIM!'],
    env: { ...env, WSLENV: Object.keys(env).join(':') },
  };
}

export function localMcpBridgeEntry(info: KbMcpInfoDto, dataRoot: string): LocalMcpBridgeEntry {
  if (!('url' in info)) throw new Error('local_http_required');
  const url = new URL(info.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp'
    || url.username || url.password || url.search || url.hash) throw new Error('invalid_local_http_endpoint');

  const root = serverDistRoot();
  const dist = path.basename(root) === 'src' ? path.join(root, '..', 'dist') : root;
  const bundle = path.join(dist, 'mcp', 'kb-mcp-http-bridge.cjs');
  if (!fs.existsSync(bundle)) throw new Error('local_bridge_not_built');
  const env: Record<string, string> = {
    FEISHU_SYNC_BRIDGE_HOME: path.resolve(dataRoot), FEISHU_SYNC_BRIDGE_PORT: url.port || '80',
  };
  const runtime = runtimeExecutable();
  if (process.platform !== 'win32') {
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    return { command: runtime, args: [bundle], env };
  }

  const shim = path.join(dist, 'mcp', 'kb-mcp-wsl.cmd');
  if (!fs.existsSync(shim)) throw new Error('local_bridge_not_built');
  return windowsBridgeEntry({
    FEISHU_SYNC_BRIDGE_SHIM: shim, FEISHU_SYNC_BRIDGE_APP: runtime, FEISHU_SYNC_BRIDGE_BUNDLE: bundle, ...env,
  });
}

/** The exact Windows launcher staged before the managed bridge shipped. */
export function sharedBridgeHotfixEntry(dataRoot: string, localPort: string): LocalMcpBridgeEntry | undefined {
  if (process.platform !== 'win32') return;
  const bin = path.resolve(dataRoot, 'bin', 'kb-mcp-bridge');
  return windowsBridgeEntry({
    FEISHU_SYNC_BRIDGE_HOME: path.resolve(dataRoot), FEISHU_SYNC_BRIDGE_PORT: localPort,
    FEISHU_SYNC_BRIDGE_SHIM: path.join(bin, 'kb-mcp-wsl.cmd'),
    FEISHU_SYNC_BRIDGE_APP: runtimeExecutable(),
    FEISHU_SYNC_BRIDGE_BUNDLE: path.join(bin, 'kb-mcp-http-bridge.cjs'),
  });
}
