/**
 * Feishu Routes - Feishu integration endpoints
 *
 * GET  /api/feishu/auth-status            - Check lark-cli authentication readiness
 * GET  /api/feishu/lark-cli/status        - lark-cli 安装/认证/npm 可用性组合状态
 * POST /api/feishu/lark-cli/install       - 一键安装/更新 lark-cli（npm -g，幂等）
 * POST /api/feishu/auth/device/start      - 发起 Device Flow（立即返回 verificationUrl 等）
 * POST /api/feishu/auth/device/complete     - 阻塞等待浏览器授权完成并返回最终就绪状态
 * POST /api/feishu/lark-cli/config-init/start    - 发起 lark-cli 初始化配置（立即返回验证 URL，进程后台等待）
 * POST /api/feishu/lark-cli/config-init/complete - 阻塞等待浏览器完成初始化配置
 *
 * 新增端点的依赖经 c.env.larkCliManager 注入（buildServer 的 DI 中间件）；
 * 错误处理参照 custom-folders.ts 的 errorResponse 模式。
 */

import { Hono } from 'hono';
import { LarkCliManagerError } from '../modules/lark-cli-manager.js';

const feishuRoutes = new Hono();

/** deviceCode 防注入上限（与 LarkCliManager 校验一致，防御纵深）。 */
const MAX_DEVICE_CODE_LENGTH = 500;

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

/** 从 c.env 取 LarkCliManager；缺失按依赖未注入处理。 */
function requireLarkCliManager(c: any) {
  const manager = (c as any).larkCliManager;
  if (!manager) {
    throw new Error('dependencies_not_injected');
  }
  return manager;
}

/**
 * 路由级错误响应：LarkCliManagerError 携带稳定 code + HTTP status，其余
 * 统一 500（模式对齐 custom-folders.ts errorResponse）。
 */
function errorResponse(c: any, code: string, error: unknown) {
  if (error instanceof Error && error.message === 'dependencies_not_injected') {
    return c.json({ error: 'dependencies_not_injected' }, 500);
  }
  if (error instanceof LarkCliManagerError) {
    return c.json({ error: error.code, message: error.message }, error.status as 400 | 409 | 500);
  }
  console.error(`[feishu] ${code}:`, error);
  return c.json(
    {
      error: code,
      message: error instanceof Error ? error.message : String(error),
    },
    500,
  );
}

/**
 * GET /api/feishu/lark-cli/status - lark-cli 安装/认证/npm 组合状态
 * → { larkCliInstalled, larkCliVersion?, authReady, missingScopes, error?, npmAvailable, npmPath }
 */
feishuRoutes.get('/api/feishu/lark-cli/status', async (c) => {
  try {
    const manager = requireLarkCliManager(c);
    return c.json(await manager.getToolStatus());
  } catch (error) {
    return errorResponse(c, 'lark_cli_status_failed', error);
  }
});

/**
 * POST /api/feishu/lark-cli/install - 一键安装/更新 lark-cli（幂等）
 * → { ok, reason?, output, version?, error? }（npm_not_found 也是 200：
 * 这是环境状态而非服务器错误，前端据此引导安装 Node.js）
 */
feishuRoutes.post('/api/feishu/lark-cli/install', async (c) => {
  try {
    const manager = requireLarkCliManager(c);
    return c.json(await manager.installOrUpdateLarkCli());
  } catch (error) {
    return errorResponse(c, 'lark_cli_install_failed', error);
  }
});

/**
 * POST /api/feishu/auth/device/start - 发起 Device Flow
 * → { verificationUrl, deviceCode, expiresIn }；已有进行中流程时 409
 * device_auth_in_progress。
 */
feishuRoutes.post('/api/feishu/auth/device/start', async (c) => {
  try {
    const manager = requireLarkCliManager(c);
    return c.json(await manager.startDeviceAuth());
  } catch (error) {
    return errorResponse(c, 'device_auth_start_failed', error);
  }
});

/**
 * POST /api/feishu/auth/device/complete - 等待浏览器授权完成
 * body { deviceCode }；阻塞最长约 11 分钟（expiresIn 600s + 余量）。
 * → { ok, ready, larkCliVersion?, currentScopes?, missingScopes?, identity?, error? }
 */
feishuRoutes.post('/api/feishu/auth/device/complete', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const deviceCode = body?.deviceCode;
  if (
    typeof deviceCode !== 'string'
    || deviceCode.trim().length === 0
    || deviceCode.length >= MAX_DEVICE_CODE_LENGTH
  ) {
    return c.json(
      {
        error: 'invalid_body',
        message: `deviceCode 必须是非空且长度小于 ${MAX_DEVICE_CODE_LENGTH} 的字符串`,
      },
      400,
    );
  }

  try {
    const manager = requireLarkCliManager(c);
    return c.json(await manager.completeDeviceAuth(deviceCode));
  } catch (error) {
    return errorResponse(c, 'device_auth_complete_failed', error);
  }
});

/**
 * POST /api/feishu/lark-cli/config-init/start - 发起 lark-cli 初始化配置
 * （全新机器安装后的 not_configured 态必经步骤，应用内闭环关键一环）。
 * → { verificationUrl }；已有进行中流程时 409 config_init_in_progress。
 */
feishuRoutes.post('/api/feishu/lark-cli/config-init/start', async (c) => {
  try {
    const manager = requireLarkCliManager(c);
    return c.json(await manager.startConfigInit());
  } catch (error) {
    return errorResponse(c, 'config_init_start_failed', error);
  }
});

/**
 * POST /api/feishu/lark-cli/config-init/complete - 阻塞等待浏览器完成初始化配置
 * （最长约 12 分钟）。→ { ok, output?, error? }；无进行中流程时 400
 * config_init_not_in_progress。
 */
feishuRoutes.post('/api/feishu/lark-cli/config-init/complete', async (c) => {
  try {
    const manager = requireLarkCliManager(c);
    return c.json(await manager.completeConfigInit());
  } catch (error) {
    return errorResponse(c, 'config_init_complete_failed', error);
  }
});

/**
 * POST /api/feishu/lark-cli/config-init/cancel - 取消进行中的初始化配置
 * （【diting B-1】服务端取消通道：kill 子进程 + 回收占位标记，幂等）。
 * → { cancelled: boolean }。
 */
feishuRoutes.post('/api/feishu/lark-cli/config-init/cancel', async (c) => {
  try {
    const manager = requireLarkCliManager(c);
    return c.json(await manager.cancelConfigInit());
  } catch (error) {
    return errorResponse(c, 'config_init_cancel_failed', error);
  }
});

export { feishuRoutes };
