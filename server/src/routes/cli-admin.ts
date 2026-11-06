/** Desktop-only management routes, mounted before the CLI command domain. */
import crypto from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { CLI_SKILL_TARGETS, CliInstallError, CliLocalInstaller, type CliSkillTarget } from '../cli/local-install.js';
import type { CliEndpoint } from '../cli-endpoint.js';
import type { ConfigManager } from '../modules/config-manager.js';
import { CLI_TOKEN_HEADER } from '../middleware/cli-auth.js';

export interface CliAdminDeps {
  desktopToken: string;
  cliEndpoint: CliEndpoint;
  configManager: ConfigManager;
  installer: CliLocalInstaller;
}

function timingSafeTokenEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 与 routes/cli.ts 的 desktopGuard 同语义（该工厂未导出，此处等价复刻）。 */
function desktopGuard(desktopToken: string) {
  return async (c: Context): Promise<Response | null> => {
    if (c.req.header(CLI_TOKEN_HEADER) !== undefined || c.req.header('X-Feishu-Sync-Actor') === 'cli') {
      return c.json(
        { error: 'cli_forbidden_route', message: 'CLI 令牌不能管理命令行访问（请在应用设置中操作）' },
        403,
      );
    }
    const provided = c.req.header('X-Desktop-Token') ?? '';
    if (!timingSafeTokenEqual(provided, desktopToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return null;
  };
}

export function cliAdminRoutes(deps: CliAdminDeps): Hono {
  const routes = new Hono();
  const requireDesktop = desktopGuard(deps.desktopToken);
  const { installer } = deps;

  const invocation = () => ({
    command: installer.command,
    args: [installer.cliScript],
    env: installer.env,
    pathHint: installer.pathHint,
  });

  const errorResponse = (c: Context, error: unknown) => c.json({
    error: 'cli_install_failed',
    message: error instanceof Error ? error.message : String(error),
  }, error instanceof CliInstallError ? 409 : 500);

  routes.get('/api/cli/info', async (c) => {
    const denied = await requireDesktop(c);
    if (denied) return denied;
    const shim = installer.shimStatus();
    return c.json({
      enabled: deps.configManager.getConfig()?.cli?.enabled === true,
      endpointPublished: deps.cliEndpoint.isPublished(),
      endpointFile: deps.cliEndpoint.endpointFilePath,
      cliAvailable: installer.cliAvailable,
      cliScript: installer.cliScript,
      shimInstalled: shim.state === 'installed' || shim.state === 'needs_update',
      shimPath: installer.shimPath,
      shim,
      skillAvailable: installer.skillAvailable,
      skillTargets: CLI_SKILL_TARGETS.map(target => installer.skillStatus(target)),
      ...invocation(),
    });
  });

  routes.post('/api/cli/install-shim', async (c) => {
    const denied = await requireDesktop(c);
    if (denied) return denied;
    if (!installer.cliAvailable) {
      return c.json({ error: 'cli_script_missing', message: 'CLI 打包产物不存在，请更新应用版本。' }, 409);
    }
    try {
      installer.installShim();
      return c.json({ installed: true, shimPath: installer.shimPath, cmdPath: installer.cmdPath, ...invocation() });
    } catch (error) { return errorResponse(c, error); }
  });

  routes.post('/api/cli/remove-shim', async (c) => {
    const denied = await requireDesktop(c);
    if (denied) return denied;
    try {
      installer.removeShim();
      return c.json(installer.shimStatus());
    } catch (error) { return errorResponse(c, error); }
  });

  routes.on(['PUT', 'DELETE'], '/api/cli/skill/:target', async (c) => {
    const denied = await requireDesktop(c);
    if (denied) return denied;
    const target = c.req.param('target') as CliSkillTarget;
    if (!CLI_SKILL_TARGETS.includes(target)) {
      return c.json({ error: 'invalid_target', message: '不支持的 Skill 安装目标。' }, 400);
    }
    try {
      if (c.req.method === 'PUT') installer.installSkill(target);
      else installer.removeSkill(target);
      return c.json(installer.skillStatus(target));
    } catch (error) { return errorResponse(c, error); }
  });

  return routes;
}
