/**
 * Feishu Routes - Feishu integration endpoints
 *
 * GET /api/feishu/auth-status - Check lark-cli authentication readiness
 */

import { Hono } from 'hono';

const feishuRoutes = new Hono();

// Make dependencies available via middleware
feishuRoutes.use('*', async (c, next) => {
  const larkCliClient = (c as any).larkCliClient;

  if (!larkCliClient) {
    return c.json({ error: 'Required dependencies not initialized' }, 500);
  }

  await next();
});

/**
 * GET /api/feishu/auth-status - Check lark-cli authentication readiness
 */
feishuRoutes.get('/api/feishu/auth-status', async (c) => {
  const larkCliClient = (c as any).larkCliClient;

  try {
    const result = await larkCliClient.checkAuthReady();
    return c.json(result);
  } catch (error) {
    return c.json({
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});

export { feishuRoutes };
