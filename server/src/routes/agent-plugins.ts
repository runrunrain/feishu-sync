import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppPluginStore } from '../agent/app-plugin-store.js';
import { ToolError } from '../agent/agent-tool-service.js';
import type { AgentPluginInput } from '../types/agent-plugin.js';

/** 在desktop认证之后挂载；不访问设备通用Pi的settings/extensions。 */
export function agentPluginRoutes(store: AppPluginStore): Hono {
  const routes = new Hono();
  routes.onError((error, c) => c.json({ error: error instanceof ToolError ? error.code : 'plugin_error', message: error.message },
    (error instanceof ToolError ? error.status : 500) as ContentfulStatusCode));
  routes.get('/api/agent/plugin-contexts', (c) => c.json(store.list()));
  const readBody = async (request: { json(): Promise<unknown> }) => {
    let body: unknown;
    try { body = await request.json(); } catch { throw new ToolError('invalid_request', '请求必须为JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ToolError('invalid_request', '请求必须为对象');
    const { expectedRevision, ...input } = body as AgentPluginInput & { expectedRevision?: unknown };
    return { expectedRevision, input };
  };
  routes.post('/api/agent/plugin-contexts', async (c) => {
    const { expectedRevision, input } = await readBody(c.req);
    return c.json(store.mutate('create', null, expectedRevision, input), 201);
  });
  routes.put('/api/agent/plugin-contexts/:id', async (c) => {
    const { expectedRevision, input } = await readBody(c.req);
    return c.json(store.mutate('update', c.req.param('id'), expectedRevision, input));
  });
  routes.post('/api/agent/plugin-contexts/:id/reset', async (c) => {
    const { expectedRevision, input } = await readBody(c.req);
    if (Object.keys(input).length) throw new ToolError('invalid_request', '重置请求仅接受expectedRevision');
    return c.json(store.mutate('reset', c.req.param('id'), expectedRevision));
  });
  routes.delete('/api/agent/plugin-contexts/:id', async (c) => {
    const { expectedRevision, input } = await readBody(c.req);
    if (Object.keys(input).length) throw new ToolError('invalid_request', '删除请求仅接受expectedRevision');
    return c.json(store.mutate('delete', c.req.param('id'), expectedRevision));
  });
  return routes;
}
