/**
 * Health Check Routes - Basic server health status
 *
 * GET /api/health - Returns server status and timestamp
 */

import { Hono } from 'hono';

const healthRoutes = new Hono();

healthRoutes.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: Date.now(),
  });
});

export { healthRoutes };
