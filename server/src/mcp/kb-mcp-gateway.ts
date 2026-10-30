/** LAN child entry. No file writes, SQLite, outbound HTTP, or cleartext secret. */
import { KbQueryService } from '../kb/search/kb-query-service.js';
import { KbIndexCache } from '../kb/search/kb-index-cache.js';
import type { KbIndex } from '../kb/search/index-types.js';
import { registerKbTools, KB_MCP_INSTRUCTIONS } from './kb-mcp-tools.js';
import { createHttpGateway } from '../kb-lan/http-gateway.js';
import { validateLanConfig, DEFAULT_CIDRS } from '../kb-lan/network.js';

const emit = (message: Record<string, unknown>) => process.stdout.write(JSON.stringify(message) + '\n');

/** Observe the existing cache's actual build callback, not cache hits or wait time. */
class AuditedIndexCache extends KbIndexCache {
  override get(key: string, build: () => Promise<KbIndex>): Promise<KbIndex> {
    return super.get(key, async () => {
      const start = performance.now();
      try {
        const index = await build();
        emit({ type: 'audit', event: 'index_build', releaseId: index.releaseId, status: 'ok', indexBuildMs: performance.now() - start });
        return index;
      } catch (error) {
        emit({ type: 'audit', event: 'index_build', status: 'error', indexBuildMs: performance.now() - start });
        throw error;
      }
    });
  }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
  const root = arg('--kb-root');
  const host = arg('--host');
  const port = Number(arg('--port'));
  const maxSessions = Number(arg('--max-sessions') ?? 16);
  const allowCidrs = arg('--allow-cidrs') === undefined ? DEFAULT_CIDRS : arg('--allow-cidrs')!.split(',').filter(Boolean);
  validateLanConfig({ enabled: true, bindAddress: host, port, maxSessions, allowCidrs });
  if (!root || !host || host === 'auto') throw new Error('invalid_gateway_arguments');
  // Exactly one service and index cache, separate notice state per MCP session.
  const service = new KbQueryService(root, { cache: new AuditedIndexCache() });
  const gateway = createHttpGateway({ host, port, maxSessions, allowCidrs, digests: (process.env.KB_LAN_TOKEN_SHA256 ?? '').split(','), register: (server, state) => registerKbTools(server, service, state), instructions: KB_MCP_INSTRUCTIONS, emit });
  await gateway.listen();
  emit({ type: 'ready', host, port, pid: process.pid });
  // Best-effort warmup shares the same cache/build promise as actual calls.
  // Unpublished/broken releases still return their normal errors on tool calls.
  setImmediate(() => { void service.releaseInfo({}).catch(() => {}); });
  const heartbeat = setInterval(() => emit({ type: 'hb', t: Date.now(), ...gateway.metrics() }), 2000);
  heartbeat.unref();
  let closing = false;
  const close = () => { if (closing) return; closing = true; clearInterval(heartbeat); void gateway.close().then(() => process.exit(0)); };
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
void main().catch((error: NodeJS.ErrnoException) => {
  emit({ type: 'fatal', code: error.code === 'EADDRINUSE' ? 'port_in_use' : error.code === 'EADDRNOTAVAIL' ? 'bind_unavailable' : 'failed', message: 'gateway_start_failed' });
  process.exitCode = 1;
});
