/** Read-only Claude Code availability endpoint used by Settings. */

import { Hono } from 'hono';
import { ClaudeCliService } from '../modules/claude-cli-service.js';

const claudeRoutes = new Hono();

function getService(c: any): ClaudeCliService {
  // buildServer normally injects a singleton. The fallback keeps this route
  // straightforward to exercise in isolated Hono tests.
  if (!c.claudeCliService) c.claudeCliService = new ClaudeCliService();
  return c.claudeCliService as ClaudeCliService;
}

claudeRoutes.get('/api/claude/status', async (c) => {
  const configManager = (c as any).configManager;
  const config = configManager ? await configManager.load() : null;
  const configuredPath = config?.llm?.claudeCli?.claudePath;
  return c.json(await getService(c).getStatus(configuredPath));
});

export { claudeRoutes };
