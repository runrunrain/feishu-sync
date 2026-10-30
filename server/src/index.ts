/**
 * Feishu Sync - Server Entry Point
 *
 * Hono API server with embedded desktop mode support.
 * Handles health check, configuration, change detection, sync, and Feishu integration.
 *
 * Based on tts-voice-generator server structure with feishu-specific adaptations.
 */

import { Hono } from 'hono';
import { PiPluginService } from './agent/pi-plugin-service.js';
import { piPluginRoutes } from './routes/pi-plugins.js';
import { AppPluginStore } from './agent/app-plugin-store.js';
import { agentPluginRoutes } from './routes/agent-plugins.js';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataRoot } from './modules/data-root.js';
import type { Server as HttpServer } from 'node:http';

import { filterDeletedLocalDocuments, reconcileLocalIndex } from './modules/local-index-reconcile.js';
import { SnapshotService } from './modules/snapshot-service.js';
import { ConfigManager } from './modules/config-manager.js';
import { LarkCliClient } from './modules/lark-cli-client.js';
import { LarkCliManager } from './modules/lark-cli-manager.js';
import { LocalMapStore } from './modules/local-map-store.js';
import { ChangeDetector } from './modules/change-detector.js';
import { authMiddleware } from './middleware/auth.js';
import { corsMiddleware } from './middleware/cors.js';
import { CliEndpoint } from './cli-endpoint.js';
import { cliRoutes } from './routes/cli.js';
import { KbLanGatewayManager } from './kb-lan/gateway-manager.js';
import { kbLanMcpRoutes } from './routes/kb-lan-mcp.js';
import { kbMcpInstallRoutes } from './routes/kb-mcp-install.js';
import { McpClientInstaller } from './kb/mcp-client-installer.js';
import { kbMcpInfo } from './kb/mcp-info.js';
import { cliAdminRoutes } from './routes/cli-admin.js';
import { healthRoutes } from './routes/health.js';
import { configRoutes } from './routes/config.js';
import { detectRoutes } from './routes/detect.js';
import { syncRoutes } from './routes/sync.js';
import { feishuRoutes, createCloudHistoryService, createCloudMoveService } from './routes/feishu.js';
import { kbPublicationsRoutes } from './routes/kb-publications.js';
import { createPublishOverlapConfigHook } from './kb/publication-service.js';
import { mappingRoutes } from './routes/mapping.js';
import { contentRoutes } from './routes/content.js';
import { trashRoutes } from './routes/trash.js';
import { customFolderRoutes } from './routes/custom-folders.js';
import { orphanFilesRoutes } from './routes/orphan-files.js';
import { sourcesRoutes } from './routes/sources.js';
import { llmRoutes } from './routes/llm.js';
import { agentInternalRoutes } from './routes/agent-internal.js';
import { VisionDescriber } from './agent/vision/vision-describer.js';
import { agentRoutes } from './routes/agent.js';
import { kbRoutes } from './routes/kb.js';
import { PiRuntimeResolver } from './agent/runtime-resolver.js';
import { AgentProcessPool } from './agent/agent-process-pool.js';
import { AgentToolService } from './agent/agent-tool-service.js';
import { SessionService } from './agent/session-service.js';
import { RoleRegistry } from './agent/tasks/role-registry.js';
import { TaskService } from './agent/tasks/task-service.js';
import { taskToolFamily } from './agent/tasks/task-tools.js';
import { TASK_TOOL_FAMILY_NAME, TASK_TOOL_NAMES } from './agent/tool-specs.js';
import { ApprovalService } from './agent/approvals/approval-service.js';
import { createOpsToolFamily } from './agent/tools/app-command-family.js';
import { KbBuildService } from './kb/kb-build-service.js';
import { projectKnowledgeDocuments, recoveredSourceCsvPaths } from './kb/local-source-projection.js';
import { piExtensionPath, readAgentPromptAssets } from './agent/agent-assets.js';
import { RuntimeInstaller } from './agent/runtime-installer.js';
import { checkRootOverlap, type WorkspaceRootGuards } from './agent/path-guard.js';
import { collectResolvedRuntimeProtectedRoots, collectStaticProtectedRoots } from './agent/protected-roots.js';
import type { LarkCliConfig } from './types/index.js';

// ============================================================================
// Configuration and Constants
// ============================================================================

const DEFAULT_PORT = 3001;
/** server.close() 等待活跃连接收尾的宽限期，超时后强制销毁全部连接。 */
const SHUTDOWN_GRACE_MS = 3_000;

export interface CreateServerOptions {
  desktopMode?: boolean;
  desktopToken?: string;
  configPath?: string;
  /**
   * P0-bug-1 fix (v0.2.0 P5): independently control the CORS dev gate.
   *
   * desktopMode alone cannot distinguish "real Electron (origin app://,
   * same-origin, browser never involved)" from "standalone dev:all
   * (vite at http://localhost:5173 making cross-origin requests to
   * http://127.0.0.1:3001)" — both run with desktopMode=true. So the
   * CORS dev gate is now driven by this explicit flag instead.
   *
   *   - Electron production (electron/main.ts) → leave undefined / false
   *     → CORS enforces expectedOrigin `app://feishu-sync.local`
   *   - Standalone dev:all (isMainModule entry below) → set true
   *     → CORS allows http://localhost:5173 + http://127.0.0.1:5173
   */
  corsDevMode?: boolean;
}

export interface StartedServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

// ============================================================================
// Server Factory
// ============================================================================

export async function buildServer(options: CreateServerOptions = {}) {
  console.info('[server] buildServer started');

  const {
    desktopMode = false,
    desktopToken: providedDesktopToken,
    configPath,
    corsDevMode = false,
  } = options;

  // Generate or use provided desktop token
  const desktopToken = providedDesktopToken || crypto.randomBytes(32).toString('base64url');
  console.info('[server] Desktop token generated');

  // Note: desktopToken is passed to auth middleware via c.env, not used here directly
  void desktopToken; // Suppress unused variable warning

  // Initialize dependencies
  console.info('[server] Initializing ConfigManager');
  const configManager = new ConfigManager(configPath);
  console.info('[server] ConfigManager initialized');

  // Load the user configuration before constructing LarkCliClient. lark-cli
  // 可执行路径不再可配置（2026-10 移除 larkCliPath 设置项）：统一由
  // LarkCliClient 内部的 PATH + 桌面发现目录解析，部署级逃生口是
  // LARK_CLI_PATH 环境变量。
  console.info('[server] Loading config');
  await configManager.load();
  const config = await configManager.initializeKnowledgeBase();
  console.info('[server] Config loaded');

  console.info('[server] Initializing LocalMapStore');
  const dbPath = path.join(resolveDataRoot(), 'feishu-sync.db');
  console.info('[server] Database path:', dbPath);
  const localMapStore = new LocalMapStore(dbPath);
  console.info('[server] LocalMapStore initialized');

  console.info('[server] Initializing LarkCliClient');
  const larkCliConfig: LarkCliConfig = {
    // Keep aligned with ConfigManager DEFAULT_REQUIRED_SCOPES (min sync boundary).
    requiredScopes: config.requiredScopes.length > 0 ? config.requiredScopes : [
      'wiki:node:retrieve',
      'wiki:space:retrieve',
      'docs:document.content:read',
      'sheets:spreadsheet:read',
      'docx:document:readonly',
      'drive:drive.metadata:readonly',
      'docs:document.media:download',
      'slides:presentation:read',
      'offline_access',
    ],
    timeout: 30000,
  };
  const larkCliClient = new LarkCliClient(larkCliConfig);
  console.info('[server] LarkCliClient initialized');

  // T4b-03（P1 §4.1 防线 1）：发布根↔watchedRoots 候选配置联合校验——
  // 通用 PUT /api/config 与专用 target 路由两入口两方向都做祖先链交叉
  // 验证，祖先链不可读 fail-closed 拒绝（钩子在 ConfigManager.updateConfig
  // 收敛，专用路由自身仍独立校验）。
  configManager.setPublishOverlapHook(
    createPublishOverlapConfigHook((token: string) => larkCliClient.getNode(token)),
  );

  // Initialize LarkCliManager (in-app lark-cli install/update + device auth onboarding)
  console.info('[server] Initializing LarkCliManager');
  const larkCliManager = new LarkCliManager(larkCliClient, configManager);
  console.info('[server] LarkCliManager initialized');

  // Initialize database schema
  console.info('[server] Initializing database schema');
  localMapStore.initialize();
  console.info('[server] Database schema initialized');

  // S12（设计 §7.4）：上次进程退出时未终态的写回推送行置 conflict
  //（push_interrupted，需用户核对云端后重推或放弃）。行数仅供日志观察。
  const interruptedPushes = localMapStore.markInterruptedSourceEditPushes();
  if (interruptedPushes > 0) {
    console.info(`[server] source edits reconciled: ${interruptedPushes} pushing → conflict`);
  }

  // P1-S8（设计 P1 §4.2）：残留 creating 发布行置 unknown（创建是否落地
  // 不确定，不自动重建，交人工核对后经 force 重新发布为新文档）。
  const interruptedPublications = localMapStore.reconcileKbPublicationsCreating();
  if (interruptedPublications > 0) {
    console.info(`[server] kb publications reconciled: ${interruptedPublications} creating → unknown`);
  }

  // P0-S3（lark-cli-newcaps-P0 §4.1 启动对账）：source_push_log 残留的
  // started 行置 unknown——写回是否落地不确定，不自动判定成败；交 S5
  // UI「请对比云端当前」与下一次检测链自然收敛。
  const interruptedPushLogs = localMapStore.markInterruptedSourcePushLogs();
  if (interruptedPushLogs > 0) {
    console.info(`[server] source push log reconciled: ${interruptedPushLogs} started → unknown`);
  }

  // Initialize ChangeDetector
  console.info('[server] Initializing ChangeDetector');
  const changeDetector = new ChangeDetector(
    larkCliClient,
    localMapStore,
    {
      knowledgeBaseRoot: config.knowledgeBaseRoot,
      knowledgeBaseRootProvider: () => configManager.getConfig()?.knowledgeBaseRoot ?? '',
    }
  );
  console.info('[server] ChangeDetector initialized');

  // ===========================================================================
  // Agent 标准知识库（F1）：运行时发现 / 进程池 / 工具服务 / 会话 / 构建
  // ===========================================================================
  console.info('[server] Initializing Agent knowledge modules');
  const agentDataRoot = resolveDataRoot();

  const runtimeResolver = new PiRuntimeResolver();
  const agentPool = new AgentProcessPool({
    maxConcurrentProcesses: config.agent.maxConcurrentProcesses,
    idleTimeoutMinutes: config.agent.idleTimeoutMinutes,
  });
  const knowledgeDocuments = () => {
    const root = configManager.getConfig()?.knowledgeBaseRoot ?? '';
    reconcileLocalIndex(localMapStore, root, () => new SnapshotService(localMapStore, configManager, { larkCliClient, config: configManager.getConfig() }).generate());
    return projectKnowledgeDocuments(root, filterDeletedLocalDocuments(localMapStore, root, localMapStore.getAllDocuments()));
  };
  const sheetCsvPaths = (objToken: string): string[] => {
    const mapped = localMapStore.getSheetSheets(objToken)
      .map((sheet) => sheet.local_csv_path)
      .filter((csvPath) => typeof csvPath === 'string' && csvPath.length > 0);
    const record = localMapStore.getDocumentByObjToken(objToken);
    if (!record || (record.objType !== 'sheet' && record.objType !== 'bitable')) return mapped;
    const root = configManager.getConfig()?.knowledgeBaseRoot ?? '';
    return recoveredSourceCsvPaths(root, projectKnowledgeDocuments(root, [record])[0], mapped);
  };
  // S3：共享 VisionDescriber（会话内联/raw_read_image + 构建预描述 + changes 计数）
  const visionDescriber = new VisionDescriber({
    dataRoot: agentDataRoot,
    config: () => configManager.load(),
  });
  const agentToolService = new AgentToolService({
    dataRoot: agentDataRoot,
    documentsProvider: knowledgeDocuments,
    sheetCsvPaths,
    workspaceGuard: (workspaceRoot) => checkRootOverlap(workspaceRoot, workspaceGuardsSnapshot()),
    visionDescriber,
    // P1-S4（§2.4）：引用图查询面——raw_read 末页追加与 raw_links 工具；
    // 入边按 obj_token 与 wiki_node_token 双键并集（§2.3）。
    sourceLinks: (objToken) => {
      const doc = localMapStore.getDocumentByObjToken(objToken);
      const inTokens = [objToken, doc?.wikiNodeToken ?? null].filter(
        (token): token is string => typeof token === 'string' && token.length > 0,
      );
      return {
        out: localMapStore.listSourceReferencesBySrc(objToken),
        in: localMapStore.listSourceReferencesByTarget(inTokens),
      };
    },
    // P2-S4（§5.1）：评论溯源查询面——raw_comments 只读工具（仅
    // Discuss/Work）；meta 无行 = 从未采集（非 docx 或未同步）。
    comments: (objToken) => ({
      meta: localMapStore.getSourceCommentMeta(objToken),
      comments: localMapStore.listSourceCommentsBySrc(objToken),
    }),
  });
  // 回环内部 API 基址：端口在 startServer 监听后回填（构建/会话 spawn 前必然已知）
  const agentInternalPort = { port: null as number | null };
  const runtimeInstaller = new RuntimeInstaller(agentDataRoot, runtimeResolver, agentPool, () => configManager.getConfig()!.agent);
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) void runtimeInstaller.ensureMissing().catch((error) => console.warn('[agent] 自动安装未完成:', error instanceof Error ? error.message : 'unknown error'));
  // F3-R02：当前配置快照的 Workspace 守卫。受保护运行根 = 静态（源码/
  // node_modules/Electron）+ 服务生命周期已发现的运行时根（node/pi/npm）。
  // 切换配置不会终止旧进程，因此旧安装根到服务重启前也不能开放为Workspace。
  const workspaceGuardsSnapshot = (): WorkspaceRootGuards => {
    const config = configManager.getConfig();
    return {
      knowledgeBaseRoot: config?.knowledgeBaseRoot ?? '',
      outputRoot: config?.standardKb.outputRoot ?? '',
      dataRoot: agentDataRoot,
      protectedRoots: [...collectStaticProtectedRoots(), ...collectResolvedRuntimeProtectedRoots(runtimeResolver), ...piPlugins.protectedRoots()],
    };
  };
  void (async () => {
    try {
      const agentConfig = configManager.getConfig()?.agent;
      if (agentConfig) {
        await runtimeResolver.resolveRuntime(agentConfig);
      }
    } catch {
      /* 发现失败时静态根仍生效；spawn 时 resolver 会给出明确错误 */
    }
  })();
  const piPlugins: PiPluginService = new PiPluginService({
    dataRoot: agentDataRoot, resolver: runtimeResolver,
    agentConfig: () => configManager.getConfig()!.agent,
    // R2-05：插件管理互斥纳入后台任务——会话/构建之外，queued/running/
    // blocked 的编排任务也算活跃（任务进程不标 busy 的窗口与冻结快照都
    // 受插件变更影响），有任务时 plugin_busy 拒绝。
    running: (): boolean => sessionService.hasActiveRuns() || kbBuildService.hasActiveRun()
      || (tasks.service?.hasPendingWork(localMapStore) ?? false),
    retireIdle: () => agentPool.retireIdle(),
  });
  await piPlugins.refresh().catch(() => { console.warn('[server] Pi插件资源暂不可用，可在设置中刷新；其他功能继续启动'); });
  const appPluginStore: AppPluginStore = new AppPluginStore(agentDataRoot, readAgentPromptAssets, () => piPlugins.runtimeResources());
  // S6 任务编排：TaskService 在 sessionService 之后构造（SSE 事件出口回
  // 挂到 sessionService.emitSse）；taskTools 在每次 spawn 时求值，插件开关
  // 变更后的首个新 run 生效。父会话删除 → 其非终态子任务取消。
  const tasks: { service: TaskService | null } = { service: null };
  const sessionService: SessionService = new SessionService({
    dataRoot: agentDataRoot,
    pool: agentPool,
    toolService: agentToolService,
    resolver: runtimeResolver,
    configProvider: () => configManager.getConfig(),
    internalBaseUrl: () => (agentInternalPort.port ? `http://127.0.0.1:${agentInternalPort.port}` : ''),
    extensionPath: piExtensionPath,
    pluginStore: appPluginStore,
    workspaceGuards: workspaceGuardsSnapshot,
    taskTools: () => tasks.service
      ? { enabled: tasks.service.orchestrationEnabled(), names: TASK_TOOL_NAMES, family: TASK_TOOL_FAMILY_NAME }
      : null,
    onSessionDeleted: (sessionId) => {
      void tasks.service?.cancelSessionTasks(localMapStore, sessionId);
    },
  });
  const kbBuildService = new KbBuildService({
    dataRoot: agentDataRoot,
    pool: agentPool,
    toolService: agentToolService,
    resolver: runtimeResolver,
    configProvider: () => configManager.getConfig(),
    documentsProvider: knowledgeDocuments,
    excludedSourcesProvider: () => localMapStore.listKbExcludedSources(configManager.getConfig()?.knowledgeBaseRoot ?? ''),
    publishedTokensProvider: () => localMapStore.listPublishedCloudTokens(),
    sheetCsvPaths,
    internalBaseUrl: () => (agentInternalPort.port ? `http://127.0.0.1:${agentInternalPort.port}` : ''),
    extensionPath: piExtensionPath,
    pluginStore: appPluginStore,
    promptAssets: readAgentPromptAssets,
    visionDescriber,
  });
  // 启动对账：非终态构建置 interrupted；CURRENT 指针为准补 DB
  const reconcile = kbBuildService.reconcileOnStartup(localMapStore);
  if (reconcile.interruptedBuildIds.length > 0) {
    console.info(`[server] kb builds reconciled: ${reconcile.interruptedBuildIds.join(', ')} → interrupted`);
  }
  // P0-S4（lark-cli-newcaps-P0 §4.4）：云端历史回滚服务（进程级单例——
  // 轮询器按 5s 节奏收敛 revert_state='running' 行，单行总上限 10 分钟）。
  // 启动对账：残留 running 回滚行有 task_id 交轮询器续查，无 task_id 置
  // unknown（revert 非幂等，不自动重试）。DI 注入 routes/feishu 回滚面。
  const cloudHistoryService = createCloudHistoryService({
    configManager,
    localMapStore,
    larkCliClient,
    kbBuildService,
  });
  const revertReconcile = cloudHistoryService.resumeRunningReverts();
  if (revertReconcile.resumed > 0 || revertReconcile.markedUnknown > 0) {
    console.info(`[server] cloud reverts reconciled: ${revertReconcile.resumed} resumed, ${revertReconcile.markedUnknown} → unknown`);
  }
  cloudHistoryService.startPoller();
  // P2-S6（lark-cli-newcaps-P2 §3.4）：安全移出服务（进程级单例——轮询
  // 器按 5s 节奏收敛 cloud_moves.state='moving' 行，单行总上限 10 分钟）。
  // 启动对账：pending 行 → unknown；moving 有 task_id 交轮询器续查，无
  // task_id → unknown（移出非幂等，不自动重试）。moved 收尾触发该
  // watchedRoot 一次既有变更检测（只推进观测字段）。DI 注入 routes/feishu。
  const cloudMoveService = createCloudMoveService({
    configManager,
    localMapStore,
    larkCliClient,
    kbBuildService,
    detectRoot: async (watchedRootId: string) => {
      const root = (configManager.getConfig()?.watchedRoots ?? []).find(
        (item: { id?: string; url?: string }) => item?.id === watchedRootId,
      );
      if (!root?.url) return null;
      return changeDetector.detectChanges(root.url, { forceFresh: true });
    },
  });
  const moveReconcile = cloudMoveService.resumeRunningMoves();
  if (moveReconcile.resumed > 0 || moveReconcile.markedUnknown > 0) {
    console.info(`[server] cloud moves reconciled: ${moveReconcile.resumed} resumed, ${moveReconcile.markedUnknown} → unknown`);
  }
  cloudMoveService.startPoller();
  // ===========================================================================
  // S6 任务编排（设计 kb-agent-upgrade §5）：RoleRegistry + TaskService +
  // task_* 工具族。状态机/队列在 server（agent_tasks）；子任务进程走
  // pool.acquire('background')（与构建 worker 共用后台配额）；插件快照
  // 取派发时父会话 revision 冻结。触发标准库构建只能经 app_command
  // kb.build（S10 ops 族，上面已注册）——TaskService 不提供构建入口。
  // ===========================================================================
  const roleRegistry = new RoleRegistry();
  tasks.service = new TaskService({
    dataRoot: agentDataRoot,
    pool: agentPool,
    toolService: agentToolService,
    roles: roleRegistry,
    resolver: runtimeResolver,
    configProvider: () => configManager.getConfig(),
    sessionConfig: (id) => {
      try { return sessionService.configForSession(localMapStore, id, configManager.getConfig()); }
      catch { return null; }
    },
    sessionInfo: (sessionId) => {
      const row = localMapStore.getAgentSession(sessionId);
      if (!row) return null;
      const workspaceId = row.mode === 'work' && row.workspace_id != null ? String(row.workspace_id) : null;
      const workspace = workspaceId
        ? configManager.getConfig()?.agent.workspaces.find((candidate) => candidate.id === workspaceId) ?? null
        : null;
      return {
        id: sessionId,
        mode: row.mode === 'work' ? 'work' : 'discuss',
        workspaceId,
        workspacePath: workspace?.path ?? null,
      };
    },
    internalBaseUrl: () => (agentInternalPort.port ? `http://127.0.0.1:${agentInternalPort.port}` : ''),
    emitTaskUpdate: (sessionId, dto) => sessionService.emitSse(sessionId, 'task_update', dto),
    extensionPath: piExtensionPath,
    orchestrationEnabled: () => appPluginStore.list().plugins.some((plugin) => plugin.id === 'orchestration' && plugin.enabled),
    pluginRevision: (scope, backend) => {
      try {
        return appPluginStore.snapshot(scope, { includeNative: backend !== 'claude-code' }).revision;
      } catch {
        return null;
      }
    },
    frozenSnapshot: (scope, revision, backend) => appPluginStore.frozenSnapshot(scope, revision, { includeNative: backend !== 'claude-code' }),
  });
  agentToolService.registerToolFamily(taskToolFamily({ service: tasks.service, store: localMapStore }));
  // 启动对账：queued/running 任务 → interrupted（blocked 保留可作答）
  const interruptedTaskIds = tasks.service.reconcileOnStartup(localMapStore);
  if (interruptedTaskIds.length > 0) {
    console.info(`[server] agent tasks reconciled: ${interruptedTaskIds.join(', ')} → interrupted`);
  }
  console.info('[server] Agent knowledge modules initialized');

  // ========================================================================
  // S8：CLI 命令行访问端点（设计 kb-agent-upgrade §6.2）
  // ========================================================================
  // 令牌与 desktop token 完全分离；endpoint.json 只在 cli.enabled 时
  // 发布（startServer 拿到实际端口后回调 onServerStarted）。
  const cliEndpoint = new CliEndpoint(agentDataRoot, {
    enabledProvider: () => configManager.getConfig()?.cli?.enabled === true,
  });

  const kbLanGateway = new KbLanGatewayManager({ dataRoot: agentDataRoot, config: configManager });

  // Create Hono app
  console.info('[server] Creating Hono app');
  const app = new Hono();
  console.info('[server] Hono app created');

  // ===========================================================================
  // S10：会话内批准流 + app_command（设计 kb-agent-upgrade §6.5）
  // ===========================================================================
  // ApprovalService 的事件出口接到 SessionService.emitSse（approval_request /
  // approval_resolved 并入会话 SSE 流）；run_end（含用户中止）时取消该会话
  // 全部 pending 批准，防止「运行已停、批准迟到仍执行命令」。app_command
  // 经 S1 工具族注册模型挂入 ops 族：read 直通，非 read 挂起等待批准，
  // 执行与 S8 CLI 执行器同构（app.request 携 desktop token，不走网络）。
  const approvalService = new ApprovalService({
    dataRoot: agentDataRoot,
    emit: (sessionId, event, data) => sessionService.emitSse(sessionId, event, data),
  });
  agentToolService.registerToolFamily(createOpsToolFamily({
    approvals: approvalService,
    getApp: () => app,
    desktopToken,
    configProvider: () => configManager.getConfig(),
    // T3b-07：批准后、执行前复核会话运行状态（aborting/idle 不执行）
    sessionRunState: (sessionId) => sessionService.runState(sessionId),
    // T3b-07R：工具请求与批准绑定 server 权威轮次（toolCallId 所属 runId
    // 必须等于会话当前可执行轮；跨轮迟到请求拒绝，旧轮批准不被新轮洗白）
    toolCallRun: (sessionId, toolCallId) => sessionService.runOfToolCall(sessionId, toolCallId),
    currentRunId: (sessionId) => sessionService.currentRunId(sessionId),
    approvalMode: (sessionId) => sessionService.approvalMode(sessionId),
    // T3e-R3-02：停止信号（批准后异步复核链取消源；abort 时触发）
    sessionAbortSignal: (sessionId) => sessionService.abortSignal(sessionId),
  }));
  sessionService.on('sse', ({ sessionId, event }) => {
    if (event === 'run_end') approvalService.cancelForSession(sessionId);
  });
  // T3b-07：停止请求即撤销 pending 批准（不等 run_end），与 app_command
  // 执行前状态复核共同关闭「停止后迟到批准仍执行」窗口。
  sessionService.on('session_abort', ({ sessionId }) => {
    approvalService.cancelForSession(sessionId);
  });
  (app as any).__approvalService = approvalService;
  // P0-S4：close() 时停轮询器（进程退出前停止后台轮询）。
  (app as any).__cloudHistoryService = cloudHistoryService;
  // P2-S6：同款收尾（未收敛行留 state='moving'，重启对账续查）。
  (app as any).__cloudMoveService = cloudMoveService;
  (app as any).__agentSessionService = sessionService;
  console.info('[server] ApprovalService + app_command ops family registered');

  // ============================================================================
  // Middleware Registration Order Matters
  // ============================================================================

  // CORS (desktop mode or dev mode)
  //
  // P0-bug-1 fix: in standalone dev:all (vite 5173 + server 3001) the
  // browser sends cross-origin requests from http://localhost:5173 to
  // http://127.0.0.1:3001. Without devMode the CORS origin gate rejects
  // them (expectedOrigin defaults to the Electron app:// scheme), which
  // makes the entire frontend unable to reach the API in dev:all.
  //
  // desktopMode alone cannot tell standalone-dev:all apart from real
  // Electron production (both set desktopMode=true), so we drive the
  // CORS dev gate from an explicit `corsDevMode` option:
  //   - Electron production (electron/main.ts) → leaves it false
  //   - Standalone isMainModule entry → sets it true
  app.use('*', corsMiddleware({ devMode: corsDevMode }));
  console.info(`[server] CORS middleware registered (devMode=${corsDevMode})`);

  // ============================================================================
  // Inject Dependencies via Middleware (must run before auth)
  // ============================================================================

  app.use('*', async (c, next) => {
    // Inject dependencies for downstream routes
    (c as any).configManager = configManager;
    (c as any).kbLanGateway = kbLanGateway;
    (c as any).larkCliClient = larkCliClient;
    (c as any).larkCliManager = larkCliManager;
    (c as any).localMapStore = localMapStore;
    (c as any).changeDetector = changeDetector;
    (c as any).agentSessionService = sessionService;
    (c as any).kbBuildService = kbBuildService;
    (c as any).cloudHistoryService = cloudHistoryService;
    (c as any).cloudMoveService = cloudMoveService;
    (c as any).agentRuntimeResolver = runtimeResolver;

    // Inject desktopToken for auth middleware via context property
    if (desktopMode) {
      (c as any).desktopToken = desktopToken;
    }

    await next();
  });
  console.info('[server] Dependency injection middleware registered');

  // ============================================================================
  // Register Public Routes (no auth required)
  // ============================================================================

  app.route('/', healthRoutes); // Health check is always public (must be before auth middleware)
  console.info('[server] Health routes registered');

  // Agent 内部工具 API（设计 §9.6）：必须在 desktop auth 之前挂载，
  // 自带回环 + 运行令牌 + 拒 Origin 三重校验（浏览器不可达）。
  app.route('/', agentInternalRoutes(agentToolService));
  console.info('[server] Agent internal tool routes registered (pre-auth, loopback + run token)');

  // CLI 面板（设计 kb-agent-upgrade §6.2）：同样挂载在 desktop auth 之前。
  // /api/cli/enable 与 /api/cli/token/rotate 自带 desktop token 守卫
  // （CLI 令牌不能自我提权）；其余 /api/cli/* 走 cli-auth 三重校验。
  // 既有契约不变：health 仍最先注册，agent-internal 仍在 desktop auth 之前。
  // 命令执行 getApp 必须返回父 app（子 app 只含 CLI 自身路由）。
  //
  // S9：CLI 管理面补充端点（info / install-shim，desktop token 域）必须
  // 挂在 cliRoutes **之前**——cliRoutes 内 use('/api/cli/*') 的 CLI 令牌
  // 中间件按注册顺序在其后，本文件静态路由先返回即不受其拦截（与
  // cliRoutes 内 enable/rotate 先注册再挂 use 的策略一致）。
  app.route('/', cliAdminRoutes({
    desktopToken,
    cliEndpoint,
    configManager,
    dataRoot: agentDataRoot,
  }));
  console.info('[server] CLI admin routes registered (pre-auth, desktop token domain)');
  app.route('/', cliRoutes({
    cliEndpoint,
    desktopToken,
    configManager,
    getApp: () => app,
    dataRoot: agentDataRoot,
  }));
  console.info('[server] CLI endpoint routes registered (pre-auth, CLI token domain + desktop-guarded admin)');

  // Token authentication (desktop mode only, must run after dependency injection)
  if (desktopMode) {
    app.use('*', authMiddleware());
    console.info('[server] Auth middleware registered');
  }

  // ============================================================================
  // Register Protected Routes (auth required)
  // ============================================================================

  app.route('/', kbLanMcpRoutes({ manager: kbLanGateway, desktopToken }));
  app.route('/', kbMcpInstallRoutes({
    installer: new McpClientInstaller({ dataRoot: agentDataRoot, info: () => kbMcpInfo(configManager.getConfig()!.standardKb.outputRoot) }),
    desktopToken,
  }));
  app.route('/', configRoutes);
  app.route('/', detectRoutes);
  app.route('/', syncRoutes);
  app.route('/', feishuRoutes);
  app.route('/', mappingRoutes);
  app.route('/', contentRoutes);
  app.route('/', trashRoutes);
  app.route('/', customFolderRoutes);
  app.route('/', orphanFilesRoutes);
  // S11（设计 §7.4）：源库受控编辑 API。kbBuild 探针对齐 KbBuildService
  // .activeBuild 的判定面（内存 running + DB 非终态行），锁与 SyncEngine
  // 共享进程级 sharedSourceWriteLock（routes/sources.ts 内默认回落）。
  app.route('/', sourcesRoutes({
    configManager,
    localMapStore,
    kbBuild: { isActive: () => kbBuildService.activeBuild(localMapStore) != null },
    dataRoot: agentDataRoot,
  }));
  app.route('/', llmRoutes);
  app.route('/', piPluginRoutes(piPlugins));
  app.route('/', agentPluginRoutes(appPluginStore));
  app.route('/', await agentRoutes({
    sessionService,
    toolService: agentToolService,
    pool: agentPool,
    resolver: runtimeResolver,
    runtimeInstaller,
    configManager,
    localMapStore,
    internalPort: () => agentInternalPort.port,
    externalPlugins: () => piPlugins.externalCount(),
    pluginProtectedRoots: () => piPlugins.protectedRoots(),
    approvalService,
    ...(tasks.service ? { taskService: tasks.service } : {}),
  }));
  app.route('/', kbRoutes({
    buildService: kbBuildService,
    configManager,
    localMapStore,
    documentsProvider: knowledgeDocuments,
    sheetCsvPaths,
  }));
  // P1-S8（设计 P1 §4.6）：反向发布 API（计划/执行/列表/详情/发布根）。
  app.route('/', kbPublicationsRoutes({
    configManager,
    localMapStore,
    larkCliClient,
    dataRoot: agentDataRoot,
  }));
  console.info('[server] Protected routes registered');

  // ============================================================================
  // Error Handling
  // ============================================================================

  app.onError((err, c) => {
    console.error('[server] Unhandled error:', err);
    return c.json({
      error: 'Internal server error',
      message: err.message,
    }, 500);
  });

  app.notFound((c) => {
    return c.json({ error: 'Not found', path: c.req.path }, 404);
  });

  console.info('[server] buildServer completed');
  // 暴露内部端口回填器与进程池（startServer 用；close 时回收子进程）
  (app as any).__setAgentInternalPort = (port: number) => {
    agentInternalPort.port = port;
  };
  (app as any).__agentPool = agentPool;
  (app as any).__agentToolService = agentToolService;
  (app as any).__cliEndpoint = cliEndpoint;
  (app as any).__kbLanGateway = kbLanGateway;
  return app;
}

export async function startServer(options: CreateServerOptions & {
  port?: number;
  hostname?: string;
} = {}): Promise<StartedServer> {
  // P0 修复（v0.2.9，EADDRINUSE 127.0.0.1:3001）：此前用 `options.port ||
  // DEFAULT_PORT`，Electron 传入 port: 0（系统自动分配）被 || 当作 falsy
  // 回退到 3001——打包应用始终强占 3001，与本机其他服务（如占用该端口的
  // 开发服务器）冲突时内嵌 server 启动失败。必须用 ?? 只在未传时回退。
  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname || '127.0.0.1';

  console.info('[server] Building server', { desktopMode: options.desktopMode === true, corsDevMode: options.corsDevMode === true });
  const app = await buildServer(options);
  console.info(`[server] Server built, starting HTTP server on port ${port}`);

  const started = await new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
    let settled = false;
    try {
      const server = serve(
        {
          fetch: app.fetch,
          port,
          hostname,
        },
        (info) => {
          console.info(`[server] HTTP server callback invoked, info:`, info);
          if (!settled) {
            settled = true;
            // @hono/node-server v1.x callback info structure: { port: number }
            resolve({ server, port: info.port || port });
          }
        }
      );
      server.once('error', (error) => {
        console.error('[server] HTTP server error:', error);
        if (!settled) reject(error);
      });
      console.info('[server] serve() called, waiting for callback');
    } catch (error) {
      console.error('[server] serve() threw error:', error);
      reject(error);
    }
  });

  const actualPort = started.port;
  const url = `http://${hostname}:${actualPort}`;
  console.info(`[server] Feishu Sync API listening on ${url}`);
  console.info(`[server] Desktop mode: ${options.desktopMode ? 'enabled' : 'disabled'}`);

  // 回填 Agent 内部 API 端口（session/build spawn pi 进程时需要）
  const setPort = (app as any).__setAgentInternalPort as ((port: number) => void) | undefined;
  setPort?.(actualPort);

  // S8：记录服务 URL 并在 cli.enabled 时发布 CLI 端点文件
  const cliEndpoint = (app as any).__cliEndpoint as
    { onServerStarted: (url: string) => void } | undefined;
  try {
    cliEndpoint?.onServerStarted(url);
  } catch (error) {
    console.warn('[server] CLI endpoint publish failed:', error);
  }

  // Independent fixed-port child; failure never changes the loopback listener.
  const kbLanGateway = (app as any).__kbLanGateway as KbLanGatewayManager;
  void kbLanGateway.start().catch(() => console.warn('[server] LAN MCP gateway startup failed'));

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await kbLanGateway.close();
    // S10：先取消全部 pending 批准（挂起的工具调用立即失败），
    // 再回收 pi 子进程。
    const approvals = (app as any).__approvalService as { close: () => void } | undefined;
    approvals?.close();
    // P0-S4：停云端回滚轮询器（未收敛行留 revert_state='running'，重启对账续查）。
    const cloudHistory = (app as any).__cloudHistoryService as { stopPoller: () => void } | undefined;
    cloudHistory?.stopPoller();
    // P2-S6：停移出轮询器（未收敛行留 state='moving'，重启对账续查）。
    const cloudMoves = (app as any).__cloudMoveService as { stopPoller: () => void } | undefined;
    cloudMoves?.stopPoller();
    // 先回收 pi 子进程（SIGTERM → 3s → SIGKILL / Windows taskkill），
    // 再关 HTTP：内部工具 API 必须在子进程存续期间可达。
    const agentPool = (app as any).__agentPool as { closeAll: () => Promise<void> } | undefined;
    if (agentPool?.closeAll) {
      try {
        await agentPool.closeAll();
      } catch (error) {
        console.warn('[server] agent pool close failed:', error);
      }
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      // 桌面端卡死根因：Node 的 server.close() 回调要等所有连接（包括
      // keep-alive 空闲连接）全部断开才触发。渲染进程每 30s 轮询
      // /api/auth/status、主进程变更检测也走 fetch，这些连接会让回调
      // 永远不触发，quit 流程随之挂死。先踢掉空闲连接，活跃连接再等
      // 一个宽限期，超时后全部销毁——close() 保证会 resolve。
      // ServerType 联合类型含 Http2Server（无这两个方法），但 serve()
      // 无 TLS 选项时返回的就是 node:http Server，收窄后按特性调用。
      const nodeServer = started.server as HttpServer;
      if (typeof nodeServer.closeIdleConnections === 'function') {
        nodeServer.closeIdleConnections();
      }
      started.server.close((error?: Error) => {
        // 关闭出错（如 server 已不在运行）也不能让 quit 流程卡死或
        // reject——调用方据此决定是否继续退出。
        if (error) {
          console.warn('[server] HTTP server close reported an error (continuing shutdown):', error.message);
        }
        finish();
      });
      const graceTimer = setTimeout(() => {
        console.warn('[server] Graceful close timed out, destroying remaining connections');
        if (typeof nodeServer.closeAllConnections === 'function') {
          nodeServer.closeAllConnections();
        }
        finish();
      }, SHUTDOWN_GRACE_MS);
      // 宽限期计时器不能阻止独立 server 进程自然退出。
      graceTimer.unref?.();
    });

    // S8：撤销 CLI 端点（内存令牌失效 + pid 匹配时删除 endpoint.json）。
    // HTTP 已关闭后再撤销：CLI 客户端在服务存活期间始终可用。Electron
    // 退出唯一路径是 QuitCoordinator → started.close()，此处即退出钩子
    // （评估结论：electron/main.ts 无需重复注册，见 S8 报告）。
    try {
      (app as any).__cliEndpoint?.revoke?.();
    } catch (error) {
      console.warn('[server] CLI endpoint revoke failed:', error);
    }
  };

  return {
    url,
    port: actualPort,
    close,
  };
}

// ============================================================================
// Main Module Entry
// ============================================================================

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  // Start server in standalone mode (for development/testing)
  // SECURITY: Generate a temporary token and log to console for access.
  // 开发便利：FEISHU_SYNC_DEV_TOKEN 可固定 token（配合 vite proxy 注入实现
  // 浏览器 dev:all 免 Electron）；缺省仍为每次随机。
  const standaloneToken =
    process.env.FEISHU_SYNC_DEV_TOKEN?.trim() ||
    crypto.randomBytes(32).toString('base64url');
  console.info('[server] Standalone authentication enabled; configure FEISHU_SYNC_DEV_TOKEN for client access');

  // FEISHU_SYNC_PORT：本机 3001 被其他项目占用时的避让出口（默认 3001）。
  const standalonePort = Number(process.env.FEISHU_SYNC_PORT) || 3001;

  startServer({
    desktopMode: true, // Enable auth middleware in standalone mode
    desktopToken: standaloneToken,
    corsDevMode: true, // P0-bug-1 fix: standalone always serves a browser client (vite 5173 cross-origin)
    port: standalonePort,
    hostname: '127.0.0.1', // Bind to localhost only in standalone mode
  }).then((started) => {
    // Electron already closes via QuitCoordinator → started.close().
    // Standalone needs the same shutdown contract on process signals.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
      void started.close().then(() => process.exit(0));
    });
  }).catch((error) => {
    console.error('[server] Failed to start:', error);
    process.exit(1);
  });
}

export default buildServer;
