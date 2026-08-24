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
      // Provider profiles can carry independent keys. Redact every non-empty
      // one while preserving the profile/model structure needed by Settings.
      providers: config.llm.providers?.map((provider) => ({
        ...provider,
        apiKey: provider.apiKey ? '***' : '',
      })),
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
 * Reveal one provider key only after an explicit user interaction in the
 * authenticated desktop UI. GET /api/config remains redacted so ordinary
 * page loads, logs, and background refreshes never receive credentials.
 *
 * This endpoint intentionally accepts only a stable provider id — callers
 * cannot ask it to read arbitrary config fields. The response is marked
 * no-store and is never written to application logs.
 */
configRoutes.post('/api/config/reveal-provider-key', async (c) => {
  let body: { providerId?: unknown };
  try {
    body = await c.req.json() as { providerId?: unknown };
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const providerId = typeof body?.providerId === 'string' ? body.providerId.trim() : '';
  if (!providerId || providerId.length > 256) {
    return c.json({ error: 'invalid_provider_id' }, 400);
  }

  const configManager = (c as any).configManager;
  const config = await configManager.load();
  const provider = config.llm.providers?.find(
    (item: { id: string; apiKey: string }) => item.id === providerId,
  );
  if (!provider) {
    return c.json({ error: 'provider_not_found' }, 404);
  }
  if (!provider.apiKey) {
    return c.json({ error: 'api_key_not_configured' }, 404);
  }

  return c.json(
    { apiKey: provider.apiKey },
    200,
    { 'Cache-Control': 'no-store, max-age=0' },
  );
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

    // Keep the long-lived LarkCliClient in sync with Settings changes. In
    // particular, a user who pastes an absolute lark-cli path should be able
    // to press "重新检测" immediately instead of restarting the desktop app.
    const larkCliClient = (c as any).larkCliClient;
    if (typeof larkCliClient?.updateConfig === 'function') {
      larkCliClient.updateConfig({
        larkCliPath: updatedConfig.larkCliPath,
        requiredScopes: updatedConfig.requiredScopes,
      });
    }

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
