/**
 * CLI 面板路由（设计 kb-agent-upgrade §6.2-6.3）
 *
 * 挂载于 desktop auth **之前**（与 agent-internal 同模式，见 index.ts
 * 注册顺序注释），内部两个互斥认证域：
 *
 *  - `/api/cli/enable`、`/api/cli/token/rotate`：管理面，只接受 desktop
 *    token（CLI 令牌不能自我提权；带 CLI 令牌访问 → 403
 *    cli_forbidden_route，设计 §8）。这两个路由注册在 cli-auth 之前，
 *    不经过 CLI 三重校验。
 *  - 其余 `/api/cli/*`（commands 清单 + `POST /api/cli/:command` 命令
 *    执行）：CLI 域，经 cli-auth 三重校验（回环 + 拒 Origin +
 *    X-Cli-Token timing-safe），**不接受** desktop token。
 *
 * 命令执行：查 ops/command-table 得到请求描述后进程内直调（app.request
 * 携 desktop token 穿透目标路由的鉴权，不走网络回环）——复用既有路由的
 * 全部校验/审计/错误语义，选择依据见 S8 报告。
 *
 * 响应包络与设计 §6.4 CLI stdout 契约一致：
 *   成功 `{ ok: true, data }`；失败 `{ ok: false, error: { code, message,
 *   httpStatus? } }`（S9 --json 模式直接透传本包络）。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import crypto from 'node:crypto';
import type { CliEndpoint } from '../cli-endpoint.js';
import type { ConfigManager } from '../modules/config-manager.js';
import { cliAuthMiddleware, CLI_TOKEN_HEADER } from '../middleware/cli-auth.js';
import {
  findOpsCommand,
  opsCommandMetadata,
  OpsArgumentError,
  type OpsRequestSpec,
} from '../ops/command-table.js';

export interface CliRoutesDeps {
  cliEndpoint: CliEndpoint;
  /** buildServer 生成的 desktop token（管理面校验 + 命令转发穿透鉴权）。 */
  desktopToken: string;
  configManager: ConfigManager;
  /** 进程内转发用的 Hono app（index.ts 挂载后回填）。 */
  getApp: () => Hono | undefined;
  /** 数据根（审计文件定位，与 cliEndpoint 同源）。 */
  dataRoot: string;
}

function timingSafeTokenEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 管理面守卫：CLI 令牌明确拒绝（不能自我授权/轮换提权），desktop token 校验。 */
function desktopGuardFactory(deps: CliRoutesDeps) {
  return async (c: Context): Promise<Response | null> => {
    if (c.req.header(CLI_TOKEN_HEADER) !== undefined) {
      return c.json(
        { error: 'cli_forbidden_route', message: 'CLI 令牌不能管理命令行访问（请在应用设置中操作）' },
        403,
      );
    }
    const provided = c.req.header('X-Desktop-Token') ?? '';
    if (!timingSafeTokenEqual(provided, deps.desktopToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return null;
  };
}

export function cliRoutes(deps: CliRoutesDeps): Hono {
  const { cliEndpoint, configManager, getApp } = deps;
  const requireDesktop = desktopGuardFactory(deps);
  const routes = new Hono();

  // ---------------------------------------------------------------------
  // 管理面（desktop token 域）——必须注册在 cli-auth 之前（Hono 按注册
  // 顺序组执行链：这两个静态路由的 handler 返回即终止，后续 use 不执行）。
  // ---------------------------------------------------------------------
  routes.post('/api/cli/enable', async (c) => {
    const denied = await requireDesktop(c);
    if (denied) return denied;
    let body: { enabled?: unknown };
    try {
      body = await c.req.json() as { enabled?: unknown };
    } catch {
      return c.json({ error: 'invalid_json', message: '请求体必须是 JSON' }, 400);
    }
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'invalid_body', message: 'enabled 必须为 boolean' }, 400);
    }
    try {
      await configManager.updateConfig({ cli: { enabled: body.enabled } });
    } catch (error) {
      return c.json(
        { error: 'invalid_config', message: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
    if (body.enabled) {
      // URL 优先用 startServer 回填值；测试/未监听路径回退请求 origin。
      const url = cliEndpoint.getUrl() ?? new URL(c.req.url).origin;
      cliEndpoint.publish(url);
    } else {
      cliEndpoint.revoke();
    }
    return c.json({
      enabled: body.enabled,
      endpointFile: cliEndpoint.endpointFilePath,
      published: cliEndpoint.isPublished(),
    });
  });

  routes.post('/api/cli/token/rotate', async (c) => {
    const denied = await requireDesktop(c);
    if (denied) return denied;
    const enabled = configManager.getConfig()?.cli?.enabled === true;
    if (!enabled) {
      return c.json({ error: 'cli_disabled', message: '命令行访问未开启' }, 400);
    }
    try {
      cliEndpoint.rotate();
    } catch (error) {
      return c.json(
        { error: 'cli_not_published', message: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
    return c.json({ rotated: true, endpointFile: cliEndpoint.endpointFilePath });
  });

  // ---------------------------------------------------------------------
  // CLI 命令域（三重校验；注册于其后的一切 /api/cli/* 路由都受保护）
  // ---------------------------------------------------------------------
  routes.use('/api/cli/*', cliAuthMiddleware({ cliEndpoint, dataRoot: deps.dataRoot }));

  routes.get('/api/cli/commands', (c) => {
    return c.json({ commands: opsCommandMetadata() });
  });

  routes.post('/api/cli/:command', async (c) => {
    const name = c.req.param('command');
    const def = findOpsCommand(name);
    if (!def) {
      return c.json(
        { error: 'unknown_command', message: `未知命令 ${name}（GET /api/cli/commands 查看可用命令）` },
        404,
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      body = {};
    }
    const argsIn = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
      ? body.args as Record<string, unknown>
      : {};
    const config = configManager.getConfig();
    const args = def.fillDefaults ? def.fillDefaults(argsIn, { config }) : argsIn;

    // 必填参数轻校验（类型细节交目标路由校验；此处只挡明显缺参）。
    for (const key of def.params.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(args, key)) {
        return c.json(
          { ok: false, error: { code: 'invalid_args', message: `缺少必填参数 ${key}` } },
          400,
        );
      }
    }

    let specs: OpsRequestSpec[];
    try {
      specs = def.request(args);
    } catch (error) {
      if (error instanceof OpsArgumentError) {
        return c.json({ ok: false, error: { code: error.code, message: error.message } }, 400);
      }
      throw error;
    }

    // 确认门：destructive/remote_write（以及任何登记了 confirm 且将发出
    // 非 GET 请求的命令）要求调用方在 body 中显式给出 confirm 值。
    // dry-run 分支（GET）不受限。
    if (def.confirm && specs.some((spec) => spec.method !== 'GET')) {
      if (body[def.confirm.field] !== def.confirm.value) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'confirmation_required',
              message: `命令 ${def.name} 需要 ${def.confirm.field}=${def.confirm.value} 确认`,
              details: { field: def.confirm.field, value: def.confirm.value },
            },
          },
          422,
        );
      }
    }

    const app = getApp();
    if (!app) {
      return c.json(
        { ok: false, error: { code: 'server_not_ready', message: '服务尚未完成挂载' } },
        503,
      );
    }

    const results: Array<{ spec: OpsRequestSpec; status: number; json: unknown }> = [];
    for (const spec of specs) {
      const query = spec.query && Object.keys(spec.query).length > 0
        ? `?${new URLSearchParams(spec.query).toString()}`
        : '';
      const hasBody = spec.body !== undefined && spec.method !== 'GET';
      const response = await app.request(new Request(`http://127.0.0.1${spec.path}${query}`, {
        method: spec.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Desktop-Token': deps.desktopToken,
          // T3b-02：转发保留来源主体（不能靠 desktop token 洗白）——目标
          // 路由（如 PUT /api/config）据此对 actor=cli 丢弃 feishuWrite 等
          // 只接受 desktop 修改的字段。伪造该头只会让自己丢字段，无提权面。
          'X-Feishu-Sync-Actor': 'cli',
        },
        ...(hasBody ? { body: JSON.stringify(spec.body) } : {}),
      }));
      const json = await response.json().catch(() => null);
      results.push({ spec, status: response.status, json });
    }

    // 单步：透传目标语义（HTTP 状态与错误码）。
    if (results.length === 1) {
      const only = results[0];
      if (only.status >= 400) {
        const err = (only.json && typeof only.json === 'object'
          ? only.json as { error?: unknown; message?: unknown }
          : {});
        return c.json(
          {
            ok: false,
            error: {
              code: typeof err.error === 'string' ? err.error : 'upstream_error',
              message: typeof err.message === 'string' ? err.message : `上游路由返回 ${only.status}`,
              httpStatus: only.status,
            },
          },
          only.status as ContentfulStatusCode,
        );
      }
      return c.json({ ok: true, data: only.json });
    }

    // 多步聚合：每步独立成败（失败步保留错误面，不中断其余步骤）。
    const data: Record<string, unknown> = {};
    results.forEach((result, index) => {
      const key = result.spec.key ?? `step${index + 1}`;
      data[key] = result.status < 400
        ? result.json
        : {
          ok: false,
          error: (result.json && typeof result.json === 'object'
            && typeof (result.json as { error?: unknown }).error === 'string')
            ? (result.json as { error: string }).error
            : 'upstream_error',
          httpStatus: result.status,
        };
    });
    return c.json({ ok: true, data });
  });

  return routes;
}
