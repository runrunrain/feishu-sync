/** Only a local desktop user may edit external Agent configuration. */
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { McpClientInstaller, McpInstallError, type McpClientTarget } from '../kb/mcp-client-installer.js';

export function kbMcpInstallRoutes(deps: { installer: McpClientInstaller; desktopToken: string }): Hono {
  const routes = new Hono();
  routes.use('/api/kb-mcp-install/*', async (c, next) => {
    c.header('Cache-Control', 'no-store, max-age=0');
    if ((c as any).cliActor === true || c.req.header('X-Feishu-Sync-Actor') !== undefined || c.req.header('X-Cli-Token') !== undefined) return c.json({ error: 'forbidden_actor' }, 403);
    const actual = crypto.createHash('sha256').update(c.req.header('X-Desktop-Token') ?? '').digest();
    const expected = crypto.createHash('sha256').update(deps.desktopToken).digest();
    if (!deps.desktopToken || !crypto.timingSafeEqual(actual, expected)) return c.json({ error: 'Unauthorized' }, 401);
    await next();
  });
  routes.onError((error, c) => {
    if (error instanceof McpInstallError) return c.json({ error: error.code, message: error.message }, 400);
    return c.json({ error: 'operation_failed', message: '操作未完成，请检查配置与文件权限后重试。' }, 500);
  });
  routes.get('/api/kb-mcp-install/status', (c) => c.json({ targets: deps.installer.status() }));
  const parseTarget = async (c: any): Promise<McpClientTarget> => {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'target') || !('target' in body) || !['agents', 'claude'].includes(String(body.target))) {
      throw new McpInstallError('invalid_target', '请选择 .agents 或 Claude Code。');
    }
    return body.target as McpClientTarget;
  };
  routes.post('/api/kb-mcp-install/install', async (c) => c.json(deps.installer.install(await parseTarget(c))));
  routes.post('/api/kb-mcp-install/remove', async (c) => c.json(deps.installer.remove(await parseTarget(c))));
  return routes;
}
