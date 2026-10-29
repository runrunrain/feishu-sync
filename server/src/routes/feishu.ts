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
import {
  LarkCliManagerError,
  WRITE_SCOPES,
  allOptionalReadScopes,
} from '../modules/lark-cli-manager.js';
import { SourceEditService, SourceEditError } from '../sources/source-edit-service.js';
import { FeishuWriteService, FeishuWriteError } from '../sources/feishu-write-service.js';
import { CloudHistoryService, CloudHistoryError } from '../sources/cloud-history-service.js';
import {
  SourceTitleService,
  SourceTitleError,
  RENAME_CONFIRM_VALUE,
} from '../sources/source-title-service.js';
import { CloudMoveService, CloudMoveError } from '../sources/cloud-move-service.js';
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
 * P1-B（设计 §3.1/§3.4）：响应增补 optionalScopes {granted, missing}——
 * 注册表内全部可选读 scope 对照当前已授集合的分档。缺失不判定为授权
 * 不完整（不进 requiredScopes），设置页据「开关开启 ∧ 缺失」弹增量授权。
 */
feishuRoutes.get('/api/feishu/auth-status', async (c) => {
  const larkCliClient = (c as any).larkCliClient;

  // 注册表是静态常量；已授集合未知（异常态）时 granted 为空、missing 全量，
  // 形态保持稳定供前端消费。
  const optionalReadScopes = allOptionalReadScopes();
  try {
    const result = await larkCliClient.checkAuthReady();
    const granted = new Set<string>(result.currentScopes ?? []);
    return c.json({
      ...result,
      writeScopesGranted: WRITE_SCOPES.every((scope) => granted.has(scope)),
      optionalScopes: {
        granted: optionalReadScopes.filter((scope) => granted.has(scope)),
        missing: optionalReadScopes.filter((scope) => !granted.has(scope)),
      },
    });
  } catch (error) {
    return c.json({
      ready: false,
      writeScopesGranted: false,
      optionalScopes: { granted: [], missing: optionalReadScopes },
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
 * body { mode?, scopeSet?, includeOptionalScopes? }；scopeSet='write' 时请求集并入
 * WRITE_SCOPES（S12 写回授权入口；缺省 read，与既有读链路一致）。
 * P1-B（设计 §3.4）：includeOptionalScopes=true 时把已开启功能的可选读
 * scope 并入请求集（scopeSet 沿用当前值：body 未显式携带时由 Manager 按
 * 已授集合自动判定，避免开启读功能误申请写权限/丢已授写权限）。
 * → { verificationUrl, deviceCode, expiresIn, requestedScopes, scopeSet }；
 * 已有进行中流程时 409 device_auth_in_progress。
 */
feishuRoutes.post('/api/feishu/auth/device/start', async (c) => {
  let body: { mode?: unknown; scopeSet?: unknown; includeOptionalScopes?: unknown };
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
  const includeOptionalScopes = body.includeOptionalScopes === true;
  const scopeSet = body.scopeSet ?? 'read';
  if (scopeSet !== 'read' && scopeSet !== 'write') {
    return c.json({ error: 'invalid_body', message: 'scopeSet 只接受 "read" | "write"' }, 400);
  }
  if (body.includeOptionalScopes !== undefined && typeof body.includeOptionalScopes !== 'boolean') {
    return c.json({ error: 'invalid_body', message: 'includeOptionalScopes 只接受 boolean' }, 400);
  }
  try {
    const manager = requireLarkCliManager(c);
    // includeOptionalScopes 且未显式指定 scopeSet → 不传 scopeSet，交 Manager
    // 按已授集合自动判定（write ⊇ WRITE_SCOPES else read，§3.4）。
    const options: { scopeSet?: 'read' | 'write'; includeOptionalScopes?: boolean } = {};
    if (body.scopeSet !== undefined || !includeOptionalScopes) {
      options.scopeSet = scopeSet;
    }
    if (includeOptionalScopes) options.includeOptionalScopes = true;
    return c.json(await manager.startDeviceAuth(mode, options));
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

/** 写回链错误映射：FeishuWriteError/SourceEditError/CloudHistoryError/SourceTitleError → 声明码；其余 500。 */
function pushErrorResponse(c: any, error: unknown) {
  if (
    error instanceof FeishuWriteError
    || error instanceof SourceEditError
    || error instanceof CloudHistoryError
    || error instanceof SourceTitleError
  ) {
    const typed = error as FeishuWriteError | SourceEditError | CloudHistoryError | SourceTitleError;
    return c.json(
      {
        error: typed.code,
        message: typed.message,
        ...(typed.details ? { details: typed.details } : {}),
      },
      typed.status as 400 | 403 | 404 | 409 | 422 | 500,
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
    // T3e-R3-01：preview 表达本次执行语义——可选 body {force} 与 push 同参
    //（缺省/非 JSON 体 → false，向后兼容）。force 只越过时间门
    //（cloud_time_unreadable 降为 warning），权限/内容 blocker 语义不变。
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    return c.json(await service.preview(c.req.param('objToken'), { force: body?.force === true }));
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
      acknowledgedUnknownUpdatedAt: typeof body.acknowledgedUnknownUpdatedAt === 'string' ? body.acknowledgedUnknownUpdatedAt : undefined,
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

// ============================================================================
// P0-S4 云端历史与回滚 API（lark-cli-newcaps-P0 §4.3；本文件内追加，与
// push 面同模式——不动 routes/sources.ts）。服务实例由 index.ts 构造为
// 进程级单例（轮询器按 5s 节奏收敛 revert_state='running' 行）并经 DI
// 中间件注入（c.cloudHistoryService）；测试独立挂载时自行注入。
// ============================================================================

/** 构造 CloudHistoryService（index.ts 单例构造面；回拉与写回链同一入口）。 */
export function createCloudHistoryService(deps: {
  configManager: any;
  localMapStore: any;
  larkCliClient: any;
  kbBuildService: any;
}): CloudHistoryService {
  return new CloudHistoryService({
    config: deps.configManager,
    store: deps.localMapStore,
    larkCliClient: deps.larkCliClient,
    kbBuild: { isActive: () => deps.kbBuildService.activeBuild(deps.localMapStore) != null },
    dataRoot: resolveDataRoot(),
    pullSync: (objToken: string) =>
      pullSyncSingleDocument({
        configManager: deps.configManager,
        localMapStore: deps.localMapStore,
        larkCliClient: deps.larkCliClient,
      }, objToken),
  });
}

/** 从 DI 上下文取单例服务；未注入按依赖缺失处理（不静默重建轮询器）。 */
function requireCloudHistoryService(c: any): CloudHistoryService {
  const service = c.cloudHistoryService as CloudHistoryService | undefined;
  if (!service) {
    throw new Error('dependencies_not_injected');
  }
  return service;
}

/** 解析回滚目标请求体：{pushLogId} | {historyVersionId} 严格二选一。 */
function parseRevertTargetBody(body: Record<string, unknown>): {
  pushLogId?: string;
  historyVersionId?: string;
} {
  const pushLogId = typeof body.pushLogId === 'string' && body.pushLogId !== '' ? body.pushLogId : undefined;
  const historyVersionId = typeof body.historyVersionId === 'string' && body.historyVersionId !== ''
    ? body.historyVersionId : undefined;
  if ((pushLogId !== undefined) === (historyVersionId !== undefined)) {
    throw new CloudHistoryError(
      'invalid_body',
      '回滚目标必须且只提供 pushLogId 或 historyVersionId 之一',
      400,
    );
  }
  return pushLogId !== undefined ? { pushLogId } : { historyVersionId: historyVersionId as string };
}

/** GET /api/sources/:objToken/push-log - 写回记录（created_at 倒序，含锚点与回滚状态；S5 UI 消费）。 */
feishuRoutes.get('/api/sources/:objToken/push-log', (c) => {
  try {
    const store = (c as any).localMapStore;
    if (!store) throw new Error('dependencies_not_injected');
    const logs = store.listSourcePushLogs(c.req.param('objToken'), 50);
    return c.json({ logs });
  } catch (error) {
    if (error instanceof Error && error.message === 'dependencies_not_injected') {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }
    console.error('[feishu] push-log failed:', error);
    return c.json({ error: 'push_log_read_failed', message: error instanceof Error ? error.message : String(error) }, 500);
  }
});

/**
 * GET /api/sources/:objToken/history?pageToken=&pageSize= - 云端历史。
 * 缺省从第一页聚合（上限 3 页，truncated=true 时 nextPageToken 续翻）；
 * 显式 pageToken 单页透传（UI 抽屉 load-more）。
 */
feishuRoutes.get('/api/sources/:objToken/history', async (c) => {
  try {
    const service = requireCloudHistoryService(c);
    const pageToken = c.req.query('pageToken');
    const pageSizeRaw = Number(c.req.query('pageSize'));
    const result = await service.listCloudHistory(c.req.param('objToken'), {
      ...(pageToken ? { pageToken } : {}),
      ...(Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1 ? { pageSize: pageSizeRaw } : {}),
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'dependencies_not_injected') {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }
    return pushErrorResponse(c, error);
  }
});

/**
 * GET /api/sources/:objToken/history-content?revisionId=<n> - 只读云端正文。
 * revisionId 缺省 = **云端当前正文**（不带 --revision-id 的最新版，T4b-08
 * 对比弹窗「对比云端当前」的真实数据源）；显式 revisionId 按历史 revision
 * 读取（P0-S1 HP-3 实测 revision_id 数值 id 空间）。只读，不碰本地基线。
 */
feishuRoutes.get('/api/sources/:objToken/history-content', async (c) => {
  try {
    const service = requireCloudHistoryService(c);
    const revisionIdParam = c.req.query('revisionId');
    let revisionId: number | null = null;
    if (revisionIdParam !== undefined && revisionIdParam !== '') {
      const parsed = Number(revisionIdParam);
      if (!Number.isFinite(parsed)) {
        throw new CloudHistoryError('invalid_body', 'revisionId 查询参数必须是数值', 400);
      }
      revisionId = parsed;
    }
    const result = await service.fetchCloudRevision(c.req.param('objToken'), revisionId);
    return c.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'dependencies_not_injected') {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }
    return pushErrorResponse(c, error);
  }
});

/** POST /api/sources/:objToken/history-revert/preview - 回滚计划（只读；会调 history-list 与 drive meta）。 */
feishuRoutes.post('/api/sources/:objToken/history-revert/preview', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid_json', message: '回滚预览请求必须是 JSON 对象' }, 400);
  }
  try {
    const service = requireCloudHistoryService(c);
    const plan = await service.buildRevertPlan(c.req.param('objToken'), parseRevertTargetBody(body));
    return c.json(plan);
  } catch (error) {
    if (error instanceof Error && error.message === 'dependencies_not_injected') {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }
    return pushErrorResponse(c, error);
  }
});

/** 未知回滚任务的状态核对；无 taskId 需人工确认云端已结束。 */
feishuRoutes.post('/api/sources/:objToken/reverts/:pushLogId/reconcile', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await requireCloudHistoryService(c).reconcileUnknownRevert(
      c.req.param('objToken'), c.req.param('pushLogId'), body?.confirm,
    );
    return c.json(result);
  } catch (error) {
    return pushErrorResponse(c, error);
  }
});

/**
 * POST /api/sources/:objToken/history-revert - 执行回滚（destructive 逐次确认）。
 * body { pushLogId | historyVersionId, confirm: 'REVERT_CLOUD:<historyVersionId>', actor? }；
 * 异步起步返回 202 { state:'running', taskId, pushLogId }；同步完成 200。
 */
feishuRoutes.post('/api/sources/:objToken/history-revert', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid_json', message: '回滚请求必须是 JSON 对象' }, 400);
  }
  if (typeof body.confirm !== 'string' || body.confirm === '') {
    return c.json(
      {
        error: 'confirmation_required',
        message: '回滚云端历史需要 confirm: "REVERT_CLOUD:<historyVersionId>"（确认值必须包含目标版本 id）',
      },
      400,
    );
  }
  try {
    const service = requireCloudHistoryService(c);
    const result = await service.revertToAnchor(c.req.param('objToken'), parseRevertTargetBody(body), {
      confirmValue: body.confirm,
      actor: body.actor === 'cli' || body.actor === 'agent' ? body.actor : 'ui',
    });
    return c.json(result, result.state === 'running' ? 202 : 200);
  } catch (error) {
    if (error instanceof Error && error.message === 'dependencies_not_injected') {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }
    return pushErrorResponse(c, error);
  }
});

// ============================================================================
// P0-S9 标题同步 API（lark-cli-newcaps-P0 §6.2；与 push/回滚面同文件同模式）。
// 服务无进程级状态（无轮询器），每请求构造（与 createFeishuWriteService 同模式）。
// ============================================================================

/** 从请求上下文构造 SourceTitleService（每请求新建；回拉与写回/回滚同一入口）。 */
function createSourceTitleService(c: any): SourceTitleService {
  const configManager = c.configManager;
  const localMapStore = c.localMapStore;
  const larkCliClient = c.larkCliClient;
  const kbBuildService = c.kbBuildService;
  if (!configManager || !localMapStore || !larkCliClient || !kbBuildService) {
    throw new Error('dependencies_not_injected');
  }
  return new SourceTitleService({
    config: configManager,
    store: localMapStore,
    larkCliClient,
    kbBuild: { isActive: () => kbBuildService.activeBuild(localMapStore) != null },
    dataRoot: resolveDataRoot(),
    pullSync: (objToken: string) =>
      pullSyncSingleDocument({ configManager, localMapStore, larkCliClient }, objToken),
  });
}

/** 解析改名请求体：{ title }（非字符串/缺失 → 400）。 */
function parseRenameBody(body: Record<string, unknown>): { title: unknown } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SourceTitleError('invalid_json', '改名请求必须是 JSON 对象', 400);
  }
  return { title: body.title };
}

/**
 * POST /api/sources/:objToken/title/preview - 改名计划（只读，不调用远端写；§6.2）。
 * body { title } → TitleRenamePlan（target/from/to/blockedReason/warnings）。
 */
feishuRoutes.post('/api/sources/:objToken/title/preview', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid_json', message: '改名预览请求必须是 JSON 对象' }, 400);
  }
  try {
    const service = createSourceTitleService(c);
    return c.json(await service.buildRenamePlan(c.req.param('objToken'), parseRenameBody(body).title));
  } catch (error) {
    if (error instanceof Error && error.message === 'dependencies_not_injected') {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }
    return pushErrorResponse(c, error);
  }
});

/**
 * POST /api/sources/:objToken/title - 在飞书重命名（remote_write 逐次确认；§6.2）。
 * body { title, confirm: 'RENAME', actor? } → TitleRenameResult（含锁外回拉结果；
 * 回拉失败只记 pull 字段，交检测链自然收敛）。
 */
feishuRoutes.post('/api/sources/:objToken/title', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid_json', message: '改名请求必须是 JSON 对象' }, 400);
  }
  if (body.confirm !== RENAME_CONFIRM_VALUE) {
    return c.json(
      {
        error: 'confirmation_required',
        message: `在飞书改名需要 confirm: "${RENAME_CONFIRM_VALUE}"`,
      },
      400,
    );
  }
  try {
    const service = createSourceTitleService(c);
    const result = await service.renameCloudTitle(c.req.param('objToken'), parseRenameBody(body).title, {
      confirmValue: body.confirm,
      actor: body.actor === 'cli' || body.actor === 'agent' ? body.actor : 'ui',
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'dependencies_not_injected') {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }
    return pushErrorResponse(c, error);
  }
});

// ============================================================================
// P2-S6 安全移出 API（lark-cli-newcaps-P2 §3.4；与回滚/改名面同文件同模式）。
// 服务有轮询器（进程级状态）：index.ts 构造为进程级单例并经 DI 注入
//（c.cloudMoveService）；测试独立挂载时自行注入。
// ============================================================================

/** 从 DI 上下文取单例服务；未注入按依赖缺失处理（不静默重建轮询器）。 */
function requireCloudMoveService(c: any): CloudMoveService {
  const service = c.cloudMoveService as CloudMoveService | undefined;
  if (!service) {
    throw new Error('dependencies_not_injected');
  }
  return service;
}

/**
 * 构造 CloudMoveService（index.ts 单例构造面）。detectRoot：moved 收尾
 * 触发该 watchedRoot 的一次既有变更检测（只推进观测字段；index.ts 接
 * changeDetector.detectChanges，测试可注入 spy 或省略）。
 */
export function createCloudMoveService(deps: {
  configManager: any;
  localMapStore: any;
  larkCliClient: any;
  kbBuildService: any;
  dataRoot?: string;
  detectRoot?(watchedRootId: string): Promise<unknown>;
}): CloudMoveService {
  return new CloudMoveService({
    config: deps.configManager,
    store: deps.localMapStore,
    larkCliClient: deps.larkCliClient,
    kbBuild: { isActive: () => deps.kbBuildService.activeBuild(deps.localMapStore) != null },
    dataRoot: deps.dataRoot ?? resolveDataRoot(),
    ...(deps.detectRoot ? { detectRoot: deps.detectRoot } : {}),
  });
}

/** 移出链错误映射：CloudMoveError → 声明码；其余复用 pushErrorResponse。 */
function moveErrorResponse(c: any, error: unknown) {
  if (error instanceof CloudMoveError) {
    return c.json(
      { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      error.status as 400 | 403 | 404 | 409 | 422 | 500,
    );
  }
  return pushErrorResponse(c, error);
}

/**
 * POST /api/sources/:objToken/move-to-drive/preview - 移出预览（只读，会调
 * getNode 实时取叶子状态）。body { folderToken? } → MoveOutPreview
 *（blockedReason 门控面 + consequences 固定文案）。
 */
feishuRoutes.post('/api/sources/:objToken/move-to-drive/preview', (c) => c.json({ error: 'feature_removed', message: '移出到云空间功能已移除' }, 410));

/**
 * POST /api/sources/:objToken/move-to-drive - 执行移出（destructive 逐次确认）。
 * body { folderToken?, confirm: 'MOVE_OUT:<nodeToken>', actor? }；异步起步
 * 返回 202 { state:'moving', moveId, taskId }；同步完成 200。
 * 移出后本地文件与标准库不动（§3.5，移出仅云端动作）。
 */
feishuRoutes.post('/api/sources/:objToken/move-to-drive', (c) => c.json({ error: 'feature_removed', message: '移出到云空间功能已移除' }, 410));

/** GET /api/sources/moves/:moveId - 移出记录（cloud.move_status；不触发远端调用）。 */
feishuRoutes.get('/api/sources/moves/:moveId', (c) => {
  try {
    const service = requireCloudMoveService(c);
    return c.json(service.getMove(c.req.param('moveId')));
  } catch (error) {
    if (error instanceof Error && error.message === 'dependencies_not_injected') {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }
    return moveErrorResponse(c, error);
  }
});

/** GET /api/sources/moves?objToken=&limit= - 移出记录列表（cloud.moves）。 */
feishuRoutes.get('/api/sources/moves', (c) => {
  try {
    const service = requireCloudMoveService(c);
    const objToken = c.req.query('objToken');
    const limitRaw = Number(c.req.query('limit'));
    return c.json(service.listMoves({
      objToken: typeof objToken === 'string' && objToken !== '' ? objToken : null,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined,
    }));
  } catch (error) {
    if (error instanceof Error && error.message === 'dependencies_not_injected') {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }
    return moveErrorResponse(c, error);
  }
});

/**
 * POST /api/sources/moves/:moveId/reconcile - unknown 移出的权威核对（T4b-05
 * 围栏解除入口）：查询任务终态；无可靠任务状态时要求人工确认任务已结束及去向。
 * 确认未移出时还需检查节点身份；不发起任何云端写入。
 */
feishuRoutes.post('/api/sources/moves/:moveId/reconcile', async (c) => {
  try {
    const service = requireCloudMoveService(c);
    const body = await c.req.json().catch(() => ({}));
    const result = await service.reconcileUnknownMove(c.req.param('moveId'), body?.confirm);
    return c.json(result, result.state === 'unknown' ? 202 : 200);
  } catch (error) {
    if (error instanceof Error && error.message === 'dependencies_not_injected') {
      return c.json({ error: 'dependencies_not_injected' }, 500);
    }
    return moveErrorResponse(c, error);
  }
});

export { feishuRoutes };
