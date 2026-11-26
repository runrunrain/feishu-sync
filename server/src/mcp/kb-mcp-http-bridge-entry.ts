/** Local stdio launcher entry for shared Agent config and WSL; never exposes the token. */
import { LanTokenStore } from '../kb-lan/token-store.js';
import { startHttpStdioBridge } from './kb-mcp-http-bridge.js';

async function main(): Promise<void> {
  const dataRoot = process.env.FEISHU_SYNC_BRIDGE_HOME?.trim();
  const port = Number(process.env.FEISHU_SYNC_BRIDGE_PORT ?? '47392');
  if (!dataRoot || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_bridge_configuration');
  const token = new LanTokenStore(dataRoot, 'kb-local-mcp.json').reveal();
  if (!token) throw new Error('local_mcp_credential_unavailable');
  const bridge = await startHttpStdioBridge({
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    token,
    onError: () => console.error('[kb-mcp-bridge] 本机 HTTP MCP 连接失败，请检查 Feishu Sync 的本机服务。'),
  });
  const close = () => { void bridge.close(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
void main().catch(() => {
  console.error('[kb-mcp-bridge] 无法启动，请检查本机 MCP 服务及其安装配置。');
  process.exitCode = 1;
});
