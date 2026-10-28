/**
 * Feishu Routes - Feishu integration endpoints
 *
 * GET  /api/feishu/auth-status            - Check lark-cli authentication readiness
 * GET  /api/feishu/lark-cli/status        - lark-cli 安装/认证/npm 可用性组合状态
 * POST /api/feishu/lark-cli/install       - 一键安装/更新 lark-cli（npm -g，幂等）
 * POST /api/feishu/auth/device/start      - 发起 Device Flow（立即返回 verificationUrl 等）
 * POST /api/feishu/auth/device/complete     - 阻塞等待浏览器授权完成并返回最终就绪状态
 * POST /api/feishu/auth/device/cancel       - 停止指定会话的授权进程并释放会话
 * POST /api/feishu/lark-cli/config-init/start    - 发起 lark-cli 初始化配置（立即返回验证 URL，进程后台等待）
 * POST /api/feishu/lark-cli/config-init/complete - 阻塞等待浏览器完成初始化配置
 *
 * 新增端点的依赖经 c.env.larkCliManager 注入（buildServer 的 DI 中间件）；
 * 错误处理参照 custom-folders.ts 的 errorResponse 模式。
 */

import { Hono } from 'hono';
import { LarkCliManagerError, WRITE_SCOPES } from '../modules/lark-cli-manager.js';
import { SourceEditService, SourceEditError } from '../sources/source-edit-service.js';
import { FeishuWriteService, FeishuWriteError } from '../sources/feishu-write-service.js';
import { SyncEngine } from '../modules/sync-engine.js';
import { LayoutReconstructor } from '../modules/layout-reconstructor.js';
import { ContentAdapter } from '../modules/content-adapter.js';
import { ContentBackendRegistry } from '../modules/content-backend-registry.js';
import type { ChannelConfig } from '../modules/content-backend.js';
import { resolveDataRoot } from '../modules/data-root.js';
import type { SourceEditActor } from '../types/index.js';

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
 * S12：响应增补 writeScopesGranted（WRITE_SCOPES ⊆ currentScopes，供写回
 * 入口判断是否需要发起 scopeSet=write 增量授权）。
 */
feishuRoutes.get('/api/feishu/auth-status', async (c) => {
  const larkCliClient = (c as any).larkCliClient;

  try {
    const result = await larkCliClient.checkAuthReady();
    const granted = new Set<string>(result.currentScopes ?? []);
    return c.json({
      ...result,
      writeScopesGranted: WRITE_SCOPES.every((scope) => granted.has(scope)),
    });
  } catch (error) {
    return c.json({
      ready: false,
      writeScopesGranted: false,
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
 * body { mode?, scopeSet? }；scopeSet='write' 时请求集并入 WRITE_SCOPES
 * （S12 写回授权入口；缺省 read，与既有读链路一致）。
 * → { verificationUrl, deviceCode, expiresIn, requestedScopes, scopeSet }；
 * 已有进行中流程时 409 device_auth_in_progress。
 */
feishuRoutes.post('/api/feishu/auth/device/start', async (c) => {
  let body: { mode?: unknown; scopeSet?: unknown };
  try {
    const text = await c.req.text();
    body = text ? JSON.parse(text) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body');
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const mode = body.mode ?? 'reauthorize';
  if (mode !== 'reauthorize' && mode !== 'switch_account') {
    return c.json({ error: 'invalid_auth_mode' }, 400);
  }
  const scopeSet = body.scopeSet ?? 'read';
  if (scopeSet !== 'read' && scopeSet !== 'write') {
    return c.json({ error: 'invalid_body', message: 'scopeSet 只接受 "read" | "write"' }, 400);
  }
  try {
    const manager = requireLarkCliManager(c);
    return c.json(await manager.startDeviceAuth(mode, { scopeSet }));
  } catch (error) {
    return errorResponse(c, 'device_auth_start_failed', error);
  }
});

feishuRoutes.post('/api/feishu/auth/device/cancel', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (typeof body?.deviceCode !== 'string' || !body.deviceCode.trim() || body.deviceCode.length >= MAX_DEVICE_CODE_LENGTH) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  try {
    return c.json(await requireLarkCliManager(c).cancelDeviceAuth(body.deviceCode));
  } catch (error) {
    return errorResponse(c, 'device_auth_cancel_failed', error);
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

// ============================================================================
// S12 飞书写回 push API（设计 §7.4/§7.5；任务书指定落在本文件，不动
// routes/sources.ts——S11 已交付）。依赖经 buildServer DI 中间件注入
// （configManager / larkCliClient / localMapStore / kbBuildService）。
// ============================================================================

/** 写回链错误映射：FeishuWriteError/SourceEditError → 声明码；其余 500。 */
function pushErrorResponse(c: any, error: unknown) {
  if (error instanceof FeishuWriteError || error instanceof SourceEditError) {
    return c.json(
      {
        error: error.code,
        message: error.message,
        ...((error as FeishuWriteError | SourceEditError).details
          ? { details: (error as FeishuWriteError | SourceEditError).details }
          : {}),
      },
      error.status as 400 | 403 | 404 | 409 | 422 | 500,
    );
  }
  console.error('[feishu] source push failed:', error);
  return c.json(
    {
      error: 'feishu_write_failed',
      message: error instanceof Error ? error.message : String(error),
    },
    500,
  );
}

/** 从请求上下文构造 FeishuWriteService（每请求新建，与 sync 路由同模式）。 */
function createFeishuWriteService(c: any): FeishuWriteService {
  const configManager = c.configManager;
  const localMapStore = c.localMapStore;
  const larkCliClient = c.larkCliClient;
  const kbBuildService = c.kbBuildService;
  if (!configManager || !localMapStore || !larkCliClient || !kbBuildService) {
    throw new Error('dependencies_not_injected');
  }
  const dataRoot = resolveDataRoot();
  const editService = new SourceEditService({
    config: configManager,
    store: localMapStore,
    kbBuild: { isActive: () => kbBuildService.activeBuild(localMapStore) != null },
    dataRoot,
  });
  return new FeishuWriteService({
    config: configManager,
    store: localMapStore,
    larkCliClient,
    kbBuild: { isActive: () => kbBuildService.activeBuild(localMapStore) != null },
    dataRoot,
    readEditView: (objToken: string) => editService.read(objToken),
    // 单文档回拉：与 POST /api/sync 同一内部入口（SyncEngine apply 链，
    // enableLLM=false——写回拉回的是用户编辑文本，不叠加 LLM 整理；
    // 回拉成功由 SyncEngine.finalizePushedSourceEdit 清行删备份）。
    pullSync: (objToken: string) => pullSyncSingleDocument({ configManager, localMapStore, larkCliClient }, objToken),
  });
}

/** 单文档回拉（SyncEngine apply；与 POST /api/sync 同構造面）。 */
async function pullSyncSingleDocument(
  context: { configManager: any; localMapStore: any; larkCliClient: any },
  objToken: string,
): Promise<{ ok: boolean; status: string; message?: string }> {
  const { configManager, localMapStore, larkCliClient } = context;
  const config = await configManager.load();
  const channelConfig: ChannelConfig = {
    llm: config.llm,
    selection: config.agent?.model?.source === 'app-llm' ? config.agent.model : undefined,
  };
  const engine = new SyncEngine({
    larkCliClient,
    localMapStore,
    config,
    layoutReconstructor: new LayoutReconstructor(),
    contentAdapter: new ContentAdapter(new ContentBackendRegistry(channelConfig)),
  });
  const doc = localMapStore.getDocumentByObjToken(objToken);
  if (!doc) {
    return { ok: false, status: 'source_not_found', message: `文档不存在：${objToken}` };
  }
  const result = await engine.syncDocuments(
    [{
      objToken,
      objType: (doc.objType ?? 'docx') as 'docx',
      title: doc.title ?? '',
      changeType: 'modified' as const,
      cloudModifiedTime: new Date().toISOString(),
      localSyncedTime: doc.lastSyncedAt ?? null,
      localMdPath: doc.localMdPath ?? null,
      wikiNodeToken: doc.wikiNodeToken ?? null,
      parentNodeToken: doc.parentNodeToken ?? null,
      spaceId: doc.spaceId ?? null,
      watchedRootId: doc.watchedRootId ?? null,
      watchedRootUrl: doc.watchedRootUrl ?? null,
      localRelPath: doc.localRelPath ?? null,
      customFolderId: doc.customFolderId ?? null,
    }],
    { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' },
  );
  if (result.syncedDocuments.some((synced) => synced.objToken === objToken)) {
    return { ok: true, status: 'synced' };
  }
  const failure = result.failedDocuments.find((failed) => failed.objToken === objToken);
  return {
    ok: false,
    status: failure?.reasonCode ?? 'failed',
    message: failure?.error ?? '回拉同步未成功（可稍后手动同步该文档）',
  };
}

/**
 * POST /api/sources/:objToken/push/preview - 推送计划（不动 source_edits）。
 * → SourcePushPlanDto（mode/blockedReason/appendMarkdown/bytes/cloud/conflict/warnings）。
 */
feishuRoutes.post('/api/sources/:objToken/push/preview', async (c) => {
  try {
    const service = createFeishuWriteService(c);
    return c.json(await service.preview(c.req.param('objToken')));
  } catch (error) {
    if (error instanceof Error && error.message === 'dependencies_not_injected') {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }
    return pushErrorResponse(c, error);
  }
});

/**
 * POST /api/sources/:objToken/push - 执行写回。
 * body { allowOverwrite?, force?, confirm: 'PUSH' | 'OVERWRITE_CLOUD', actor? }
 * → { state, mode, revisionId, pull: { ok, status, message? } }。
 * confirm 门（§7.4）：append 且无 force → 'PUSH'；overwrite 或 force →
 * 'OVERWRITE_CLOUD'。
 */
feishuRoutes.post('/api/sources/:objToken/push', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid_json', message: '写回请求必须是 JSON 对象' }, 400);
  }
  if (body.confirm !== 'PUSH' && body.confirm !== 'OVERWRITE_CLOUD') {
    return c.json(
      {
        error: 'confirmation_required',
        message: '写回飞书需要 confirm: "PUSH"（追加）或 "OVERWRITE_CLOUD"（覆盖/强制）',
      },
      400,
    );
  }
  try {
    const service = createFeishuWriteService(c);
    const actor: SourceEditActor = body.actor === 'cli' || body.actor === 'agent' ? body.actor : 'ui';
    const result = await service.push(c.req.param('objToken'), {
      allowOverwrite: body.allowOverwrite === true,
      force: body.force === true,
      confirm: body.confirm,
      actor,
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'dependencies_not_injected') {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }
    return pushErrorResponse(c, error);
  }
});

export { feishuRoutes };
