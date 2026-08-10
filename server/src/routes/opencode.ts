/** OpenCode discovery and explicit installation endpoints. */

import { Hono } from 'hono';
import { OpenCodeCliService } from '../modules/opencode-cli-service.js';

const opencodeRoutes = new Hono();

function getService(c: any): OpenCodeCliService {
  // buildServer injects one singleton so concurrent install clicks share the
  // same in-flight npm process. Keeping a fallback makes the route easy to
  // exercise in isolated Hono tests as well.
  if (!c.openCodeCliService) c.openCodeCliService = new OpenCodeCliService();
  return c.openCodeCliService as OpenCodeCliService;
}

opencodeRoutes.get('/api/opencode/status', async (c) => {
  const configManager = (c as any).configManager;
  const config = configManager ? await configManager.load() : null;
  const executablePath = config?.llm?.opencode?.executablePath;
  const status = await getService(c).getStatus(executablePath);
  return c.json(status);
});

/**
 * Run the official global npm installation only after an explicit UI action.
 * The endpoint does not accept a package/command from the caller, preventing
 * it from becoming a generic command-execution API.
 */
opencodeRoutes.post('/api/opencode/install', async (c) => {
  const result = await getService(c).install();
  return c.json(result);
});

export { opencodeRoutes };

