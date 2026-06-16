/**
 * Config Routes - Configuration management endpoints
 *
 * GET /api/config - Get current configuration
 * PUT /api/config - Update configuration
 */

import { Hono } from 'hono';
import type { Config } from '../types/index.js';

const configRoutes = new Hono();

// Make configManager available via middleware
configRoutes.use('*', async (c, next) => {
  const configManager = (c as any).configManager;
  if (!configManager) {
    return c.json({ error: 'ConfigManager not initialized' }, 500);
  }
  await next();
});

/**
 * GET /api/config - Get current configuration
 */
configRoutes.get('/api/config', async (c) => {
  const configManager = (c as any).configManager;
  const config = await configManager.load();

  // Don't expose sensitive fields like apiKey in production
  const sanitizedConfig: Config = {
    ...config,
    llm: {
      ...config.llm,
      apiKey: config.llm.apiKey ? '***' : '',
    },
  };

  return c.json(sanitizedConfig);
});

/**
 * PUT /api/config - Update configuration
 */
configRoutes.put('/api/config', async (c) => {
  const configManager = (c as any).configManager;
  const partialConfig = await c.req.json();

  // Load current config and merge with updates
  const currentConfig = await configManager.load();
  const updatedConfig: Config = {
    ...currentConfig,
    ...partialConfig,
  };

  await configManager.save(updatedConfig);

  return c.json({ success: true, config: updatedConfig });
});

export { configRoutes };
