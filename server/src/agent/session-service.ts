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
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { SessionHistoryCache, parseSessionJsonl, toAssistantMessageDto, toToolMessageDto } from './session-history.js';
export { parseSessionJsonl, toAssistantMessageDto } from './session-history.js';
import { AgentProcessPool } from './agent-process-pool.js';
import { AgentToolService, ToolError } from './agent-tool-service.js';
import { buildPiProcessEnv, PiRpcProcess } from './pi-rpc-process.js';
import { PiRuntimeResolver } from './runtime-resolver.js';
import { buildAppLlmRunConfig } from './provider-descriptor.js';
import { createClaudeProcess } from './claude-process-factory.js';
import { ClaudeCodeProcess } from './claude-code-process.js';
import type { SessionModelConfig } from '../types/agent-knowledge.js';
import { modelRevision } from './model-revision.js';
import { ChatAttachmentStore, type ChatImageContent } from './chat-attachments.js';
import { checkRootOverlap, validateWorkingDirectory, type WorkspaceRootGuards } from './path-guard.js';
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
  autonomous?: boolean;
  error?: { code: string; message: string };
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
  private readonly history = new SessionHistoryCache();
  private readonly pendingText = new Map<string, { runId: string; event: 'text_delta' | 'thinking_delta'; deltas: string[]; timer: ReturnType<typeof setTimeout> }>();
  readonly attachments: ChatAttachmentStore;
  private readonly deps: SessionServiceDeps;
  private readonly sseBuffers = new Map<string, SessionSseEvent[]>();
  private readonly sseSeq = new Map<string, number>();
  private readonly runs = new Map<string, ActiveRun>();
  private readonly approvalModes = new Map<string, 'ask' | 'auto'>();
  /** T3b-07：停止已请求但尚未 run_end 的会话（abort ACK 窗口标记）。 */
  private readonly abortRequested = new Set<string>();
  /** T3e-R3-02：会话停止信号源（app_command 批准后异步复核链取消用）。 */
  private readonly abortSignals = new Map<string, Set<AbortController>>();
  private readonly modelRevisions = new WeakMap<PiRpcProcess, string>();
  private readonly pluginRevisions = new WeakMap<PiRpcProcess, string>();
  private readonly nativeSessionProcesses = new WeakSet<PiRpcProcess>();
  private readonly sessionStates = new Map<string, 'starting' | 'streaming'>();
  /**
   * T3b-07R：toolCallId → 所属 runId（server 权威轮次归属，从 pi
   * tool_execution_start 事件记录；有界环形，仅保留最近若干条）。
   * 旧轮迟到的工具 HTTP 请求携帶旧 toolCallId——据此拒绝跨轮执行。
   */
  private readonly toolCallRuns = new Map<string, Map<string, string>>();
  private static readonly TOOL_CALL_TRACK_LIMIT = 512;

  constructor(deps: SessionServiceDeps) {
    super();
    this.deps = deps;
    this.attachments = new ChatAttachmentStore(deps.dataRoot);
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
      approvalMode: this.approvalModes.get(sessionId) ?? 'ask',
      backend: row.runtime_backend === 'claude-code' ? 'claude-code' : 'pi',
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
      createAgentSession(input: { id: string; title: string; mode: 'discuss' | 'work'; workspaceId: string | null; backend?: 'pi' | 'claude-code'; createdAt: string; updatedAt: string }): void;
    },
    input: { title?: string; mode?: string; backend?: string; workspaceId?: string },
  ): AgentSessionDto {
    if (input.mode !== undefined && input.mode !== 'discuss') {
      throw new ToolError('invalid_request', '新建会话只允许 discuss 模式（Work 经模式切换进入）');
    }
    if (input.backend !== undefined && input.backend !== 'pi' && input.backend !== 'claude-code') {
      throw new ToolError('invalid_request', '会话基座必须是 Pi 或 Claude Code');
    }
    const id = `s_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const title = (input.title ?? '新会话').trim().slice(0, 80) || '新会话';
    const now = new Date().toISOString();
    // The explicit choice belongs to this conversation. Older callers that
    // omit it retain the configured application backend as their default.
    const backend = input.backend ?? (this.currentConfig()?.agent.runtime.backend === 'claude-code' ? 'claude-code' : 'pi');
    const workspace = input.workspaceId ? this.workspaceOf(this.currentConfig(), input.workspaceId) : null;
    if (input.workspaceId && !workspace) throw new ToolError('workspace_not_found', 'Workspace 不存在或未绑定', 404);
    localMapStore.createAgentSession({ id, title, mode: 'discuss', workspaceId: workspace?.id ?? null, backend, createdAt: now, updatedAt: now });
    fs.mkdirSync(this.sessionDir(), { recursive: true });
    return {
      id, title, mode: 'discuss', workspace: workspace ? { id: workspace.id, name: workspace.name, path: workspace.path } : null, state: 'idle', lastError: null, backend,
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
    const backend = row.runtime_backend === 'claude-code' ? 'claude-code' : 'pi';
    const resolvedModel = model ? { ...base.agent.model, ...model } : backend === 'claude-code'
      ? { ...base.agent.model, source: 'app-llm' as const } : base.agent.model;
    return { ...base, agent: { ...base.agent, runtime: { ...base.agent.runtime, backend }, model: resolvedModel } };
  }

  setModel(store: SessionStoreApi, id: string, model: SessionModelConfig | null): AgentSessionDto {
    if (!store.getAgentSession(id)) throw new ToolError('session_not_found', '会话不存在', 404);
    if (this.isRunning(id) || this.deps.pool.isBusy(id)) throw new ToolError('session_busy', '运行结束后可切换模型与思考强度', 409);
    store.updateAgentSession(id, { modelConfig: model ? JSON.stringify(model) : null });
    this.emitSessionState(id, store);
    return this.get(store, this.currentConfig(), id)!;
  }

  approvalMode(id: string): 'ask' | 'auto' { return this.approvalModes.get(id) ?? 'ask'; }

  setApprovalMode(store: SessionStoreApi, id: string, mode: 'ask' | 'auto'): AgentSessionDto {
    const row = store.getAgentSession(id);
    if (!row) throw new ToolError('session_not_found', '会话不存在', 404);
    if (row.mode !== 'work') throw new ToolError('invalid_request', '只有 Work 会话可设置审批方式');
    if (this.isRunning(id) || this.deps.pool.isBusy(id)) throw new ToolError('session_busy', '请在运行结束后切换审批方式', 409);
    if (mode === 'auto') this.approvalModes.set(id, mode); else this.approvalModes.delete(id);
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
    this.approvalModes.delete(id);
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
    if (row.runtime_backend === 'claude-code') {
      // Claude's native resume state is isolated per session. Move it with
      // the app transcript instead of leaving a live orphan on soft delete.
      const key = crypto.createHash('sha256').update(id).digest('hex');
      const base = path.join(this.sessionDir(), 'claude');
      const deletedDir = path.join(this.sessionDir(), '.deleted');
      fs.mkdirSync(deletedDir, { recursive: true });
      for (const name of [`${key}.home`, `${key}.session`]) {
        const source = path.join(base, name);
        if (fs.existsSync(source)) {
          try { fs.renameSync(source, path.join(deletedDir, `${name}.${Date.now()}`)); } catch { /* Preserve on failed move. */ }
        }
      }
    }
    this.sseBuffers.delete(id);
    this.toolCallRuns.delete(id);
    // T3e-R3-02：会话删除 → 挂起停止信号随会话状态丢弃（不触发——删除
    // 后工具令牌已回收，复核链不可达）。
    this.abortSignals.delete(id);
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
      localMapStore.updateAgentSession(id, { mode: 'discuss' });
      this.approvalModes.delete(id);
      this.emitSessionState(id, localMapStore);
      return this.get(localMapStore, config, id);
    }
    if (body.mode === 'work') {
      if (body.confirm !== 'WORK') {
        throw new ToolError('confirmation_required', '切换到 Work 模式需要 confirm: "WORK"（用户显式授权）');
      }
      const workspaceId = body.workspaceId ?? row.workspace_id;
      const workspace = this.workspaceOf(config, workspaceId);
      if (workspaceId && !workspace) {
        throw new ToolError('workspace_not_found', 'Workspace 不存在或未绑定', 404);
      }
      if (row.runtime_backend === 'claude-code' && !workspace) {
        throw new ToolError('workspace_not_found', 'Claude Code Work 会话需要选择工作目录', 400);
      }
      await this.deps.pool.terminate(id);
      this.deps.toolService.revokeBySession(id);
      localMapStore.updateAgentSession(id, { mode: 'work', workspaceId: workspace?.id ?? null });
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
      this.approvalModes.delete(String(row.id));
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
    body: { text: string; delivery?: string; attachmentIds?: unknown },
  ): Promise<{ accepted: true; runId: string }> {
    const row = localMapStore.getAgentSession(id);
    if (!row) {
      throw new ToolError('session_not_found', '会话不存在', 404);
    }
    if (typeof body.text !== 'string' || body.text.length > 20_000 || (!body.text.trim() && !(Array.isArray(body.attachmentIds) && body.attachmentIds.length))) {
      throw new ToolError('invalid_request', '请输入消息或添加附件，消息不能超过 20000 字符');
    }
    const existingRun = this.runs.get(id);
    const delivery = body.delivery === 'steer' || body.delivery === 'followUp' ? body.delivery : undefined;
    if (existingRun && !delivery) {
      throw new ToolError('session_busy', '会话运行中：发送消息需 delivery: steer 或 followUp', 409);
    }
    const prepared = this.attachments.prepare(id, body.text, body.attachmentIds);
    if (existingRun && delivery) {
      // F3-R04：投递必须进入同一活跃 RPC 运行——直接向当前运行中的 pi
      // 进程发官方 steer/follow_up 命令（pi 自带队列语义），不新建第二
      // 个 run、不重挂监听器（旧实现会 removeAllListeners 抹掉原 run 的
      // SSE 转发后 prompt 再报 run_in_progress，消息实际丢失）。
      const process = this.deps.pool.get(id);
      if (existingRun.phase !== 'running' || !process || process.isExited() || !(process.hasActiveRun() || process.hasActiveRound?.())) {
        // run 记录尚未被 executeRun 的 finally 清理（收尾窗口）：短暂 409
        // 比伪造投递更诚实。
        throw new ToolError('session_busy', '会话正在收尾，请稍后重试', 409);
      }
      const response = await process.sendCommand(
        delivery === 'steer' ? 'steer' : 'follow_up',
        { message: prepared.message, ...(prepared.images.length ? { images: prepared.images } : {}) },
        30_000,
      );
      if (!response.success) {
        throw new ToolError(
          'session_busy',
          `投递失败：${String((response as { error?: unknown }).error ?? 'pi 未接受消息')}`,
          409,
        );
      }
      this.attachments.commit(id, prepared);
      this.emitSse(id, 'delivery_queued', {
        runId: existingRun.runId,
        delivery,
        disposition: String((response.data as { disposition?: unknown } | undefined)?.disposition ?? 'queued'),
      });
      return { accepted: true, runId: existingRun.runId };
    }

    if (row.title === '新会话') {
      const title = (body.text.trim() || prepared.attachments.map((attachment) => attachment.name).join('、')).replace(/\s+/g, ' ').slice(0, 40);
      if (title) { localMapStore.updateAgentSession(id, { title, updatedAt: new Date().toISOString() }); this.emitSessionState(id, localMapStore); }
    }
    const runId = `run_${crypto.randomBytes(6).toString('hex')}`;
    this.attachments.commit(id, prepared);
    // 异步执行；错误经 SSE 与 last_error 落地
    void this.executeRun(localMapStore, id, prepared.message, runId, prepared.images).catch((error) => {
      console.error('[SessionService] run failed:', error);
    });
    return { accepted: true, runId };
  }

  private async executeRun(
    localMapStore: SessionStoreApi,
    sessionId: string,
    text: string,
    runId: string,
    images: ChatImageContent[] = [],
  ): Promise<void> {
    const row = localMapStore.getAgentSession(sessionId);
    if (!row) return;
    const mode = row.mode as AgentSessionMode;
    const config = this.configForSession(localMapStore, sessionId);
    if (!config) throw new ToolError('invalid_request', '配置不可用');

    const workspace = this.workspaceOf(config, row.workspace_id);
    if (mode === 'work' && row.workspace_id && !workspace) {
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
      const pluginSnapshot = this.deps.pluginStore?.snapshot(mode, { includeNative: config.agent.runtime.backend !== 'claude-code', nativeWork: mode === 'work' && config.agent.runtime.backend !== 'claude-code' });
      let process = this.deps.pool.get(sessionId);
      if (process && ((pluginSnapshot && this.pluginRevisions.get(process) !== pluginSnapshot.revision)
        || this.modelRevisions.get(process) !== modelRevision(config))) {
        await this.deps.pool.terminate(sessionId);
        this.deps.toolService.revokeBySession(sessionId);
        process = null;
      }
      if (!process) {
        await this.deps.waitForInternalApi?.();
        process = await this.spawnSessionProcess(sessionId, mode, mode === 'work' ? workspace?.path : undefined, pluginSnapshot, config);
      }
      // F3-R06：运行期间挂起 idle 回收；结束（成功/失败/异常）后重起完整
      // idle 窗口——复用进程若已空闲 9 分钟，一次新 prompt 也必须获得全窗口。
      this.deps.pool.setBusy(sessionId, true);
      this.sessionStates.set(sessionId, 'streaming');
      this.emitSessionState(sessionId, localMapStore);

      if (images.length && config.agent.runtime.backend !== 'claude-code') {
        const state = await process.sendCommand<{ model?: { input?: string[] } }>('get_state');
        if (state.data?.model?.input && !state.data.model.input.includes('image')) {
          throw new ToolError('model_image_unsupported', '当前 Pi 模型不支持图片输入，请选择支持视觉的模型后重试', 400);
        }
      }

      const attachForwarders = (rpc: PiRpcProcess) => {
        const currentRunId = () => this.runs.get(sessionId)?.runId ?? runId;
        if (mode === 'work' && config.agent.runtime.backend !== 'claude-code') {
          const finishNativeRound = (event: { aborted?: boolean; error?: { code: string; message: string } }) => {
            const nativeRun = this.runs.get(sessionId);
            if (!nativeRun?.autonomous) return;
            const error = event.error ?? nativeRun.error;
            localMapStore.updateAgentSession(sessionId, { lastErrorCode: error?.code ?? null, lastErrorMessage: error?.message ?? null });
            this.emitSse(sessionId, 'run_end', { runId: nativeRun.runId, outcome: error ? 'failed' : event.aborted ? 'aborted' : 'completed', ...(error ? { error } : {}) });
            this.runs.delete(sessionId);
            this.sessionStates.delete(sessionId);
            this.abortRequested.delete(sessionId);
            this.deps.pool.setBusy(sessionId, false);
            this.emitSessionState(sessionId, localMapStore);
          };
          if (!this.nativeSessionProcesses.has(rpc)) {
            this.nativeSessionProcesses.add(rpc);
            rpc.once('exit', () => finishNativeRound({ error: { code: 'pi_process_exited', message: 'Pi 进程在后台续跑期间退出，可重新发送消息恢复会话' } }));
          }
          rpc.removeAllListeners('round_started');
          rpc.removeAllListeners('round_settled');
          rpc.on('round_started', () => {
            if (rpc.hasActiveRun()) return; // The user prompt is managed below.
            const nativeRun: ActiveRun = { runId: `r_native_${crypto.randomUUID()}`, sessionId, phase: 'running', autonomous: true };
            this.runs.set(sessionId, nativeRun);
            this.abortRequested.delete(sessionId);
            this.sessionStates.set(sessionId, 'streaming');
            this.deps.pool.setBusy(sessionId, true);
            this.emitSse(sessionId, 'run_start', { runId: nativeRun.runId });
            this.emitSessionState(sessionId, localMapStore);
          });
          rpc.on('round_settled', finishNativeRound);
        }
        rpc.removeAllListeners('text_delta');
        rpc.removeAllListeners('thinking_delta');
        rpc.removeAllListeners('tool_execution_start');
        rpc.removeAllListeners('tool_execution_end');
        rpc.removeAllListeners('assistant_message_end');
        rpc.removeAllListeners('other_message_end');
        const queueDelta = (event: 'text_delta' | 'thinking_delta', delta: string) => {
          const runId = currentRunId();
          const pending = this.pendingText.get(sessionId);
          if (pending && pending.runId === runId && pending.event === event) { pending.deltas.push(delta); return; }
          this.flushText(sessionId);
          const timer = setTimeout(() => this.flushText(sessionId), 40);
          this.pendingText.set(sessionId, { runId, event, deltas: [delta], timer });
        };
        rpc.on('text_delta', (delta: string) => queueDelta('text_delta', delta));
        rpc.on('thinking_delta', (delta: string) => queueDelta('thinking_delta', delta));
        rpc.on('tool_execution_start', (event) => {
          const runId = currentRunId();
          const toolCallId = String((event as { toolCallId?: unknown }).toolCallId ?? '');
          // T3b-07R：记录 toolCall 的权威轮次归属（有界，迭代序=插入序）
          if (toolCallId) {
            let bucket = this.toolCallRuns.get(sessionId);
            if (!bucket) {
              bucket = new Map<string, string>();
              this.toolCallRuns.set(sessionId, bucket);
            }
            bucket.set(toolCallId, runId);
            if (bucket.size > SessionService.TOOL_CALL_TRACK_LIMIT) {
              const oldest = bucket.keys().next().value;
              if (oldest !== undefined) bucket.delete(oldest);
            }
          }
          this.emitSse(sessionId, 'tool', {
            runId,
            phase: 'start',
            callId: toolCallId,
            toolName: String((event as { toolName?: unknown }).toolName ?? ''),
            argsSummary: summarizeToolArgs(event),
          });
        });
        rpc.on('tool_execution_end', (event) => {
          const runId = currentRunId();
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
          const runId = currentRunId();
          const nativeRun = this.runs.get(sessionId);
          if (nativeRun?.autonomous) nativeRun.error = message?.stopReason === 'error' || message?.stopReason === 'length'
            ? { code: message.stopReason === 'length' ? 'model_output_truncated' : 'model_request_failed', message: message.stopReason === 'length' ? 'Pi 后台续跑达到输出上限，未完成当前任务' : 'Pi 后台续跑请求失败，可重新发送消息恢复会话' } : undefined;
          this.emitSse(sessionId, 'message_end', {
            runId,
            message: toAssistantMessageDto(message, `live_${runId}_${crypto.randomBytes(6).toString('hex')}`),
          });
        });
        rpc.on('other_message_end', (message) => {
          const runId = currentRunId();
          if (message?.role !== 'toolResult') return;
          this.emitSse(sessionId, 'message_end', { runId,
            message: toToolMessageDto(message, `live_tool_${runId}_${message.toolCallId ?? crypto.randomUUID()}`) });
        });
      };

      attachForwarders(process);
      run.phase = 'running';
      const outcome = await process.prompt(text, {
        timeoutMs: config.standardKb.promptTimeoutMinutes * 60_000,
        ...(images.length ? { images } : {}),
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
      // Claude's run token must never survive into another run. Its CLI is
      // resumed with a new capability context on the next message.
      if (config.agent.runtime.backend === 'claude-code') await this.deps.pool.terminate(sessionId).catch((error) => console.error('[SessionService] Claude cleanup failed:', error));
      // An extension may start its next turn before the prompt's get_state
      // roundtrip finishes. Only the owner of this run can clear its state.
      if (this.runs.get(sessionId) === run) {
        this.runs.delete(sessionId);
        this.abortRequested.delete(sessionId);
        this.sessionStates.delete(sessionId);
        this.deps.pool.setBusy(sessionId, false);
        this.emitSessionState(sessionId, localMapStore);
      }
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
    if (!runtime.nodePath || (config.agent.runtime.backend !== 'claude-code' && !runtime.piCliPath)) {
      throw new ToolError('agent_not_ready', 'Agent 运行时未就绪（Node 或 pi 缺失），请检查设置', 503);
    }
    const runKind = mode === 'work' ? 'work' : 'discuss';
    const nativeWork = mode === 'work' && config.agent.runtime.backend !== 'claude-code';
    const cwd = nativeWork ? workspaceRoot ?? os.homedir() : this.emptyCwd();
    if (nativeWork) {
      const verdict = validateWorkingDirectory(cwd);
      if (!verdict.ok) throw new ToolError(verdict.code, verdict.message, 400);
    }
    // F3-R02：能力使用时动态复核 Workspace——授权后配置可能已变（手工改
    // 配置文件/旧版落盘），冲突即拒绝 spawn，不让旧授权永久生效。
    if (workspaceRoot && !nativeWork) {
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
    const orchestrationOn = !nativeWork && taskFace?.enabled === true;
    const { token } = this.deps.toolService.createRunContext({
      runKind,
      sessionId,
      outputRoot: config.standardKb.outputRoot,
      knowledgeBaseRoot: config.knowledgeBaseRoot,
      workspaceRoot,
      ...(nativeWork ? { allowedToolsOverride: toolsForRunKind('discuss') } : {}),
      ...(taskFace && !orchestrationOn ? { disableToolFamilies: [taskFace.family] } : {}),
      onEvent: (event) => {
        // Pi already forwards its native execution events with authoritative call IDs.
        if (config.agent.runtime.backend !== 'claude-code') return;
        if (config.agent.runtime.backend === 'claude-code' && event.phase === 'start' && event.toolCallId
          && this.runs.get(sessionId)?.phase === 'running' && !this.abortRequested.has(sessionId)) {
          let bucket = this.toolCallRuns.get(sessionId);
          if (!bucket) { bucket = new Map<string, string>(); this.toolCallRuns.set(sessionId, bucket); }
          bucket.set(event.toolCallId, this.runs.get(sessionId)!.runId);
          if (bucket.size > SessionService.TOOL_CALL_TRACK_LIMIT) bucket.delete(bucket.keys().next().value!);
        }
        if (config.agent.runtime.backend === 'claude-code' && event.phase === 'end') {
          const rpc = this.deps.pool.get(sessionId);
          if (rpc instanceof ClaudeCodeProcess) {
            try { rpc.recordToolResult(event); } catch (error) { console.error('[SessionService] Could not record Claude tool result:', error); }
          }
        }
        this.emitSse(sessionId, 'tool', {
          runId: this.runs.get(sessionId)?.runId ?? '',
          phase: event.phase,
          callId: config.agent.runtime.backend === 'claude-code' ? event.toolCallId ?? '' : '',
          toolName: event.toolName,
          argsSummary: event.argsSummary,
          ...(event.resultSummary !== undefined ? { resultSummary: event.resultSummary } : {}),
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
        });
      },
    });

    if (config.agent.runtime.backend === 'claude-code') {
      let rpc: PiRpcProcess;
      try { rpc = createClaudeProcess({ config, nodePath: runtime.nodePath!, token, sessionId, dataRoot: this.deps.dataRoot,
        internalBaseUrl: this.deps.internalBaseUrl(), toolService: this.deps.toolService, pluginSnapshot }); }
      catch (error) { slot.release(); this.deps.toolService.revokeToken(token); throw error; }
      rpc.once('exit', () => this.deps.toolService.revokeToken(token));
      try {
        await rpc.start(); this.deps.pool.register(sessionId, rpc, 'session', slot);
        this.modelRevisions.set(rpc, revision);
        if (pluginSnapshot) this.pluginRevisions.set(rpc, pluginSnapshot.revision);
      } catch (error) { slot.release(); await rpc.terminate().catch(() => undefined); this.deps.toolService.revokeToken(token); throw error; }
      return rpc;
    }

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
      preserveUploadedImages: true,
      nativeWork,
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
      piCliPath: runtime.piCliPath!,
      ...(extensionPath ? { extensionPath } : {}),
      // Native Work discovers packages/resources from the application Pi home
      // and cwd. Loading the same package again by -e causes duplicate tools.
      ...(pluginSnapshot && !nativeWork ? { additionalExtensionPaths: pluginSnapshot.extensionPaths ?? [pluginSnapshot.extensionPath], allowExternalPluginTools: pluginSnapshot.externalPlugins, additionalSkillPaths: pluginSnapshot.skillPaths, additionalPromptPaths: pluginSnapshot.promptPaths, additionalThemePaths: pluginSnapshot.themePaths } : {}),
      nativeWork,
      selfTriggeredRounds: nativeWork,
      tools: orchestrationOn
        ? [...toolsForRunKind(runKind), ...taskFace!.names]
        : toolsForRunKind(runKind),
      sessionDir: this.sessionDir(),
      sessionId,
      model,
      thinking: config.agent.model.thinkingLevel,
      cwd,
      env,
      promptTimeoutMs: config.standardKb.promptTimeoutMinutes * 60_000,
      // User image frames can include up to 20 MB of bytes encoded as base64.
      maxFrameBytes: 40 * 1024 * 1024,
    });
    // F3-R05：token 与进程同生命周期——任何退出路径（正常结束、idle 回收、
    // terminate、崩溃）都回收令牌；后续消息会用新 spawn 的新令牌。
    rpc.once('exit', () => this.deps.toolService.revokeToken(token));
    try {
      await rpc.start();
      // 自动重试交由宿主判定（§4.4 auto_retry 上限）
      if (!nativeWork) await rpc.sendCommand('set_auto_retry', { enabled: false }).catch(() => undefined);
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
    // T3e-R3-02：停止请求即触发停止信号——批准后仍挂起的异步复核链
    //（如 source.push 计划复核 preview）立即按停止处理，不等其返回。
    this.fireAbortSignals(id);
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

  /** T3b-07R：会话当前可执行轮 runId；无活跃运行返回 null。 */
  currentRunId(sessionId: string): string | null {
    return this.runs.get(sessionId)?.runId ?? null;
  }

  /**
   * T3e-R3-02：创建会话停止信号（app_command 批准后异步复核链的取消源）。
   * 停止请求（abort）时触发；与 runState/currentRunId 复核共同关闭
   *「批准后异步 preview 挂起期间停止仍写入」窗口。信号一次性，触发后
   * 自动清理；会话删除时随会话状态一并丢弃。
   */
  abortSignal(sessionId: string): AbortSignal {
    const controller = new AbortController();
    let set = this.abortSignals.get(sessionId);
    if (!set) {
      set = new Set();
      this.abortSignals.set(sessionId, set);
    }
    set.add(controller);
    controller.signal.addEventListener('abort', () => {
      const current = this.abortSignals.get(sessionId);
      if (current?.delete(controller) && current.size === 0) {
        this.abortSignals.delete(sessionId);
      }
    }, { once: true });
    return controller.signal;
  }

  /** 停止请求：触发并清空该会话全部挂起信号（一次性，自动清理）。 */
  private fireAbortSignals(sessionId: string): void {
    const set = this.abortSignals.get(sessionId);
    if (!set) return;
    this.abortSignals.delete(sessionId);
    for (const controller of set) controller.abort();
  }

  /**
   * T3b-07R：toolCallId → 所属 runId（server 权威轮次归属）。未知
   * toolCallId（未被任何运行登记过/已被淘汰）返回 null——调用方按不可
   * 执行处理。
   */
  runOfToolCall(sessionId: string, toolCallId: string): string | null {
    return this.toolCallRuns.get(sessionId)?.get(toolCallId) ?? null;
  }

  hasActiveRuns(): boolean { return this.runs.size > 0; }

  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  // ------------------------------------------------------------------
  // SSE
  // ------------------------------------------------------------------

  emitSse(sessionId: string, event: string, data: unknown): void {
    if (event !== 'text_delta' && event !== 'thinking_delta') this.flushText(sessionId);
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

  private flushText(sessionId: string): void {
    const pending = this.pendingText.get(sessionId); if (!pending) return;
    clearTimeout(pending.timer); this.pendingText.delete(sessionId);
    this.emitSse(sessionId, pending.event, { runId: pending.runId, delta: pending.deltas.join('') });
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
      return this.attachments.decorate(sessionId, []);
    }
    return this.attachments.decorate(sessionId, parseSessionJsonl(fs.readFileSync(sessionFile, 'utf-8')));
  }

  async messagesAsync(store: { getAgentSession(id: string): Record<string, unknown> | null }, sessionId: string): Promise<AgentMessageDto[]> {
    const row = store.getAgentSession(sessionId);
    if (!row) throw new ToolError('session_not_found', '会话不存在', 404);
    let messages: AgentMessageDto[] = [];
    if (row.pi_session_file) {
      try { messages = await this.history.read(String(row.pi_session_file)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return this.attachments.decorate(sessionId, messages);
  }
}

// ===========================================================================
// pi 会话 JSONL 解析（v3 树 → 当前分支线性消息）
// ===========================================================================


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
