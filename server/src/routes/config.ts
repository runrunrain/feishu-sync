/**
 * Config Routes - Configuration management endpoints
 *
 * GET /api/config - Get current configuration
 * PUT /api/config - Update configuration
 */

import { Hono } from 'hono';
import type { Config } from '../types/index.js';

const configRoutes = new Hono();

function sanitizeConfig(config: Config): Config {
  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: config.llm.apiKey ? '***' : '',
    },
  };
}

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
  return c.json(sanitizeConfig(config));
});

/**
 * PUT /api/config - Update configuration
 */
configRoutes.put('/api/config', async (c) => {
  const configManager = (c as any).configManager;
  let partialConfig: Partial<Config>;
  try {
    partialConfig = await c.req.json() as Partial<Config>;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  try {
    const updatedConfig = await configManager.updateConfig(partialConfig);
    return c.json({ success: true, config: sanitizeConfig(updatedConfig) });
  } catch (error) {
    return c.json(
      {
        error: 'config_validation_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      400,
    );
  }
});

export { configRoutes };
