import { resolveProviderModel } from '../modules/model-selection.js';
import type { SessionModelConfig } from '../types/agent-knowledge.js';
/**
 * Agent 路由（设计 §9.1 / §9.3 / §9.4）— desktop auth 之后
 *
 * GET/POST/PATCH/DELETE 会话、发消息、中止、模式切换、Workspace CRUD、
 * 运行时状态与重检测。SSE 用 hono/streaming streamSSE（前端 fetch 读流）。
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import crypto from 'node:crypto';
import type { SessionService } from '../agent/session-service.js';
import { ToolError, type AgentToolService } from '../agent/agent-tool-service.js';
import type { AgentProcessPool } from '../agent/agent-process-pool.js';
import type { PiRuntimeResolver } from '../agent/runtime-resolver.js';
import { validateWorkspacePath } from '../agent/path-guard.js';
import { collectResolvedRuntimeProtectedRoots, collectStaticProtectedRoots } from '../agent/protected-roots.js';
import { probeAvailableModels } from '../agent/runtime-probe.js';
import type { LocalMapStore } from '../modules/local-map-store.js';
import type { ConfigManager } from '../modules/config-manager.js';
import type { Config } from '../types/index.js';
import { resolveDataRoot } from '../modules/data-root.js';
import type { AgentWorkspaceConfig } from '../types/agent-knowledge.js';
import { readAgentPromptBinary } from '../agent/agent-assets.js';
import { VisionChannel } from '../agent/vision/vision-channel.js';
import { VisionDescriber } from '../agent/vision/vision-describer.js';
import type { ApprovalService } from '../agent/approvals/approval-service.js';

export interface AgentRouteDeps {
  sessionService: SessionService;
  toolService: AgentToolService;
  pool: AgentProcessPool;
  resolver: PiRuntimeResolver;
  configManager: ConfigManager;
  localMapStore: LocalMapStore;
  /** 内部 API 回环基址（无端口 → 无法 spawn，状态接口会呈现） */
  internalPort: () => number | null;
  externalPlugins?: () => number;
  pluginProtectedRoots?: () => string[];
  /** S10：会话内批准流（app_command）。 */
  approvalService?: ApprovalService;
  /** S6 任务编排服务（可选便于既有测试装配；生产由 index.ts 注入） */
  taskService?: import('../agent/tasks/task-service.js').TaskService;
}
function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof ToolError) {
    const details = (error as ToolError & { details?: unknown }).details;
    return c.json(
      {
        error: error.code,
        message: error.message,
        ...(details ? { details } : {}),
      },
      error.status as ContentfulStatusCode,
    ) as unknown as Response;
  }
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: 'internal_error', message }, 500) as unknown as Response;
}

export async function agentRoutes(deps: AgentRouteDeps): Promise<Hono> {
  const routes = new Hono();
  const { sessionService, resolver, configManager, localMapStore, pool } = deps;

  // ------------------------------------------------------------------
  // 运行时状态（Leader steer #4：每次请求取最新 config——factory 顶层捕获
  // 会在 UI 保存 agent/model 配置后永远用旧对象；probe 也接受本次配置）
  // ------------------------------------------------------------------

  const buildModelProbe = (config: Config) => async (runtime: Parameters<typeof probeAvailableModels>[0]['runtime']) => {
    const port = deps.internalPort();
    if (!port) return null; // 端口未知（未监听）：跳过模型探测，按配置推断
    const { token } = deps.toolService.createRunContext({
      runKind: 'probe',
      outputRoot: '/nonexistent',
      knowledgeBaseRoot: '/nonexistent',
    });
    try {
      return await probeAvailableModels({
        runtime,
        config,
        dataRoot: resolveDataRoot(),
        internalBaseUrl: `http://127.0.0.1:${port}`,
        registerProbeContext: () => token,
        revokeProbeContext: (used) => deps.toolService.revokeToken(used),
      });
    } catch {
      deps.toolService.revokeToken(token);
      return null;
    }
  };

  routes.get('/api/agent/status', async (c) => {
    try {
      const config = await configManager.load();
      const status = await resolver.checkReadiness(
        {
          agentConfig: config.agent,
          llmConfig: config.llm,
          runningProcesses: pool.runningCount(),
        },
        buildModelProbe(config),
      );
      const { piPackageRoot: _ignored, ...dto } = status.runtime;
      return c.json({
        ...status,
        externalPlugins: deps.externalPlugins?.() ?? 0,
        runtime: dto,
        processes: { running: pool.runningCount(), max: pool.max },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post('/api/agent/status/recheck', async (c) => {
    try {
      const config = await configManager.load();
      const status = await resolver.checkReadiness(
        {
          agentConfig: config.agent,
          llmConfig: config.llm,
          runningProcesses: pool.runningCount(),
        },
        buildModelProbe(config),
        { force: true },
      );
      const { piPackageRoot: _ignored, ...dto } = status.runtime;
      return c.json({ ...status, externalPlugins: deps.externalPlugins?.() ?? 0, runtime: dto });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  const modelStatus = async (config: Config, force = false) => {
    const status = await resolver.checkReadiness({ agentConfig: config.agent, llmConfig: config.llm, runningProcesses: pool.runningCount() }, buildModelProbe(config), { force });
    const { piPackageRoot: _ignored, ...runtime } = status.runtime;
    return { ...status, runtime, externalPlugins: deps.externalPlugins?.() ?? 0 };
  };
  routes.get('/api/agent/models', async (c) => {
    try {
      const config = await configManager.load();
      if (c.req.query('source') === 'pi-agent-dir') {
        const local: Config = { ...config, agent: { ...config.agent, runtime: { ...config.agent.runtime, backend: 'pi' }, model: { ...config.agent.model, source: 'pi-agent-dir', piModel: '' } } };
        const status = await modelStatus(local, c.req.query('refresh') === '1');
        return c.json({ items: status.model.available.map((piModel) => ({ source: 'pi-agent-dir', piModel, label: piModel, reasoning: true })), message: status.message });
      }
      const items = (config.llm.providers ?? []).flatMap((p) => p.models.map((m) => {
        const resolved = resolveProviderModel(config.llm, { providerId: p.id, modelId: m.id }, c.req.query('backend') === 'claude-code' ? 'anthropic-messages' : undefined);
        return resolved?.apiKey && (c.req.query('backend') !== 'claude-code' || resolved.protocol === 'anthropic-messages') ? { source: 'app-llm', providerId: p.id, modelId: m.id, label: `${p.name} / ${m.name}`, reasoning: m.reasoning === true } : null;
      }).filter(Boolean));
      return c.json({ items, message: items.length ? '' : c.req.query('backend') === 'claude-code' ? '请先配置 Anthropic Messages 兼容的提供商和模型' : '尚无已配置的模型，请先添加服务提供商与预设' });
    } catch (error) { return errorResponse(c, error); }
  });
  routes.get('/api/agent/sessions/:id/status', async (c) => {
    try { const config = await configManager.load(); return c.json(await modelStatus(sessionService.configForSession(localMapStore, c.req.param('id'), config), c.req.query('refresh') === '1')); }
    catch (error) { return errorResponse(c, error); }
  });
  routes.patch('/api/agent/sessions/:id/model', async (c) => {
    try {
      const id = c.req.param('id'); const config = await configManager.load();
      if (!localMapStore.getAgentSession(id)) throw new ToolError('session_not_found', '会话不存在', 404);
      if (sessionService.isRunning(id)) throw new ToolError('session_busy', '运行结束后可切换模型与思考强度', 409);
      const body = await c.req.json();
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.prototype.hasOwnProperty.call(body, 'model')) throw new ToolError('invalid_request', '缺少模型配置');
      if (body.model === null) return c.json(sessionService.setModel(localMapStore, id, null));
      const m = body.model;
      if (!m || !['app-llm', 'pi-agent-dir'].includes(m.source) || !['off', 'minimal', 'low', 'medium', 'high'].includes(m.thinkingLevel)) throw new ToolError('invalid_request', '模型来源或思考强度无效');
      const model: SessionModelConfig = { source: m.source, thinkingLevel: m.thinkingLevel };
      const sessionConfig = sessionService.configForSession(localMapStore, id, config);
      const sessionBackend = sessionConfig.agent.runtime.backend;
      if (sessionBackend === 'claude-code' && m.source !== 'app-llm') throw new ToolError('invalid_request', 'Claude Code 只支持应用内 Anthropic 兼容提供商');
      if (m.source === 'app-llm') {
        if (typeof m.providerId !== 'string' || typeof m.modelId !== 'string') throw new ToolError('invalid_request', '请选择服务提供商和模型预设');
        model.providerId = m.providerId; model.modelId = m.modelId;
        const resolved = resolveProviderModel(config.llm, model, sessionBackend === 'claude-code' ? 'anthropic-messages' : undefined);
        if (!resolved?.apiKey) throw new ToolError('invalid_request', '模型已删除、停用或缺少认证，请刷新列表');
        if (sessionBackend === 'claude-code' && resolved.protocol !== 'anthropic-messages') throw new ToolError('invalid_request', 'Claude Code 需要 Anthropic Messages 兼容的提供商');
        if (!resolved.reasoning && model.thinkingLevel !== 'off') throw new ToolError('invalid_request', '该模型预设未启用思考能力');
      } else {
        if (typeof m.piModel !== 'string' || !m.piModel.includes('/')) throw new ToolError('invalid_request', '请选择本地Pi模型');
        model.piModel = m.piModel;
        const status = await modelStatus({ ...sessionConfig, agent: { ...sessionConfig.agent, model: { ...sessionConfig.agent.model, ...model } } });
        if (!status.model.available.includes(m.piModel)) throw new ToolError('invalid_request', '本地Pi模型不可用，请刷新配置与认证');
      }
      return c.json(sessionService.setModel(localMapStore, id, model));
    } catch (error) { return errorResponse(c, error); }
  });

  // ------------------------------------------------------------------
  // 会话
  // ------------------------------------------------------------------

  routes.get('/api/agent/sessions', async (c) => {
    const config = await configManager.load();
    return c.json({ sessions: sessionService.list(localMapStore, config) });
  });

  routes.post('/api/agent/sessions', async (c) => {
    try {
      let body: { title?: string; mode?: string } = {};
      try {
        body = await c.req.json() as { title?: string; mode?: string };
      } catch {
        /* 空 body 合法 */
      }
      const session = sessionService.create(localMapStore, body);
      return c.json(session, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get('/api/agent/sessions/:id', async (c) => {
    const config = await configManager.load();
    const session = sessionService.get(localMapStore, config, c.req.param('id'));
    if (!session) return c.json({ error: 'session_not_found', message: '会话不存在' }, 404);
    return c.json(session);
  });

  routes.patch('/api/agent/sessions/:id', async (c) => {
    try {
      const body = await c.req.json() as { title?: string };
      const session = await sessionService.rename(localMapStore, c.req.param('id'), String(body.title ?? ''));
      if (!session) return c.json({ error: 'session_not_found', message: '会话不存在' }, 404);
      return c.json(session);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.delete('/api/agent/sessions/:id', async (c) => {
    try {
      const ok = await sessionService.delete(localMapStore, c.req.param('id'));
      if (!ok) return c.json({ error: 'session_not_found', message: '会话不存在' }, 404);
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get('/api/agent/sessions/:id/messages', (c) => {
    try {
      const messages = sessionService.messages(localMapStore, c.req.param('id'));
      return c.json({ messages });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post('/api/agent/sessions/:id/messages', async (c) => {
    try {
      const body = await c.req.json() as { text?: string; delivery?: string };
      const result = await sessionService.sendMessage(localMapStore, c.req.param('id'), {
        text: String(body.text ?? ''),
        delivery: body.delivery,
      });
      return c.json(result, 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post('/api/agent/sessions/:id/abort', async (c) => {
    try {
      const session = await sessionService.abort(localMapStore, c.req.param('id'));
      if (!session) return c.json({ error: 'session_not_found', message: '会话不存在' }, 404);
      return c.json(session);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post('/api/agent/sessions/:id/mode', async (c) => {
    try {
      const body = await c.req.json() as { mode?: string; workspaceId?: string; confirm?: string };
      const session = await sessionService.switchMode(localMapStore, c.req.param('id'), body);
      if (!session) return c.json({ error: 'session_not_found', message: '会话不存在' }, 404);
      return c.json(session);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // ------------------------------------------------------------------
  // 会话内批准（S10，设计 kb-agent-upgrade §6.5）——app_command 的
  // mutate/destructive/remote_write 级命令挂起等待用户裁决。批准请求经
  // 会话 SSE（approval_request/approval_resolved）下发；此处是用户裁决入口。
  // ------------------------------------------------------------------

  routes.get('/api/agent/sessions/:id/approvals', (c) => {
    try {
      const id = c.req.param('id');
      if (!localMapStore.getAgentSession(id)) {
        return c.json({ error: 'session_not_found', message: '会话不存在' }, 404);
      }
      if (!deps.approvalService) {
        return c.json({ error: 'approvals_unavailable', message: '批准流未启用' }, 503);
      }
      return c.json({ approvals: deps.approvalService.listPending(id) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post('/api/agent/sessions/:id/approvals/:approvalId/decide', async (c) => {
    try {
      const id = c.req.param('id');
      const approvalId = c.req.param('approvalId');
      if (!localMapStore.getAgentSession(id)) {
        return c.json({ error: 'session_not_found', message: '会话不存在' }, 404);
      }
      if (!deps.approvalService) {
        return c.json({ error: 'approvals_unavailable', message: '批准流未启用' }, 503);
      }
      let body: { decision?: unknown };
      try {
        body = await c.req.json() as { decision?: unknown };
      } catch {
        return c.json({ error: 'invalid_json', message: '请求体必须是 JSON' }, 400);
      }
      if (body.decision !== 'approve' && body.decision !== 'reject') {
        return c.json({ error: 'invalid_request', message: "decision 必须是 'approve' 或 'reject'" }, 400);
      }
      const dto = deps.approvalService.decide(id, approvalId, body.decision);
      return c.json({ id: dto.id, decision: body.decision });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // 会话 SSE
  routes.get('/api/agent/sessions/:id/events', (c) => {
    const sessionId = c.req.param('id');
    const lastEventHeader = c.req.header('Last-Event-ID');
    const lastEventId = lastEventHeader !== undefined && /^-?\d+$/.test(lastEventHeader)
      ? Number.parseInt(lastEventHeader, 10)
      : null;
    const initial = sessionService.sseSince(sessionId, lastEventId);
    return streamSSE(c, async (stream) => {
      let lastSeq = initial.events.length > 0 ? initial.events[initial.events.length - 1].id : (lastEventId ?? 0);
      if (initial.resync) {
        const latest = sessionService.sseSince(sessionId, null).events;
        lastSeq = latest.length > 0 ? latest[latest.length - 1].id : 0;
        await stream.writeSSE({ id: String(lastSeq), event: 'resync', data: '{}' });
      } else {
        for (const record of initial.events) {
          await stream.writeSSE({ id: String(record.id), event: record.event, data: JSON.stringify(record.data) });
        }
      }
      // 订阅后续事件（事件驱动 + 15s 心跳保活）
      const closed = { value: false };
      const wake = { resolve: null as null | (() => void) };
      const listener = (payload: { sessionId: string }) => {
        if (payload.sessionId !== sessionId) return;
        wake.resolve?.();
      };
      sessionService.on('sse', listener);
      stream.onAbort(() => {
        closed.value = true;
        sessionService.off('sse', listener);
        wake.resolve?.();
      });
      while (!closed.value) {
        const pending = sessionService.sseSince(sessionId, lastSeq);
        if (pending.resync) {
          const latest = sessionService.sseSince(sessionId, null).events;
          lastSeq = latest.length > 0 ? latest[latest.length - 1].id : 0;
          await stream.writeSSE({ id: String(lastSeq), event: 'resync', data: '{}' });
          continue;
        }
        for (const record of pending.events) {
          await stream.writeSSE({ id: String(record.id), event: record.event, data: JSON.stringify(record.data) });
          lastSeq = record.id;
        }
        // 写入期间可能又到新事件；立即检查下一批，避免漏唤醒后等 15 秒心跳。
        if (pending.events.length > 0) continue;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15_000);
          timer.unref?.();
          wake.resolve = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake.resolve = null;
        await stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => undefined);
      }
    });
  });

  // ------------------------------------------------------------------
  // Workspace
  // ------------------------------------------------------------------

  routes.get('/api/agent/workspaces', async (c) => {
    const config = await configManager.load();
    return c.json({ workspaces: config.agent.workspaces });
  });

  routes.post('/api/agent/workspaces', async (c) => {
    try {
      const body = await c.req.json() as { name?: string; path?: string };
      const name = String(body.name ?? '').trim();
      if (!name || name.length > 80) {
        return c.json({ error: 'workspace_path_invalid', message: '名称长度必须在 1..80' }, 400);
      }
      const config = await configManager.load();
      const candidate = String(body.path ?? '').trim();
      // 受保护运行资源（F3-R01）：应用完整运行依赖树（server 源码/构建
      // 产物、根目录与子包 node_modules、electron/、dist-electron、Electron
      // 打包资源）、pi 凭据目录（~/.pi/agent + PI_CODING_AGENT_DIR）、外部
      // Node 安装根与 pi 包根——ws_write 触达任一即可改写下次 spawn 的
      // 代码/二进制。发现失败时静态保护根仍生效（resolver 的错误在 spawn
      // 时另有明确报错）。
      const protectedRoots: string[] = [...collectStaticProtectedRoots()];
      try {
        await resolver.resolveRuntime(config.agent);
      } catch {
        /* 主三重 guard + 静态保护根仍生效 */
      }
      protectedRoots.push(...collectResolvedRuntimeProtectedRoots(resolver), ...(deps.pluginProtectedRoots?.() ?? []));
      const guards = {
        knowledgeBaseRoot: config.knowledgeBaseRoot,
        outputRoot: config.standardKb.outputRoot,
        dataRoot: resolveDataRoot(),
        protectedRoots,
      };
      const verdict = validateWorkspacePath(candidate, guards);
      if (!verdict.ok) {
        return c.json({ error: verdict.code, message: verdict.message }, 400);
      }
      const workspace: AgentWorkspaceConfig = {
        id: `ws_${crypto.randomBytes(6).toString('hex')}`,
        name,
        path: verdict.realPath,
        createdAt: new Date().toISOString(),
      };
      await configManager.updateConfig({
        agent: { ...config.agent, workspaces: [...config.agent.workspaces, workspace] },
      });
      return c.json(workspace, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.delete('/api/agent/workspaces/:id', async (c) => {
    const id = c.req.param('id');
    const config = await configManager.load();
    const workspace = config.agent.workspaces.find((candidate) => candidate.id === id);
    if (!workspace) {
      return c.json({ error: 'workspace_not_found', message: 'Workspace 不存在' }, 404);
    }
    // 绑定的 Work 会话切回 discuss
    await sessionService.demoteSessionsOnWorkspaceRemoval(localMapStore, id);
    await configManager.updateConfig({
      agent: {
        ...config.agent,
        workspaces: config.agent.workspaces.filter((candidate) => candidate.id !== id),
      },
    });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------
  // Vision 通道（设计 §3.6，S2）：status / test。test 用内置测试图真实
  // 调用一次所选端点（用户显式触发，与生产资料严格分离，不写缓存）。
  // ------------------------------------------------------------------

  let visionDescriber: VisionDescriber | null = null;
  const getVisionDescriber = () => (visionDescriber ??= new VisionDescriber({
    dataRoot: resolveDataRoot(),
    config: () => configManager.load(),
  }));

  routes.get('/api/agent/vision/status', async (c) => {
    try {
      const config = await configManager.load();
      const describer = getVisionDescriber();
      const status = await describer.status();
      return c.json({
        enabled: config.agent.vision.enabled,
        state: status.state,
        provider: config.agent.vision.providerId ?? config.llm.activeProviderId ?? null,
        model: status.model,
        message: status.message,
        cachedCount: await describer.cachedCount(),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post('/api/agent/vision/test', async (c) => {
    try {
      const config = await configManager.load();
      let body: { providerId?: unknown; modelId?: unknown } = {};
      try {
        body = await c.req.json() as { providerId?: unknown; modelId?: unknown };
      } catch {
        /* 空 body 合法：用已保存的 vision 配置 */
      }
      const vision = config.agent.vision;
      const explicitProvider = typeof body.providerId === 'string' && body.providerId.trim() ? body.providerId.trim() : undefined;
      const explicitModel = typeof body.modelId === 'string' && body.modelId.trim() ? body.modelId.trim() : undefined;
      if (!vision.enabled && !explicitProvider && !explicitModel) {
        throw new ToolError('vision_unconfigured', '图片理解未启用，请先在设置中启用并选择模型', 400);
      }
      const resolved = resolveProviderModel(config.llm, {
        providerId: explicitProvider ?? vision.providerId,
        modelId: explicitModel ?? vision.modelId,
      });
      if (!resolved || !resolved.apiKey) {
        throw new ToolError('invalid_config', '所选服务提供商/模型不可用（不存在、已停用或缺少认证）', 400);
      }
      const image = readAgentPromptBinary('vision-test.png');
      if (!image) {
        throw new ToolError('vision_fixture_missing', '内置测试图缺失（server 构建资产未复制）', 500);
      }
      const channel = new VisionChannel(config.llm, { providerId: resolved.providerId, modelId: resolved.presetId });
      const result = await channel.describe(
        {
          bytes: image,
          mime: 'image/png',
          prompt: '这是一张内置测试图。请简要描述图中内容，并逐字转写所有可见文字（中英文均需转写）。',
        },
        { timeoutMs: vision.timeoutMs },
      );
      const ok = result.finishReason === 'stop' || result.finishReason === 'length';
      return c.json({
        ok,
        finishReason: result.finishReason,
        model: result.model,
        latencyMs: result.latencyMs,
        sample: result.text,
        ...(ok ? {} : { error: { code: result.finishReason === 'timeout' ? 'timeout' : 'vision_failed', message: result.errorMessage ?? '调用失败' } }),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // ------------------------------------------------------------------
  // 任务编排（S6，设计 kb-agent-upgrade §5.4）：任务 CRUD + 作答 + 消息。
  // UI（S7）消费；task_update 事件经会话 SSE 推送。
  // ------------------------------------------------------------------

  routes.get('/api/agent/tasks', async (c) => {
    try {
      if (!deps.taskService) throw new ToolError('invalid_request', '任务编排服务不可用', 503);
      const sessionId = c.req.query('sessionId');
      if (!sessionId || !sessionId.trim()) {
        throw new ToolError('invalid_request', 'sessionId 必填');
      }
      return c.json({ tasks: deps.taskService.listBySession(localMapStore, sessionId) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get('/api/agent/tasks/:id', async (c) => {
    try {
      if (!deps.taskService) throw new ToolError('invalid_request', '任务编排服务不可用', 503);
      return c.json(deps.taskService.get(localMapStore, c.req.param('id')));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post('/api/agent/tasks/:id/cancel', async (c) => {
    try {
      if (!deps.taskService) throw new ToolError('invalid_request', '任务编排服务不可用', 503);
      // R2-01：desktop 面板入口不传 callerSessionId（独立的全局授权契约：
      // desktop token 鉴权）；内部 task_resume/task_cancel 工具面强制归属校验。
      return c.json(await deps.taskService.cancel(localMapStore, c.req.param('id')));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post('/api/agent/tasks/:id/resume', async (c) => {
    try {
      if (!deps.taskService) throw new ToolError('invalid_request', '任务编排服务不可用', 503);
      let body: { message?: unknown } = {};
      try {
        body = await c.req.json() as { message?: unknown };
      } catch {
        /* 空 body 由 message 校验报 400 */
      }
      // R2-01：同 cancel——desktop 面板全局授权；工具面归属校验在 TaskService。
      return c.json(deps.taskService.resume(localMapStore, c.req.param('id'), String(body.message ?? '')));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get('/api/agent/tasks/:id/messages', async (c) => {
    try {
      if (!deps.taskService) throw new ToolError('invalid_request', '任务编排服务不可用', 503);
      return c.json({ messages: deps.taskService.messages(localMapStore, c.req.param('id')) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return routes;
}
