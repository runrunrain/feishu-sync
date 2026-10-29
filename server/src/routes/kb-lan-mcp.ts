/** Desktop-only management; never mounted in the LAN child. */
import { Hono } from 'hono';
import crypto from 'node:crypto';
import type { KbLanGatewayManager } from '../kb-lan/gateway-manager.js';
import type { KbLanMcpConfig } from '../types/index.js';

export function kbLanMcpRoutes(deps: { manager: KbLanGatewayManager; desktopToken: string }): Hono {
  const routes = new Hono();
  routes.use('/api/kb-lan-mcp/*', async (c, next) => {
    c.header('Cache-Control', 'no-store, max-age=0');
    if ((c as any).cliActor === true || c.req.header('X-Feishu-Sync-Actor') !== undefined || c.req.header('X-Cli-Token') !== undefined) return c.json({ error: 'kb_lan_forbidden_actor' }, 403);
    const a = crypto.createHash('sha256').update(c.req.header('X-Desktop-Token') ?? '').digest();
    const b = crypto.createHash('sha256').update(deps.desktopToken).digest();
    if (!deps.desktopToken || !crypto.timingSafeEqual(a, b)) return c.json({ error: 'Unauthorized' }, 401);
    await next();
  });
  routes.onError((e, c) => c.json({ error: 'invalid_config', message: e.message }, 400));
  const object = async (c: any): Promise<Record<string, unknown>> => {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_request');
    return body;
  };
  routes.get('/api/kb-lan-mcp/status', (c) => c.json(deps.manager.status()));
  routes.post('/api/kb-lan-mcp/enable', async (c) => {
    const body = await object(c);
    const patch: Partial<Pick<KbLanMcpConfig, 'bindAddress' | 'port'>> = {};
    if (body.bindAddress !== undefined) patch.bindAddress = body.bindAddress as string;
    if (body.port !== undefined) patch.port = body.port as number;
    return c.json(await deps.manager.enable(patch));
  });
  routes.post('/api/kb-lan-mcp/disable', async (c) => {
    const body = await object(c);
    if (body.revokeToken !== undefined && typeof body.revokeToken !== 'boolean') throw new Error('invalid_revoke_token');
    return c.json(await deps.manager.disable(body.revokeToken === true));
  });
  routes.put('/api/kb-lan-mcp/settings', async (c) => {
    const body = await object(c);
    return c.json(await deps.manager.settings({ bindAddress: body.bindAddress as string, port: body.port as number, maxSessions: body.maxSessions as number, ...(body.allowCidrs === undefined ? {} : { allowCidrs: body.allowCidrs as string[] }) }));
  });
  routes.post('/api/kb-lan-mcp/token/rotate', async (c) => c.json(await deps.manager.rotate()));
  routes.post('/api/kb-lan-mcp/token/reveal', (c) => c.json(deps.manager.reveal()));
  routes.get('/api/kb-lan-mcp/audit', (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return c.json({ error: 'invalid_request' }, 400);
    return c.json(deps.manager.audit.recent(limit));
  });
  return routes;
}
