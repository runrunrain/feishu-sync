/** HTTP transport only. Tool ownership stays in the common MCP registration. */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { allowedSource, normalizeRemote } from './network.js';
import { verifyBearer } from './token-store.js';
import { LanCallQueue, KbBusyError } from './call-queue.js';

export interface HttpGatewayOptions {
  host: string; port: number; maxSessions: number; allowCidrs: string[]; digests: string[];
  register: (server: Server, sessionState: { lastServedCurrent?: string }) => void;
  instructions?: string;
  emit?: (message: Record<string, unknown>) => void;
  now?: () => number;
  sessionTtlMs?: number; evictIdleMs?: number;
}
interface Session { id: string; ip: string; touched: number; transport: StreamableHTTPServerTransport; server: Server; active: number }
function send(res: ServerResponse, status: number, code: string, rpcId?: string | number | null): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(status === 401 ? { 'WWW-Authenticate': 'Bearer realm="feishu-sync-kb"' } : {}), ...(status === 405 ? { Allow: 'POST, DELETE' } : {}) });
  res.end(JSON.stringify(rpcId !== undefined ? { jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: code, data: { code } } } : { error: { code, message: code === 'kb_lan_unauthorized' ? '令牌缺失或无效；请在主机「知识库共享」设置中复制最新令牌' : code } }));
}
function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0; let exceeded = false;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65_536) { if (!exceeded) { exceeded = true; chunks.length = 0; reject(new Error('body_too_large')); } return; }
      if (!exceeded) chunks.push(chunk);
    });
    req.once('end', () => {
      if (exceeded) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid_json')); }
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new Error('request_aborted')));
  });
}
export function createHttpGateway(options: HttpGatewayOptions) {
  if (!options.digests.length || !options.digests.every((d) => /^[a-f0-9]{64}$/.test(d))) throw new Error('invalid_token_digest');
  const queue = new LanCallQueue();
  const sessions = new Map<string, Session>();
  const failures = new Map<string, { first: number; count: number; blockedUntil: number }>();
  const now = options.now ?? Date.now;
  const emit = options.emit ?? (() => {});
  const audit = (event: string, data: Record<string, unknown> = {}) => emit({ type: 'audit', event, ...data });
  function closeSession(session: Session, event = 'session_close') {
    sessions.delete(session.id); queue.cancelSession(session.id);
    void session.server.close().catch(() => {});
    audit(event, { remote: session.ip, session: session.id });
  }
  function collect() {
    for (const s of sessions.values()) if (!s.active && now() - s.touched >= (options.sessionTtlMs ?? 30 * 60_000)) closeSession(s, 'session_evicted');
    for (const [ip, entry] of failures) if (now() - entry.first > 60_000 && entry.blockedUntil <= now()) failures.delete(ip);
  }
  async function makeSession(ip: string): Promise<Session> {
    const id = crypto.randomUUID();
    const server = new Server({ name: 'feishu-sync-kb', version: '2.0.0' }, { capabilities: { tools: {} }, instructions: options.instructions });
    // Intercept registration, not tool implementation: stdio and HTTP retain
    // one definition/handler/notice implementation, with session-local state.
    const original = server.setRequestHandler.bind(server);
    server.setRequestHandler = ((schema: any, handler: any) => {
      if (schema !== CallToolRequestSchema) { original(schema, handler); return; }
      original(schema, async (request: any, extra: any) => {
        const regex = request.params.name === 'grep_knowledge' && request.params.arguments?.mode === 'regex';
        const started = performance.now(); let queueMs = 0;
        let result: any;
        try {
          result = await queue.run(id, regex, async (wait) => {
            queueMs = wait;
            if (regex) audit('regex_start', { session: id, remote: ip });
            return handler(request, extra);
          });
          return result;
        } catch (e) {
          if (!(e instanceof KbBusyError)) throw e;
          queueMs = performance.now() - started;
          result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'kb_busy', message: e.message, retryAfterMs: e.retryAfterMs } }) }] };
          return result;
        } finally {
          const text = result?.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') ?? '';
          let releaseId: unknown; let errorCode: unknown = null;
          try { const parsed = JSON.parse(text); releaseId = parsed.releaseId; errorCode = parsed.error?.code ?? null; }
          catch { releaseId = /\brelease(?:=| |\s*[:=]\s*"?)([A-Za-z0-9_.-]+)/.exec(text)?.[1]; }
          audit('tool_call', { remote: ip, session: id, tool: request.params.name, releaseId, status: !result || result.isError ? 'error' : 'ok', errorCode, queueMs, durationMs: Math.max(0, performance.now() - started - queueMs), resultChars: text.length });
        }
      });
    }) as typeof server.setRequestHandler;
    options.register(server, {});
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id, enableJsonResponse: true, maxRequestBodySize: 65_536 });
    const session = { id, ip, touched: now(), transport, server, active: 0 };
    sessions.set(id, session); // reserve before await: concurrent initialize cannot exceed cap
    transport.onclose = () => { if (sessions.has(id)) closeSession(session); };
    try { await server.connect(transport); } catch (e) { closeSession(session); throw e; }
    return session;
  }
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.url !== '/mcp') { send(res, 404, 'not_found'); return; }
      const ip = normalizeRemote(req.socket.remoteAddress ?? '');
      if (!allowedSource(ip, options.allowCidrs)) { audit('forbidden_source', { remote: ip }); send(res, 403, 'kb_lan_forbidden_source'); return; }
      if (req.headers.origin !== undefined) { audit('browser_forbidden', { remote: ip }); send(res, 403, 'kb_lan_browser_forbidden'); return; }
      collect();
      const failed = failures.get(ip);
      if (failed && failed.blockedUntil > now()) { audit('rate_limited', { remote: ip }); send(res, 429, 'kb_lan_rate_limited'); return; }
      const foreign = req.headers['x-desktop-token'] !== undefined || req.headers['x-cli-token'] !== undefined;
      if (foreign) audit('foreign_token_header', { remote: ip });
      const authenticated = verifyBearer(req.headers.authorization, options.digests);
      if (foreign || !authenticated) {
        if (!failed && failures.size >= 4096) { send(res, 429, 'kb_lan_rate_limited'); return; }
        const entry = failed && now() - failed.first < 60_000 ? failed : { first: now(), count: 0, blockedUntil: 0 };
        entry.count++; if (entry.count >= 10) entry.blockedUntil = now() + 5 * 60_000;
        failures.set(ip, entry); audit('auth_fail', { remote: ip }); send(res, 401, 'kb_lan_unauthorized'); return;
      }
      if (req.method === 'GET' || !['POST', 'DELETE'].includes(req.method ?? '')) { send(res, 405, 'method_not_allowed'); return; }
      const sessionHeader = req.headers['mcp-session-id'];
      if (Array.isArray(sessionHeader)) { send(res, 404, 'session_not_found'); return; }
      let session = sessionHeader ? sessions.get(sessionHeader) : undefined;
      if (sessionHeader && (!session || session.ip !== ip)) { send(res, 404, 'session_not_found'); return; }
      let parsed: any;
      if (req.method === 'POST') {
        if (Number(req.headers['content-length'] ?? 0) > 65_536) { send(res, 413, 'body_too_large'); req.resume(); return; }
        try { parsed = await body(req); } catch (e) { send(res, (e as Error).message === 'body_too_large' ? 413 : 400, 'invalid_request'); return; }
      }
      if (!session) {
        if (!isInitializeRequest(parsed)) { send(res, 400, 'initialize_required'); return; }
        if (sessions.size >= options.maxSessions) {
          const oldest = [...sessions.values()].filter((s) => !s.active && now() - s.touched > (options.evictIdleMs ?? 5 * 60_000)).sort((a, b) => a.touched - b.touched)[0];
          if (oldest) closeSession(oldest, 'session_evicted');
        }
        if (sessions.size >= options.maxSessions) { send(res, 503, 'kb_sessions_full', (parsed as { id?: string | number }).id ?? null); return; }
        session = await makeSession(ip);
        audit('session_open', { remote: ip, session: session.id });
      }
      session.active++; session.touched = now();
      try { await session.transport.handleRequest(req, res, parsed); }
      finally {
        session.active--; session.touched = now();
        if (!session.transport.sessionId || req.method === 'DELETE') closeSession(session);
      }
    })().catch(() => { send(res, 500, 'gateway_error'); });
  });
  server.headersTimeout = 10_000; server.requestTimeout = 60_000; server.keepAliveTimeout = 5000;
  const gc = setInterval(collect, 30_000); gc.unref();
  return {
    server,
    metrics: () => ({ sessions: sessions.size, inflight: queue.inflight, queued: queue.queued, heapUsed: process.memoryUsage().heapUsed }),
    listen: () => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, () => { server.off('error', reject); resolve(); }); }),
    close: async () => { clearInterval(gc); queue.close(); for (const s of [...sessions.values()]) closeSession(s); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
