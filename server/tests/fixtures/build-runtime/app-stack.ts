/**
 * app-stack.ts — probe 的应用侧最小栈（测试夹具）
 *
 * 用主树真实模块拼出 MCP 桥要打到的回环内部 API：
 *   AgentToolService（真实工具执行/校验链） + BuildActorStore（真实成果账本）
 *   + agentInternalRoutes（真实路由与三重校验） + 构建审计中间件。
 *
 * 不 mock 任何工具执行：桥接调用进入的就是生产同一条 executeTool →
 * assertV2Access → writeDocCore 链。probe 只以「集成方」身份构造 v2
 * orchestration 运行上下文（设计 v2 §4.1 集成者职责），不新增调度。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { AgentToolService } from '../../../src/agent/agent-tool-service.js';
import { agentInternalRoutes } from '../../../src/routes/agent-internal.js';
import { BuildActorStore, V2_CHILD_ALL_TOOLS } from '../../../src/kb/build-actors.js';
import { RawSourceSnapshot, computeSourceHash } from '../../../src/kb/raw-source-snapshot.js';
import type { BuildRunState } from '../../../src/agent/agent-tool-service.js';
import type { RawSourceSnapshotEntry } from '../../../src/types/agent-knowledge.js';

export interface BridgeAuditEntry {
  t: string;
  method: string;
  path: string;
  amagiTaskId: string | null;
  amagiAgent: string | null;
  status: number;
  /** 工具名（tools/:name 时）。 */
  tool: string | null;
  /** 桥接 toolCallId（probe_ / cc_ 前缀）。 */
  toolCallId: string | null;
  /** 响应体摘要（错误码或 content 首段，脱敏由报告层统一处理）。 */
  summary: string;
}

export interface ProbeAppStack {
  url: string;
  port: number;
  toolService: AgentToolService;
  actorStore: BuildActorStore;
  buildState: BuildRunState;
  leaderToken: string;
  childToken: string;
  audit: BridgeAuditEntry[];
  /** 服务端未捕获异常（onError 捕获；诊断 500 用）。 */
  serverErrors: string[];
  stop: () => Promise<void>;
}

export interface AppStackInput {
  dataRoot: string;
  knowledgeBaseRoot: string;
  outputRoot: string;
  stagingRoot: string;
  buildId: string;
  generation: number;
  /** 进快照的短来源夹具。 */
  sources: Array<{ objToken: string; relPath: string; title: string }>;
  /** Leader 工具白名单（amagi 任务面 + v2 Leader 构建工具）。 */
  leaderTools: string[];
  leaderToolNames: string[];
  secretsForRedaction?: string[];
}

export async function buildProbeAppStack(input: AppStackInput): Promise<ProbeAppStack> {
  // 快照条目：与生产同公式哈希（raw_read 构建态会复核源文件一致性）
  const entries: RawSourceSnapshotEntry[] = input.sources.map((source) => {
    const file = path.join(input.knowledgeBaseRoot, source.relPath);
    return {
      objToken: source.objToken,
      objType: 'docx',
      title: source.title,
      relPath: source.relPath,
      contentHash: computeSourceHash(fs.realpathSync.native(file), [], fs.realpathSync.native(input.knowledgeBaseRoot)),
      objEditTime: '2026-11-01T00:00:00.000Z',
      mediaHash: null,
      imageCount: 0,
      whiteboardTextHash: '',
    };
  });
  const snapshot = RawSourceSnapshot.fromEntries(entries, { knowledgeBaseRoot: input.knowledgeBaseRoot });
  const workset = new Map(entries.map((entry) => [entry.objToken, 'rebuild' as const]));

  const actorStore = new BuildActorStore({ buildId: input.buildId, stagingRoot: input.stagingRoot, generation: input.generation });
  fs.mkdirSync(path.join(input.stagingRoot, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(input.stagingRoot, 'reviews'), { recursive: true });
  const buildState: BuildRunState = {
    knowledgeBaseRoot: input.knowledgeBaseRoot,
    snapshot,
    mode: 'full',
    workset,
    stagingRoot: input.stagingRoot,
    docMeta: new Map(),
    finishInfo: null,
    writtenPaths: new Set(),
    v2: { actorStore, generation: input.generation },
  };

  const toolService = new AgentToolService({
    dataRoot: input.dataRoot,
    documentsProvider: () => [],
  });

  const leaderCtx = toolService.createRunContext({
    runKind: 'build',
    buildId: input.buildId,
    outputRoot: input.outputRoot,
    knowledgeBaseRoot: input.knowledgeBaseRoot,
    buildState,
    orchestration: { mode: 'pi-amagi', buildId: input.buildId, generation: input.generation, credential: 'leader', actorStore },
    allowedToolsOverride: input.leaderTools,
  });
  const childCtx = toolService.createRunContext({
    runKind: 'build',
    buildId: input.buildId,
    outputRoot: input.outputRoot,
    knowledgeBaseRoot: input.knowledgeBaseRoot,
    buildState,
    orchestration: { mode: 'pi-amagi', buildId: input.buildId, generation: input.generation, credential: 'child', actorStore },
    allowedToolsOverride: [...V2_CHILD_ALL_TOOLS],
  });

  // 回环内部 API + 审计中间件（只克隆响应读取，不重读已被路由消费的请求体）
  const app = new Hono();
  const audit: BridgeAuditEntry[] = [];
  const serverErrors: string[] = [];
  app.onError((error, c) => {
    serverErrors.push(`${new Date().toISOString()} ${c.req.method} ${c.req.path}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return c.json({ error: 'internal_error', message: error instanceof Error ? error.message : String(error) }, 500);
  });
  app.use('/api/agent-internal/*', async (c, next) => {
    const started = Date.now();
    await next();
    const pathValue = c.req.path;
    const amagiTaskId = c.req.header('X-Amagi-Task-Id') ?? null;
    const amagiAgent = c.req.header('X-Amagi-Agent') ?? null;
    if (pathValue.startsWith('/api/agent-internal/tools/')) {
      let toolCallId: string | null = null;
      let summary = '';
      try {
        const cloned = c.res.clone();
        const body = (await cloned.json().catch(() => null)) as { toolCallId?: string; content?: Array<{ text?: string }>; error?: string; message?: string } | null;
        if (body && typeof body === 'object') {
          toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : null;
          const text = (body.content ?? []).map((block) => block.text ?? '').join(' ').replace(/\s+/g, ' ');
          summary = body.error ? `${body.error}: ${(body.message ?? '').slice(0, 120)}` : text.slice(0, 180);
        }
      } catch { summary = ''; }
      audit.push({
        t: new Date().toISOString(),
        method: c.req.method,
        path: pathValue,
        amagiTaskId,
        amagiAgent,
        status: c.res.status,
        tool: decodeURIComponent(pathValue.split('/').pop() ?? ''),
        toolCallId,
        summary: `+${Date.now() - started}ms ${summary}`,
      });
    } else if (pathValue === '/api/agent-internal/tools') {
      audit.push({
        t: new Date().toISOString(),
        method: c.req.method,
        path: pathValue,
        amagiTaskId,
        amagiAgent,
        status: c.res.status,
        tool: null,
        toolCallId: null,
        summary: `+${Date.now() - started}ms tools/list`,
      });
    }
  });
  app.route('/', agentInternalRoutes(toolService));

  const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('应用回环服务器端口解析失败');
  const port = address.port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    toolService,
    actorStore,
    buildState,
    leaderToken: leaderCtx.token,
    childToken: childCtx.token,
    audit,
    serverErrors,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
