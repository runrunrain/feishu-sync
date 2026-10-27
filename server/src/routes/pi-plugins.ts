import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { PiPluginService } from '../agent/pi-plugin-service.js';
import { ToolError } from '../agent/agent-tool-service.js';
export function piPluginRoutes(service: PiPluginService): Hono {
  const routes = new Hono();
  routes.onError((error, c) => c.json({ error: error instanceof ToolError ? error.code : 'plugin_error', message: error.message },
    (error instanceof ToolError ? error.status : 500) as ContentfulStatusCode));
  routes.get('/api/agent/plugins', async (c) => c.json(await service.refresh()));
  routes.post('/api/agent/plugins/:action', async (c) => {
    const action = c.req.param('action');
    if (!['install', 'update', 'remove', 'toggle'].includes(action)) throw new ToolError('invalid_request', '不支持的插件操作');
    let body;
    try { body = await c.req.json(); } catch { throw new ToolError('invalid_request', '请求必须为JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ToolError('invalid_request', '请求必须为对象');
    return c.json(await service.mutate(action as 'install' | 'update' | 'remove' | 'toggle', body));
  });
  return routes;
}
