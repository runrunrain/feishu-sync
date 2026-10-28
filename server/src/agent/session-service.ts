/**
 * SessionService — Agent 会话生命周期与运行编排（设计 §7.6 / §9.3）
 *
 * - 创建只写 DB；发消息按需拉起进程（--session-id 恢复上下文）。
 * - 同一会话同一时间只有一个运行；运行中再发消息需 steer/followUp。
 * - 模式切换：运行中拒绝；否则停进程 + 换工具集 + 换发令牌。
 * - SSE：每会话 1000 条环形缓冲，Last-Event-ID 早于缓冲发 resync。
 * - 历史：只读解析 pi 会话 JSONL（v3 树，沿最后 entry 的 parentId 回溯）。
 */

import crypto from 'node:crypto';
import type { AppPluginStore, AppPluginSnapshot } from './app-plugin-store.js';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentProcessPool } from './agent-process-pool.js';
import { AgentToolService, ToolError } from './agent-tool-service.js';
import { buildPiProcessEnv, PiRpcProcess } from './pi-rpc-process.js';
import { PiRuntimeResolver } from './runtime-resolver.js';
import { buildAppLlmRunConfig } from './provider-descriptor.js';
import type { SessionModelConfig } from '../types/agent-knowledge.js';
import { modelRevision } from './model-revision.js';
import { checkRootOverlap, type WorkspaceRootGuards } from './path-guard.js';
import {
  toolsForRunKind,
  type AgentMessageDto,
  type AgentSessionDto,
  type AgentSessionMode,
  type AgentWorkspaceConfig,
} from '../types/agent-knowledge.js';
import type { Config } from '../types/index.js';

export interface SessionSseEvent {
  id: number;
  event: string;
  data: unknown;
}

interface ActiveRun {
  runId: string;
  sessionId: string;
  phase: 'starting' | 'running' | 'settling';
}

export interface SessionServiceDeps {
  dataRoot: string;
  pool: AgentProcessPool;
  toolService: AgentToolService;
  resolver: PiRuntimeResolver;
  configProvider: () => Config | null;
  /** 内部 API 基址（回环），用于注入 FEISHU_SYNC_AGENT_URL */
  internalBaseUrl: () => string;
  /** 内部 API 可达探测（await 就绪） */
  waitForInternalApi?: () => Promise<void>;
  extensionPath: () => string | null;
  pluginStore?: AppPluginStore;
  /** F3-R02：当前配置快照的 Workspace 守卫（含受保护运行资源根）；
   * spawn/写能力使用时动态复核，冲突即拒绝，不让旧授权永久生效。 */
  workspaceGuards: () => WorkspaceRootGuards;
  /**
   * S6 任务编排：编排启用时向 Discuss/Work 会话下发 task_* 工具面
   * （白名单 + pi --tools 参数面）；关闭时按族整族剔除。
   * 每次 spawn 时求值（插件开关变更后首个新 run 生效）。
   */
  taskTools?: () => { enabled: boolean; names: readonly string[]; family: string } | null;
  /** S6：父会话删除时回调（取消其非终态子任务）。 */
  onSessionDeleted?: (sessionId: string) => void;
}

/** LocalMapStore 会话面结构类型（实际由 LocalMapStore 满足）。 */
export interface SessionStoreApi {
  getAgentSession(id: string): Record<string, unknown> | null;
  updateAgentSession(id: string, patch: Partial<{
    title: string;
    mode: 'discuss' | 'work';
    workspaceId: string | null;
    piSessionFile: string | null;
    modelConfig: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    updatedAt: string;
    deletedAt: string;
  }>): void;
  listSessionsByWorkspace(workspaceId: string): Array<Record<string, unknown>>;
}

const SSE_BUFFER_SIZE = 1000;

export class SessionService extends EventEmitter {
  private readonly deps: SessionServiceDeps;
  private readonly sseBuffers = new Map<string, SessionSseEvent[]>();
  private readonly sseSeq = new Map<string, number>();
  private readonly runs = new Map<string, ActiveRun>();
  /** T3b-07：停止已请求但尚未 run_end 的会话（abort ACK 窗口标记）。 */
  private readonly abortRequested = new Set<string>();
  private readonly modelRevisions = new WeakMap<PiRpcProcess, string>();
  private readonly pluginRevisions = new WeakMap<PiRpcProcess, string>();
  private readonly sessionStates = new Map<string, 'starting' | 'streaming'>();

  constructor(deps: SessionServiceDeps) {
    super();
    this.deps = deps;
  }

  private sessionDir(): string {
    return path.join(this.deps.dataRoot, 'agent', 'sessions');
  }

  private emptyCwd(): string {
    return path.join(this.deps.dataRoot, 'agent', 'empty-cwd');
  }

  // ------------------------------------------------------------------
  // DTO 构造
  // ------------------------------------------------------------------

  private toDto(row: Record<string, unknown>, workspace: AgentWorkspaceConfig | null): AgentSessionDto {
    const sessionId = String(row.id);
    const run = this.runs.get(sessionId);
    let state: AgentSessionDto['state'] = 'idle';
    if (run) state = this.sessionStates.get(sessionId) === 'streaming' ? 'streaming' : 'starting';
    const errorCode = row.last_error_code ? String(row.last_error_code) : null;
    const errorMessage = row.last_error_message ? String(row.last_error_message) : null;
    return {
      id: sessionId,
      model: this.readSessionModel(row),
      title: String(row.title),
      mode: row.mode as AgentSessionMode,
      workspace: workspace ? { id: workspace.id, name: workspace.name, path: workspace.path } : null,
      state,
      lastError: errorCode ? { code: errorCode, message: errorMessage ?? '' } : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private workspaceOf(config: Config | null, workspaceId: unknown): AgentWorkspaceConfig | null {
    if (!workspaceId || !config) return null;
    return config.agent.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  }

  // ------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------

  list(localMapStore: { listAgentSessions(): Array<Record<string, unknown>> }, config: Config | null): AgentSessionDto[] {
    return localMapStore.listAgentSessions().map((row) => this.toDto(row, this.workspaceOf(config, row.workspace_id)));
  }

  create(
    localMapStore: {
      createAgentSession(input: { id: string; title: string; mode: 'discuss' | 'work'; workspaceId: string | null; createdAt: string; updatedAt: string }): void;
    },
    input: { title?: string; mode?: string },
  ): AgentSessionDto {
    if (input.mode !== undefined && input.mode !== 'discuss') {
      throw new ToolError('invalid_request', '新建会话只允许 discuss 模式（Work 经模式切换进入）');
    }
    const id = `s_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const title = (input.title ?? '新会话').trim().slice(0, 80) || '新会话';
    const now = new Date().toISOString();
    localMapStore.createAgentSession({ id, title, mode: 'discuss', workspaceId: null, createdAt: now, updatedAt: now });
    fs.mkdirSync(this.sessionDir(), { recursive: true });
    return {
      id, title, mode: 'discuss', workspace: null, state: 'idle', lastError: null,
      createdAt: now, updatedAt: now,
    };
  }

  get(localMapStore: { getAgentSession(id: string): Record<string, unknown> | null }, config: Config | null, id: string): AgentSessionDto | null {
    const row = localMapStore.getAgentSession(id);
    if (!row) return null;
    return this.toDto(row, this.workspaceOf(config, row.workspace_id));
  }

  rename(
    localMapStore: { getAgentSession(id: string): Record<string, unknown> | null; updateAgentSession(id: string, patch: { title?: string; updatedAt?: string }): void },
    id: string,
    title: string,
  ): AgentSessionDto | null {
    if (typeof title !== 'string' || title.trim().length < 1 || title.trim().length > 80) {
      throw new ToolError('invalid_request', '标题长度必须在 1..80');
    }
    const row = localMapStore.getAgentSession(id);
    if (!row) return null;
    localMapStore.updateAgentSession(id, { title: title.trim(), updatedAt: new Date().toISOString() });
    return this.get(localMapStore, this.currentConfig(), id);
  }

  private readSessionModel(row: Record<string, unknown>): SessionModelConfig | null {
    if (typeof row.model_config_json !== 'string' || !row.model_config_json) return null;
    try { return JSON.parse(row.model_config_json) as SessionModelConfig; } catch { throw new ToolError('invalid_request', '会话模型配置损坏'); }
  }

  configForSession(store: Pick<SessionStoreApi, 'getAgentSession'>, id: string, base = this.currentConfig()): Config {
    const row = store.getAgentSession(id);
    if (!row) throw new ToolError('session_not_found', '会话不存在', 404);
    if (!base) throw new ToolError('invalid_request', '配置不可用');
    const model = this.readSessionModel(row);
    return model ? { ...base, agent: { ...base.agent, model: { ...base.agent.model, ...model } } } : base;
  }

  setModel(store: SessionStoreApi, id: string, model: SessionModelConfig | null): AgentSessionDto {
    if (!store.getAgentSession(id)) throw new ToolError('session_not_found', '会话不存在', 404);
    if (this.isRunning(id) || this.deps.pool.isBusy(id)) throw new ToolError('session_busy', '运行结束后可切换模型与思考强度', 409);
    store.updateAgentSession(id, { modelConfig: model ? JSON.stringify(model) : null });
    this.emitSessionState(id, store);
    return this.get(store, this.currentConfig(), id)!;
  }

  private currentConfig(): Config | null {
    return this.deps.configProvider();
  }

  async delete(
    localMapStore: SessionStoreApi,
    id: string,
  ): Promise<boolean> {
    const row = localMapStore.getAgentSession(id);
    if (!row) return false;
    if (this.runs.has(id)) {
      throw new ToolError('session_busy', '会话运行中，请先停止', 409);
    }
    await this.deps.pool.terminate(id);
    this.deps.toolService.revokeBySession(id);
    localMapStore.updateAgentSession(id, { deletedAt: new Date().toISOString() });
    // JSONL 移到 sessions/.deleted/
    const sessionFile = row.pi_session_file ? String(row.pi_session_file) : null;
    if (sessionFile && fs.existsSync(sessionFile)) {
      const deletedDir = path.join(this.sessionDir(), '.deleted');
      fs.mkdirSync(deletedDir, { recursive: true });
      const target = path.join(deletedDir, `${path.basename(sessionFile)}.${Date.now()}`);
      try {
        fs.renameSync(sessionFile, target);
      } catch {
        /* 移动失败保留原文件（软删除语义已达成） */
      }
    }
    this.sseBuffers.delete(id);
    this.emitSessionState(id, localMapStore);
    // S6：父会话删除 → 其非终态子任务取消（设计 §5.3）
    this.deps.onSessionDeleted?.(id);
    return true;
  }

  // ------------------------------------------------------------------
  // 模式切换
  // ------------------------------------------------------------------

  async switchMode(
    localMapStore: SessionStoreApi,
    id: string,
    body: { mode?: string; workspaceId?: string; confirm?: string },
  ): Promise<AgentSessionDto | null> {
    const row = localMapStore.getAgentSession(id);
    if (!row) return null;
    if (this.runs.has(id)) {
      throw new ToolError('session_busy', '会话运行中不能切换模式，请先等待完成或停止', 409);
    }
    const config = this.currentConfig();
    if (body.mode === 'discuss') {
      await this.deps.pool.terminate(id);
      this.deps.toolService.revokeBySession(id);
      localMapStore.updateAgentSession(id, { mode: 'discuss', workspaceId: null });
      this.emitSessionState(id, localMapStore);
      return this.get(localMapStore, config, id);
    }
    if (body.mode === 'work') {
      if (body.confirm !== 'WORK') {
        throw new ToolError('confirmation_required', '切换到 Work 模式需要 confirm: "WORK"（用户显式授权）');
      }
      const workspace = config?.agent.workspaces.find((candidate) => candidate.id === body.workspaceId);
      if (!workspace) {
        throw new ToolError('workspace_not_found', 'Workspace 不存在或未绑定', 404);
      }
      await this.deps.pool.terminate(id);
      this.deps.toolService.revokeBySession(id);
      localMapStore.updateAgentSession(id, { mode: 'work', workspaceId: workspace.id });
      this.emitSessionState(id, localMapStore);
      return this.get(localMapStore, config, id);
    }
    throw new ToolError('invalid_request', "mode 必须是 'discuss' 或 'work'");
  }

  /** Workspace 删除：绑定的 Work 会话切回 discuss。 */
  async demoteSessionsOnWorkspaceRemoval(
    localMapStore: SessionStoreApi,
    workspaceId: string,
  ): Promise<void> {
    for (const row of localMapStore.listSessionsByWorkspace(workspaceId)) {
      await this.deps.pool.terminate(String(row.id));
      this.deps.toolService.revokeBySession(String(row.id));
      localMapStore.updateAgentSession(String(row.id), { mode: 'discuss', workspaceId: null });
    }
  }

  // ------------------------------------------------------------------
  // 运行（发消息 / 中止）
  // ------------------------------------------------------------------

  async sendMessage(
    localMapStore: SessionStoreApi,
    id: string,
    body: { text: string; delivery?: string },
  ): Promise<{ accepted: true; runId: string }> {
    const row = localMapStore.getAgentSession(id);
    if (!row) {
      throw new ToolError('session_not_found', '会话不存在', 404);
    }
    if (typeof body.text !== 'string' || body.text.trim().length < 1 || body.text.length > 20_000) {
      throw new ToolError('invalid_request', '消息长度必须在 1..20000');
    }
    const existingRun = this.runs.get(id);
    const delivery = body.delivery === 'steer' || body.delivery === 'followUp' ? body.delivery : undefined;
    if (existingRun && !delivery) {
      throw new ToolError('session_busy', '会话运行中：发送消息需 delivery: steer 或 followUp', 409);
    }
    if (existingRun && delivery) {
      // F3-R04：投递必须进入同一活跃 RPC 运行——直接向当前运行中的 pi
      // 进程发官方 steer/follow_up 命令（pi 自带队列语义），不新建第二
      // 个 run、不重挂监听器（旧实现会 removeAllListeners 抹掉原 run 的
      // SSE 转发后 prompt 再报 run_in_progress，消息实际丢失）。
      const process = this.deps.pool.get(id);
      if (existingRun.phase !== 'running' || !process || process.isExited() || !process.hasActiveRun()) {
        // run 记录尚未被 executeRun 的 finally 清理（收尾窗口）：短暂 409
        // 比伪造投递更诚实。
        throw new ToolError('session_busy', '会话正在收尾，请稍后重试', 409);
      }
      const response = await process.sendCommand(
        delivery === 'steer' ? 'steer' : 'follow_up',
        { message: body.text },
        30_000,
      );
      if (!response.success) {
        throw new ToolError(
          'session_busy',
          `投递失败：${String((response as { error?: unknown }).error ?? 'pi 未接受消息')}`,
          409,
        );
      }
      this.emitSse(id, 'delivery_queued', {
        runId: existingRun.runId,
        delivery,
        disposition: String((response.data as { disposition?: unknown } | undefined)?.disposition ?? 'queued'),
      });
      return { accepted: true, runId: existingRun.runId };
    }

    const runId = `run_${crypto.randomBytes(6).toString('hex')}`;
    // 异步执行；错误经 SSE 与 last_error 落地
    void this.executeRun(localMapStore, id, body.text, runId).catch((error) => {
      console.error('[SessionService] run failed:', error);
    });
    return { accepted: true, runId };
  }

  private async executeRun(
    localMapStore: SessionStoreApi,
    sessionId: string,
    text: string,
    runId: string,
  ): Promise<void> {
    const row = localMapStore.getAgentSession(sessionId);
    if (!row) return;
    const mode = row.mode as AgentSessionMode;
    const config = this.configForSession(localMapStore, sessionId);
    if (!config) throw new ToolError('invalid_request', '配置不可用');

    const workspace = this.workspaceOf(config, row.workspace_id);
    if (mode === 'work' && !workspace) {
      throw new ToolError('workspace_not_found', 'Work 会话的 Workspace 已被删除，请切换回 Discuss', 404);
    }

    this.sessionStates.set(sessionId, 'starting');
    const run: ActiveRun = { runId, sessionId, phase: 'starting' };
    this.runs.set(sessionId, run);
    // 新运行开始即清除上一轮的停止标记（abort 与 runs.set 的竞态窗口内
    // 旧标记不得海化新运行的批准复核）。
    this.abortRequested.delete(sessionId);
    this.emitSse(sessionId, 'run_start', { runId });
    this.emitSessionState(sessionId, localMapStore);

    try {
      const pluginSnapshot = this.deps.pluginStore?.snapshot(mode);
      let process = this.deps.pool.get(sessionId);
      if (process && ((pluginSnapshot && this.pluginRevisions.get(process) !== pluginSnapshot.revision)
        || this.modelRevisions.get(process) !== modelRevision(config))) {
        await this.deps.pool.terminate(sessionId);
        this.deps.toolService.revokeBySession(sessionId);
        process = null;
      }
      if (!process) {
        await this.deps.waitForInternalApi?.();
        process = await this.spawnSessionProcess(sessionId, mode, workspace?.path, pluginSnapshot, config);
      }
      // F3-R06：运行期间挂起 idle 回收；结束（成功/失败/异常）后重起完整
      // idle 窗口——复用进程若已空闲 9 分钟，一次新 prompt 也必须获得全窗口。
      this.deps.pool.setBusy(sessionId, true);
      this.sessionStates.set(sessionId, 'streaming');
      this.emitSessionState(sessionId, localMapStore);

      const attachForwarders = (rpc: PiRpcProcess) => {
        rpc.removeAllListeners('text_delta');
        rpc.removeAllListeners('tool_execution_start');
        rpc.removeAllListeners('tool_execution_end');
        rpc.removeAllListeners('assistant_message_end');
        rpc.on('text_delta', (delta: string) => {
          this.emitSse(sessionId, 'text_delta', { runId, delta });
        });
        rpc.on('tool_execution_start', (event) => {
          this.emitSse(sessionId, 'tool', {
            runId,
            phase: 'start',
            callId: String((event as { toolCallId?: unknown }).toolCallId ?? ''),
            toolName: String((event as { toolName?: unknown }).toolName ?? ''),
            argsSummary: summarizeToolArgs(event),
          });
        });
        rpc.on('tool_execution_end', (event) => {
          const isError = (event as { isError?: unknown }).isError === true;
          this.emitSse(sessionId, 'tool', {
            runId,
            phase: 'end',
            callId: String((event as { toolCallId?: unknown }).toolCallId ?? ''),
            toolName: String((event as { toolName?: unknown }).toolName ?? ''),
            resultSummary: summarizeToolResult(event),
            isError,
          });
        });
        rpc.on('assistant_message_end', (message) => {
          this.emitSse(sessionId, 'message_end', {
            runId,
            message: toAssistantMessageDto(message, `live_${runId}_${crypto.randomBytes(6).toString('hex')}`),
          });
        });
      };

      attachForwarders(process);
      run.phase = 'running';
      const outcome = await process.prompt(text, {
        timeoutMs: config.standardKb.promptTimeoutMinutes * 60_000,
      });
      // 在 run_end 和任何异步 get_state 回填前关闭投递；RPC activeRun
      // 守卫还覆盖 agent_settled 到本 await continuation 的微任务窗口。
      run.phase = 'settling';

      if (outcome.outcome === 'completed') {
        localMapStore.updateAgentSession(sessionId, { lastErrorCode: null, lastErrorMessage: null });
        this.emitSse(sessionId, 'run_end', { runId, outcome: 'completed' });
      } else if (outcome.outcome === 'aborted') {
        this.emitSse(sessionId, 'run_end', { runId, outcome: 'aborted' });
      } else {
        const errorCode = outcome.error?.code ?? 'model_request_failed';
        const errorMessage = outcome.error?.message ?? '模型请求失败';
        localMapStore.updateAgentSession(sessionId, { lastErrorCode: errorCode, lastErrorMessage: errorMessage.slice(0, 500) });
        this.emitSse(sessionId, 'run_end', { runId, outcome: 'failed', error: { code: errorCode, message: errorMessage.slice(0, 500) } });
      }
      // 回填 pi_session_file
      try {
        const state = await process.sendCommand('get_state', {});
        if (state.success && state.data) {
          const sessionFile = (state.data as { sessionFile?: unknown }).sessionFile;
          if (typeof sessionFile === 'string' && sessionFile !== row.pi_session_file) {
            localMapStore.updateAgentSession(sessionId, { piSessionFile: sessionFile });
          }
        }
      } catch {
        /* 进程可能已回收 */
      }
    } catch (error) {
      run.phase = 'settling';
      const code = error instanceof ToolError ? error.code : 'agent_error';
      const message = error instanceof Error ? error.message : String(error);
      localMapStore.updateAgentSession(sessionId, { lastErrorCode: code, lastErrorMessage: message.slice(0, 500) });
      this.emitSse(sessionId, 'run_end', { runId, outcome: 'failed', error: { code, message: message.slice(0, 500) } });
    } finally {
      this.runs.delete(sessionId);
      this.abortRequested.delete(sessionId);
      this.sessionStates.delete(sessionId);
      this.deps.pool.setBusy(sessionId, false);
      this.emitSessionState(sessionId, localMapStore);
    }
  }

  private async spawnSessionProcess(
    sessionId: string,
    mode: AgentSessionMode,
    workspaceRoot: string | undefined,
    pluginSnapshot?: AppPluginSnapshot,
    runConfig?: Config,
  ): Promise<PiRpcProcess> {
    const config = runConfig ?? this.currentConfig()!;
    const revision = modelRevision(config);
    const runtime = await this.deps.resolver.resolveRuntime(config.agent);
    if (!runtime.nodePath || !runtime.piCliPath) {
      throw new ToolError('agent_not_ready', 'Agent 运行时未就绪（Node 或 pi 缺失），请检查设置', 503);
    }
    const runKind = mode === 'work' ? 'work' : 'discuss';
    // F3-R02：能力使用时动态复核 Workspace——授权后配置可能已变（手工改
    // 配置文件/旧版落盘），冲突即拒绝 spawn，不让旧授权永久生效。
    if (workspaceRoot) {
      const guards = this.deps.workspaceGuards();
      const verdict = checkRootOverlap(workspaceRoot, guards);
      if (!verdict.ok) {
        throw new ToolError('workspace_path_forbidden', `Workspace 已与新配置冲突，请重新授权：${verdict.message}`, 403);
      }
    }
    // F3-R05：容量先预留后 spawn——预留失败不 spawn（池满不少占、不留
    // 无主进程）；token 与进程同生命周期，任何退出路径都回收令牌。
    const slot = this.deps.pool.reserveSlot();
    if (!slot) {
      throw new ToolError('agent_busy', 'Agent 并发已达上限，请稍后重试', 409);
    }
    // S6：编排启用的会话下发 task_*；关闭时按族从白名单剔除
    const taskFace = this.deps.taskTools?.() ?? null;
    const orchestrationOn = taskFace?.enabled === true;
    const { token } = this.deps.toolService.createRunContext({
      runKind,
      sessionId,
      outputRoot: config.standardKb.outputRoot,
      knowledgeBaseRoot: config.knowledgeBaseRoot,
      workspaceRoot,
      ...(taskFace && !orchestrationOn ? { disableToolFamilies: [taskFace.family] } : {}),
      onEvent: (event) => {
        this.emitSse(sessionId, 'tool', {
          runId: this.runs.get(sessionId)?.runId ?? '',
          phase: event.phase,
          callId: '',
          toolName: event.toolName,
          argsSummary: event.argsSummary,
          ...(event.resultSummary !== undefined ? { resultSummary: event.resultSummary } : {}),
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
        });
      },
    });

    const llm = config.llm;
    let model: string;
    let apiKey: string | undefined;
    let providerJson: string | undefined;
    if (config.agent.model.source === 'app-llm') {
      // F3-R03：与 probe/构建共用 provider descriptor 单一实现
      const runConfig = buildAppLlmRunConfig(llm, config.agent);
      if (!runConfig || !runConfig.apiKey) {
        slot.release();
        this.deps.toolService.revokeToken(token);
        throw new ToolError('agent_not_ready', 'app-llm 模型未配置或缺少 API Key', 503);
      }
      model = runConfig.model;
      apiKey = runConfig.apiKey;
      providerJson = runConfig.providerJson;
    } else {
      const piModel = config.agent.model.piModel?.trim();
      if (!piModel) {
        slot.release();
        this.deps.toolService.revokeToken(token);
        throw new ToolError('agent_not_ready', 'pi-agent-dir 模式下未配置模型', 503);
      }
      model = piModel;
    }

    const env = buildPiProcessEnv({
      mode: config.agent.model.source,
      parentEnv: process.env,
      dataRoot: this.deps.dataRoot,
      agentUrl: this.deps.internalBaseUrl(),
      runToken: token,
      apiKey,
    });
    if (providerJson) {
      env.FEISHU_SYNC_AGENT_PROVIDER_JSON = providerJson;
    }
    if (pluginSnapshot) {
      env.FEISHU_SYNC_AGENT_PLUGIN_SNAPSHOT = pluginSnapshot.path;
      env.FEISHU_SYNC_AGENT_PLUGIN_REVISION = pluginSnapshot.revision;
      if (pluginSnapshot.externalPlugins) env.FEISHU_SYNC_AGENT_EXTERNAL_PLUGINS = '1';
    }
    env.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT = runtime.piPackageRoot ?? '';
    const extensionPath = this.deps.extensionPath();
    const rpc = new PiRpcProcess({
      nodePath: runtime.nodePath,
      piCliPath: runtime.piCliPath,
      ...(extensionPath ? { extensionPath } : {}),
      ...(pluginSnapshot ? { additionalExtensionPaths: pluginSnapshot.extensionPaths ?? [pluginSnapshot.extensionPath], allowExternalPluginTools: pluginSnapshot.externalPlugins, additionalSkillPaths: pluginSnapshot.skillPaths, additionalPromptPaths: pluginSnapshot.promptPaths, additionalThemePaths: pluginSnapshot.themePaths } : {}),
      tools: orchestrationOn
        ? [...toolsForRunKind(runKind), ...taskFace!.names]
        : toolsForRunKind(runKind),
      sessionDir: this.sessionDir(),
      sessionId,
      model,
      thinking: config.agent.model.thinkingLevel,
      cwd: this.emptyCwd(),
      env,
      promptTimeoutMs: config.standardKb.promptTimeoutMinutes * 60_000,
    });
    // F3-R05：token 与进程同生命周期——任何退出路径（正常结束、idle 回收、
    // terminate、崩溃）都回收令牌；后续消息会用新 spawn 的新令牌。
    rpc.once('exit', () => this.deps.toolService.revokeToken(token));
    try {
      await rpc.start();
      // 自动重试交由宿主判定（§4.4 auto_retry 上限）
      await rpc.sendCommand('set_auto_retry', { enabled: false }).catch(() => undefined);
      this.deps.pool.register(sessionId, rpc, 'session', slot);
      this.modelRevisions.set(rpc, revision);
      if (pluginSnapshot) this.pluginRevisions.set(rpc, pluginSnapshot.revision);
    } catch (error) {
      // start/register 任一步失败：释放预留 + 终结半启动进程 + 回收令牌，
      // 不留无主 OS 子进程。
      slot.release();
      await rpc.terminate().catch(() => undefined);
      this.deps.toolService.revokeToken(token);
      throw error;
    }
    return rpc;
  }

  async abort(
    localMapStore: SessionStoreApi,
    id: string,
  ): Promise<AgentSessionDto | null> {
    const row = localMapStore.getAgentSession(id);
    if (!row) return null;
    // T3b-07：停止请求即关闭批准窗口——立即撤销本会话 pending 批准并
    // 标记 aborting（app_command 批准后执行前据此复核），不等 run_end
    //（abort ACK 最长等待 15s + 2s 兑底，窗口内迟到批准不得再执行）。
    this.abortRequested.add(id);
    this.emit('session_abort', { sessionId: id });
    const process = this.deps.pool.get(id);
    if (process) {
      await process.abort();
    }
    return this.get(localMapStore, this.currentConfig(), id);
  }

  /**
   * T3b-07：会话运行状态（app_command 批准后执行前复核用）。
   * 'aborting'：停止已请求（abort ACK 窗口）；'running'：活跃运行中；
   * 'idle'：无活跃运行（settled/未运行）。
   */
  runState(sessionId: string): 'running' | 'aborting' | 'idle' {
    if (this.abortRequested.has(sessionId)) return 'aborting';
    return this.runs.has(sessionId) ? 'running' : 'idle';
  }

  hasActiveRuns(): boolean { return this.runs.size > 0; }

  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  // ------------------------------------------------------------------
  // SSE
  // ------------------------------------------------------------------

  emitSse(sessionId: string, event: string, data: unknown): void {
    let buffer = this.sseBuffers.get(sessionId);
    if (!buffer) {
      buffer = [];
      this.sseBuffers.set(sessionId, buffer);
    }
    const seq = (this.sseSeq.get(sessionId) ?? 0) + 1;
    this.sseSeq.set(sessionId, seq);
    buffer.push({ id: seq, event, data });
    if (buffer.length > SSE_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - SSE_BUFFER_SIZE);
    }
    this.emit('sse', { sessionId, event, data });
  }

  private emitSessionState(sessionId: string, localMapStore: SessionStoreApi): void {
    const dto = this.get(localMapStore, this.currentConfig(), sessionId);
    if (dto) this.emitSse(sessionId, 'session_state', dto);
  }

  /** SSE 续传：返回自 lastEventId 之后的事件；早于缓冲时标记 resync。 */
  sseSince(sessionId: string, lastEventId: number | null): { events: SessionSseEvent[]; resync: boolean } {
    const buffer = this.sseBuffers.get(sessionId) ?? [];
    if (lastEventId === null || (lastEventId === 0 && (buffer.length === 0 || buffer[0].id === 1))) {
      // 空连接的游标从 0 起步；它不是缓冲丢失，必须收到之后的首个事件。
      return { events: [...buffer], resync: false };
    }
    const index = buffer.findIndex((event) => event.id === lastEventId);
    if (index < 0) {
      return { events: [], resync: true };
    }
    return { events: buffer.slice(index + 1), resync: false };
  }

  // ------------------------------------------------------------------
  // 历史（解析 pi 会话 JSONL）
  // ------------------------------------------------------------------

  messages(localMapStore: { getAgentSession(id: string): Record<string, unknown> | null }, sessionId: string): AgentMessageDto[] {
    const row = localMapStore.getAgentSession(sessionId);
    if (!row) {
      throw new ToolError('session_not_found', '会话不存在', 404);
    }
    const sessionFile = row.pi_session_file ? String(row.pi_session_file) : null;
    if (!sessionFile || !fs.existsSync(sessionFile)) {
      return [];
    }
    return parseSessionJsonl(fs.readFileSync(sessionFile, 'utf-8'));
  }
}

// ===========================================================================
// pi 会话 JSONL 解析（v3 树 → 当前分支线性消息）
// ===========================================================================

interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    stopReason?: string;
    model?: string;
    timestamp?: number;
  };
}

/**
 * 解析 JSONL：首行 header 跳过；树回溯索引【全部】带 id/parentId 的
 * 节点（F3-R11）。若只索引 message，compaction/model_change 等夹在
 * 消息链中间时 parentId 链断在非消息节点，更早的分支被截断丢失；
 * 回溯起点取文件顺序最后一个节点（当前叶子，可能是 compaction 等
 * 非消息节点），分支输出阶段才过滤为消息。
 */
export function parseSessionJsonl(content: string): AgentMessageDto[] {
  const indexed: SessionEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as SessionEntry;
      if (parsed.type === 'session') continue; // header
      if (parsed.id) {
        indexed.push(parsed);
      }
    } catch {
      /* 跳过损坏行 */
    }
  }
  if (indexed.length === 0) return [];

  // 树回溯：从文件顺序最后一个节点沿 parentId 回溯当前分支
  const byId = new Map(indexed.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  let cursor: SessionEntry | undefined = indexed[indexed.length - 1];
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    branch.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }

  const result: AgentMessageDto[] = [];
  for (const entry of branch) {
    if (entry.type !== 'message') continue; // 非消息节点只参与树结构，不进消息流
    const message = entry.message;
    if (!message?.role) continue;
    const at = new Date(typeof message.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp) || Date.now()).toISOString();
    if (message.role === 'user') {
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: string }).text ?? '') : '')).join('')
          : '';
      result.push({ id: entry.id, role: 'user', at, text });
    } else if (message.role === 'assistant') {
      const dto = toAssistantMessageDto(message, entry.id);
      result.push({ ...dto, at });
    } else if (message.role === 'toolResult') {
      const text = Array.isArray(message.content)
        ? message.content.map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: string }).text ?? '') : '')).join('')
        : '';
      result.push({
        id: entry.id,
        role: 'tool',
        at,
        tool: {
          callId: String(message.toolCallId ?? ''),
          name: String(message.toolName ?? ''),
          isError: message.isError === true,
          resultSummary: text.length > 300 ? `${text.slice(0, 300)}…` : text,
        },
      });
    } else if (message.role === 'system') {
      result.push({ id: entry.id, role: 'notice', at, text: '系统消息（工具装载/提示变化）' });
    }
    // 未知 role 跳过
  }
  return result;
}

export function toAssistantMessageDto(message: unknown, id: string): AgentMessageDto {
  const msg = (message && typeof message === 'object' ? message : {}) as {
    content?: unknown;
    stopReason?: string;
    model?: string;
    usage?: unknown;
  };
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const textParts: string[] = [];
  const toolCalls: AgentMessageDto['toolCalls'] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') {
      textParts.push(typed.text);
    } else if (typed.type === 'toolCall') {
      toolCalls.push({
        id: String(typed.id ?? ''),
        name: String(typed.name ?? ''),
        argsSummary: JSON.stringify(typed.arguments ?? {}).slice(0, 200),
      });
    }
  }
  const error = msg.stopReason === 'error'
    ? { code: 'model_request_failed', message: textParts.join('').slice(0, 300) || '模型返回 error' }
    : undefined;
  return {
    // RPC Message 没有持久 entry id；live id 仅用于本轮UI，run_end后由JSONL权威历史替换。
    id,
    role: 'assistant',
    at: new Date().toISOString(),
    ...(textParts.length > 0 ? { text: textParts.join('') } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(error ? { error } : {}),
    ...(msg.model ? { model: msg.model } : {}),
  };
}

function summarizeToolArgs(event: unknown): string {
  const args = (event as { args?: unknown }).args;
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  const primary = record.path ?? record.objToken ?? record.docId ?? record.query ?? record.command ?? '';
  return String(primary).slice(0, 120);
}

function summarizeToolResult(event: unknown): string {
  const result = (event as { result?: { content?: Array<{ text?: string }> } }).result;
  const text = result?.content?.map((block) => block.text ?? '').join('') ?? '';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
