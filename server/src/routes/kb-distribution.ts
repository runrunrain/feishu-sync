import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ConfigManager } from '../modules/config-manager.js';
import { DistributionError, exportDocuments } from '../kb/document-distribution.js';
import type { WebShareService } from '../kb/web-share.js';

export function kbDistributionRoutes(config: ConfigManager, shares: WebShareService) {
  const app = new Hono();
  const outputRoot = () => {
    const current = config.getConfig();
    if (!current) throw new DistributionError('配置尚未加载', 503);
    return current.standardKb.outputRoot;
  };
  app.use('/api/kb/distribution/*', bodyLimit({ maxSize: 128 * 1024 }));
  app.use('/api/kb/distribution/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.onError((error, c) => {
    if (error instanceof DistributionError) return c.json({ error: 'kb_distribution_error', message: error.message }, error.status);
    if (error instanceof SyntaxError) return c.json({ error: 'invalid_json', message: '请求格式无效' }, 400);
    console.warn('[kb-distribution]', error);
    return c.json({ error: 'kb_distribution_failed', message: '操作失败，请查看应用日志后重试' }, 500);
  });
  app.post('/api/kb/distribution/export', async c => {
    const result = await exportDocuments(outputRoot(), await c.req.json());
    return new Response(new Uint8Array(result.bytes), { headers: { 'Content-Type': result.type,
      'Content-Disposition': `attachment; filename="export.${result.name.endsWith('.zip') ? 'zip' : 'md'}"; filename*=UTF-8''${encodeURIComponent(result.name)}`, 'Cache-Control': 'no-store' } });
  });
  app.get('/api/kb/distribution/shares', c => c.json(shares.status()));
  app.post('/api/kb/distribution/shares', async c => c.json(await shares.create(outputRoot(), await c.req.json()), 201));
  app.post('/api/kb/distribution/resume', async c => { await shares.resume(); return c.json(shares.status()); });
  app.delete('/api/kb/distribution/shares/:id', async c => c.json(await shares.revoke(c.req.param('id'))));
  return app;
}
