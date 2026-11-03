/**
 * 重构 v2 端到端接入试验（设计 §13.2；目标 7 硬验收）：
 *
 * 真实链路：POST /api/kb/builds（真实 Hono server）→ 真实 Pi Leader
 * （版本化 amagi-pi + 转发扩展双 -e、构建白名单、派发守卫）→ amagi 真实
 * 子任务（真实 pi 子进程、MCP 桥接 stdio→回环内部 API、身份头执法）→
 * 工具桥写入草稿/提交审查 → Leader build_request_publish → 原发布校验
 * 管线（assemble/canPublish/publishRelease）→ published。
 *
 * 模型为本地 fixture（OpenAI 兼容、确定性脚本化响应）——**非真实模型
 * 质量**：只验证编排/身份/工具/发布链路，不评价内容质量。
 *
 * 前置（缺失即 skip 并说明，不假通过）：
 * - PATH 可发现 pi ≥1.4（PiRuntimeResolver 同链发现）；
 * - amagi-pi 本地源目录（source 模式物化安装；未发布 npm 的生产路径）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { buildServer } from '../src/index.js';
import { BuildCheckpointStore } from '../src/kb/build-checkpoint.js';

const AMAGI_SOURCE_DIR = process.env.AMAGI_PI_SOURCE_DIR || '';
const AMAGI_SOURCE_VERSION = AMAGI_SOURCE_DIR && fs.existsSync(path.join(AMAGI_SOURCE_DIR, 'package.json'))
  ? String((JSON.parse(fs.readFileSync(path.join(AMAGI_SOURCE_DIR, 'package.json'), 'utf-8')) as { version?: string }).version ?? '')
  : '';
const DESKTOP_TOKEN = 'e2e-desktop-token';
const DOC_PATH = 'combat/overview.md';

/** 判定 pi 是否可达（PATH 扫描——与 PiRuntimeResolver 同口径的最小实现）。 */
function findPiOnPath(): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'pi');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// fixture 模型（OpenAI 兼容；确定性状态机，按会话消息推导下一步动作）
// ---------------------------------------------------------------------------

interface FixtureCall { name: string; args: Record<string, unknown>; }

function textOf(message: { content?: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block): block is { type: string; text: string } => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('\n');
}

function toolResultsOf(messages: Array<Record<string, unknown>>): string {
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => textOf(message as { content?: unknown }))
    .join('\n');
}

/** 由会话推导下一个动作（Leader/写作者/审查者三态机）。 */
function nextAction(messages: Array<Record<string, unknown>>): { text?: string; calls?: FixtureCall[] } {
  const all = messages.map((message) => textOf(message as { content?: unknown })).join('\n');
  const latestUserText = textOf(([...messages].reverse().find((message) => message.role === 'user') ?? {}) as { content?: unknown });
  const results = toolResultsOf(messages);
  const lastToolResult = [...messages].reverse().find((message) => message.role === 'tool');
  const lastResultText = lastToolResult ? textOf(lastToolResult as { content?: unknown }) : '';
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant' && Array.isArray((message as { tool_calls?: unknown }).tool_calls) && (message as { tool_calls: unknown[] }).tool_calls.length > 0);
  const lastCallName = (() => {
    const calls = (lastAssistant as { tool_calls?: Array<{ function?: { name?: string } }> } | undefined)?.tool_calls;
    return calls && calls.length > 0 ? calls[calls.length - 1]?.function?.name ?? '' : '';
  })();

  // MCP 连接完成前的首调用（amagi-mcp 未连接）→ 原样重试上一次调用
  if (lastCallName === 'mcp_call' && /尚未连接|not connected|尚未连接/.test(lastResultText)) {
    const prior = (lastAssistant as { tool_calls?: Array<{ function?: { arguments?: string } }> } | undefined)?.tool_calls?.[0]?.function?.arguments;
    if (prior) return { calls: [{ name: 'mcp_call', args: JSON.parse(prior) as Record<string, unknown> }] };
  }

  if (all.includes('本次构建交代')) {
    // ---- Leader 状态机 ----
    if (results.includes('已结算：accepted') || /发布申请 pub_[0-9a-f]+ 已结算/.test(results)) {
      return { text: '发布已接受，构建收尾。' };
    }
    // 完成通知以 user 消息注入（非工具结果）→ 检 all 而非 results
    if (all.includes('[task_submit 完成 diting/')) {
      return { calls: [{ name: 'build_request_publish', args: { summary: '全部成果通过审查（fixture e2e）' } }] };
    }
    if (all.includes('[task_submit 完成 luban/')) {
      return { calls: [{ name: 'task_submit', args: {
        agent: 'diting',
        task: `审查任务：对 staging 草稿 ${DOC_PATH} 做独立审查。coverage.docPaths=["${DOC_PATH}"]。经 mcp_call 调用 kb_submit_review 提交审查报告（conclusion=pass，coverage.sourceRefs=["tok1"]），然后经 mcp_call 调用 build_handoff_submit 提交交接。`,
        delivery: 'handle',
      } }] };
    }
    if (lastCallName === 'task_submit') {
      const handle = lastResultText.match(/句柄:\s*([0-9a-fA-F-]{20,})/);
      if (handle) {
        return { calls: [{ name: 'build_assign_output', args: { ownerTaskId: handle[1], targets: [DOC_PATH] } }] };
      }
    }
    if (results.includes('已分配') || results.includes('assignmentId=')) {
      return { text: '已分配输出，等待写作任务完成通知。' };
    }
    // fixture 派发上限（防完成通知永不到达时无限重派）
    const dispatchCount = messages.filter((message) => {
      const calls = (message as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls;
      return message.role === 'assistant' && Array.isArray(calls) && calls.some((call) => call.function?.name === 'task_submit');
    }).length;
    if (dispatchCount >= 6) {
      return { text: '已有子任务在执行，等待完成通知（fixture 派发上限）。' };
    }
    const skillFileForTask = all.match(/技能文件（子任务可 read 校验正文，正文与系统规则同源）：(\S+)/)?.[1] ?? '(未知)';
    return { calls: [{ name: 'task_submit', args: {
      agent: 'luban',
      task: `写作任务：撰写标准文档 ${DOC_PATH}。先用 read 读取技能文件 ${skillFileForTask} 并确认含「内容质量基线」标记，再经 mcp_call 调用 kb_write_doc 写入草稿（path=${DOC_PATH}），最后经 mcp_call 调用 build_handoff_submit 提交交接。`,
      delivery: 'handle',
    } }] };
  }
  if (latestUserText.includes('写作任务')) {
    // ---- 写作者状态机（先真实 read 技能正文并验证规则标记，再写）----
    if (results.includes('handoffId=') || /已提交交接记录 ho_/.test(results)) return { text: '写作完成。' };
    if (lastCallName === 'mcp_call' && /kb_output_not_assigned|actor_pending/.test(lastResultText)) {
      const prior = (lastAssistant as { tool_calls?: Array<{ function?: { arguments?: string } }> } | undefined)?.tool_calls?.[0]?.function?.arguments;
      if (prior) return { calls: [{ name: 'mcp_call', args: JSON.parse(prior) as Record<string, unknown> }] };
    }
    // steer #11：真实 read 技能文件正文（build 专用 home skills 目录），验证规则 marker
    const skillFile = all.match(/read 读取技能文件 (\S+)/)?.[1];
    if (skillFile && !results.includes('内容质量基线')) {
      if (lastCallName === 'read') {
        if (!lastResultText.includes('内容质量基线')) {
          return { text: '技能正文读取失败或缺少「内容质量基线」规则标记（fixture 终止）。' };
        }
        return { calls: [{ name: 'mcp_call', args: {
          server: 'feishu-kb-bridge', tool: 'kb_write_doc',
          arguments: {
            path: DOC_PATH,
            operationId: 'writer-doc-1',
            title: '战斗行动总览',
            markdown: '战斗以回合制推进：先手由速度决定，每回合累计怒气，怒气满后可释放战技。fixture e2e 正文。',
            sources: ['tok1'],
            summary: '战斗回合推进、先手判定与怒气消耗的总览。',
            tags: ['战斗'],
          },
        } }] };
      }
      return { calls: [{ name: 'read', args: { path: skillFile } }] };
    }
    if (lastCallName === 'mcp_call' && lastResultText.includes(DOC_PATH) && !/尚未连接|revoked|not_assigned|actor_pending|失败|拒绝|disabled/.test(lastResultText)) {
      return { calls: [{ name: 'mcp_call', args: {
        server: 'feishu-kb-bridge', tool: 'build_handoff_submit',
        arguments: { operationId: 'writer-handoff-1', summary: `${DOC_PATH} 已提交`, artifactRefs: [DOC_PATH], sourceScope: ['tok1'] },
      } }] };
    }
    return { calls: [{ name: 'mcp_call', args: {
      server: 'feishu-kb-bridge', tool: 'kb_write_doc',
      arguments: {
        path: DOC_PATH,
        operationId: 'writer-doc-1',
        title: '战斗行动总览',
        markdown: '战斗以回合制推进：先手由速度决定，每回合累计怒气，怒气满后可释放战技。fixture e2e 正文。',
        sources: ['tok1'],
        summary: '战斗回合推进、先手判定与怒气消耗的总览。',
        tags: ['战斗'],
      },
    } }] };
  }
  if (latestUserText.includes('审查任务')) {
    // ---- 审查者状态机 ----
    if (results.includes('handoffId=') || /已提交交接记录 ho_/.test(results)) return { text: '审查完成。' };
    if (results.includes('krev_') || results.includes('审查报告已提交') || lastCallName === 'kb_submit_review') {
      return { calls: [{ name: 'mcp_call', args: {
        server: 'feishu-kb-bridge', tool: 'build_handoff_submit',
        arguments: { operationId: 'reviewer-handoff-1', summary: '审查通过', artifactRefs: [], sourceScope: ['tok1'] },
      } }] };
    }
    return { calls: [{ name: 'mcp_call', args: {
      server: 'feishu-kb-bridge', tool: 'kb_submit_review',
      arguments: {
        operationId: 'review-1',
        unitId: 'all',
        coverage: { sourceRefs: ['tok1'] },
        checkedDimensions: ['完整性'],
        issues: [],
        conclusion: 'pass',
      },
    } }] };
  }
  return { text: '（fixture 无匹配动作）' };
}

/** 极小 OpenAI 兼容 chat/completions 服务（支持 stream 与否都回应）。 */
function startFixtureModel(): Promise<{ server: http.Server; port: number; requests: Array<{ model?: string }> }> {
  const requests: Array<{ model?: string }> = [];
  const server = http.createServer((req, res) => {
    if (!req.url || !req.url.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8'); });
    req.on('end', async () => {
      let parsed: { model?: string; stream?: boolean; messages?: Array<Record<string, unknown>> } = {};
      try { parsed = JSON.parse(body) as typeof parsed; } catch { /* 空体 */ }
      const messages = parsed.messages ?? [];
      // Real models take time before their first child tool call. The fixture
      // responds in microseconds, earlier than amagi's asynchronous MCP
      // discovery, and can trip its same-call loop guard before connection.
      if (!messages.some((message) => message.role === 'assistant')
        && messages.some((message) => message.role === 'user'
          && /写作任务|审查任务/.test(textOf(message)))) {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      requests.push({ model: parsed.model });
      const action = nextAction(messages);
      const id = `chatcmpl-fixture-${requests.length}`;
      const message = {
        role: 'assistant',
        content: action.text ?? null,
        ...(action.calls ? {
          tool_calls: action.calls.map((call, index) => ({
            id: `call_${id}_${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        } : {}),
      };
      if (parsed.stream === true) {
        // OpenAI chunk 格式（对齐 probe 任务实测定稿：tool_calls 按 index 单帧完整下发，
        // 不拆分 JSON，避免多 tool_calls 拼接错误）
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const send = (chunk: Record<string, unknown>): void => { res.write(`data: ${JSON.stringify(chunk)}\n\n`); };
        const chunkBase = { id, object: 'chat.completion.chunk', model: parsed.model ?? 'fixture' };
        if (action.text) send({ ...chunkBase, choices: [{ index: 0, delta: { role: 'assistant', content: action.text }, finish_reason: null }] });
        else send({ ...chunkBase, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
        for (let index = 0; index < (action.calls?.length ?? 0); index += 1) {
          const call = (message.tool_calls ?? [])[index];
          send({ ...chunkBase, choices: [{ index: 0, delta: { tool_calls: [{ index, id: call?.id, type: 'function', function: call?.function }] }, finish_reason: null }] });
        }
        send({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: action.calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: parsed.model ?? 'fixture',
        choices: [{ index: 0, message, finish_reason: action.calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, port: address.port, requests });
    });
  });
}

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

describe('pi-amagi 端到端接入试验（真实 pi/amagi/桥接；fixture 模型，非真实模型质量）', () => {
  const piPath = findPiOnPath();
  const hasAmagiSource = Boolean(AMAGI_SOURCE_DIR) && fs.existsSync(path.join(AMAGI_SOURCE_DIR, 'package.json'));
  const runE2e = Boolean(piPath) && hasAmagiSource;
  if (!runE2e) console.warn('[e2e] 明确跳过真实链路：需PATH中的pi及显式AMAGI_PI_SOURCE_DIR；未执行不计通过。');

  let home: string | null = null;
  let keepHomeOnFailure = false;
  let fixture: { server: http.Server; port: number; requests: Array<{ model?: string }> } | null = null;
  let httpServer: http.Server | typeof import('@hono/node-server').serve extends never ? never : ReturnType<typeof serve> | null = null;
  let apiPort = 0;
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
  const prevHome = process.env.FEISHU_SYNC_HOME;

  beforeAll(async () => {
    if (!runE2e) return;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-v2-'));
    process.env.FEISHU_SYNC_HOME = home;
    fixture = await startFixtureModel();
    const raw = path.join(home, 'raw');
    fs.mkdirSync(path.join(raw, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(raw, 'docs', 'src1.md'), '# 源文档：战斗规则\n\n战斗以回合制推进，先手由速度决定，每回合累计怒气。\n');
    // 预写配置（buildServer 启动时读取）
    const manager = new ConfigManager(path.join(home, 'config.json'));
    await manager.load();
    await manager.updateConfig({
      knowledgeBaseRoot: raw,
      agent: {
        runtime: { backend: 'pi' },
        model: { source: 'app-llm' },
      },
      llm: {
        activeProviderId: 'fixtureglm',
        activeModelId: 'glm-5.3',
        providers: [{
          id: 'fixtureglm',
          name: 'fixture GLM',
          enabled: true,
          protocol: 'openai-completions',
          openAiCompatBaseUrl: `http://127.0.0.1:${fixture.port}/v1`,
          apiKey: 'fixture-key',
          defaultModelId: 'glm-5.3',
          models: [
            { id: 'glm-5.3', name: 'glm-5.3', enabled: true, openAiModel: 'glm-5.3' },
            { id: 'glm-5.3-flash', name: 'glm-5.3-flash', enabled: true, openAiModel: 'glm-5.3-flash' },
          ],
        }],
      },
      standardKb: {
        outputRoot: path.join(home, 'standard'),
        orchestrationMode: 'pi-amagi',
        publishMode: 'auto',
        buildConcurrency: 2,
      },
    } as never);
    // 真实 server（buildServer：真实 ConfigManager/LocalMapStore/工具服务/宿主）
    const builtApp = await buildServer({ desktopMode: true, desktopToken: DESKTOP_TOKEN, configPath: path.join(home, 'config.json') });
    app = builtApp;
    await new Promise<void>((resolve) => {
      httpServer = serve({ fetch: builtApp.fetch, port: 0, hostname: '127.0.0.1' }, (info) => { apiPort = info.port; resolve(); });
    });
    expect(apiPort).toBeGreaterThan(0);
    (app as unknown as { __setAgentInternalPort: (port: number) => void }).__setAgentInternalPort(apiPort);
    // 源文档登记（真实 DB；documentsProvider 投影）
    const store = new LocalMapStore(path.join(home, 'feishu-sync.db'));
    store.initialize();
    store.upsertDocument({
      objToken: 'tok1', wikiNodeToken: null, objType: 'docx', title: '源文档：战斗规则',
      localMdPath: path.join(raw, 'docs', 'src1.md'),
      lastSyncedModifyTime: '', lastSyncedAt: new Date().toISOString(), status: 'synced',
    } as never);
    store.close();
  }, 120_000);

  afterAll(async () => {
    if (prevHome === undefined) delete process.env.FEISHU_SYNC_HOME;
    else process.env.FEISHU_SYNC_HOME = prevHome;
    // ENOTEMPTY 根因收口（与 fix-e2e 同一链）：先走正式服务级关闭链
    // （取消活动构建并等 OS 级收口），再关 HTTP/fixture。修正轮：只有
    // shutdown 报告 quiesced=true（OS 级确认，含持久/内存终止对账）才允许
    // 删 home；未收口/报告不可得时保留现场并明确标记，不用重试/rm 冒充退出。
    let shutdownReport: { quiesced: boolean; unsettled: string[]; unconfirmedTerminations: Array<{ buildId: string; source: string; note: string }> } | null = null;
    try {
      shutdownReport = await (app as unknown as { __shutdownServices?: () => Promise<typeof shutdownReport> } | null)?.__shutdownServices?.() ?? null;
    } catch (error) {
      console.error('[e2e] shutdownServices failed:', error);
    }
    await new Promise<void>((resolve) => { httpServer?.close(() => resolve()); if (!httpServer) resolve(); });
    await new Promise<void>((resolve) => { fixture?.server.close(() => resolve()); if (!fixture) resolve(); });
    if (home && !keepHomeOnFailure) {
      if (!shutdownReport?.quiesced) {
        keepHomeOnFailure = true;
        console.error('[kept-home:shutdown-unsettled]', home,
          shutdownReport
            ? `超时未收口=${shutdownReport.unsettled.join(',') || '无'}；终止未确认=${shutdownReport.unconfirmedTerminations.map((item) => `${item.buildId}(${item.source}:${item.note.slice(0, 120)})`).join(',') || '无'}`
            : '（shutdownServices 报告不可得）');
      } else {
        let removed = false;
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 3 && !removed; attempt += 1) {
          try {
            fs.rmSync(home, { recursive: true, force: true });
            removed = true;
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        if (!removed) {
          keepHomeOnFailure = true;
          console.error('[kept-home:rm-failed]', home, String(lastError));
        }
      }
    } else if (home) console.error('[kept-home]', home);
  });

  it.runIf(runE2e)('环境前置', () => {
    expect(piPath).toBeTruthy();
    expect(hasAmagiSource).toBe(true);
  });

  it.runIf(runE2e)(
    'POST /api/kb/build-runtime/install → 真实安装（source 模式 + pi CLI）',
    async () => {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/kb/build-runtime/install`, {
        method: 'POST',
        headers: { 'X-Desktop-Token': DESKTOP_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceDir: AMAGI_SOURCE_DIR }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { installed: boolean; version: string; contentHash: string };
      expect(body.installed).toBe(true);
      expect(body.version).toBe(AMAGI_SOURCE_VERSION);
      expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    },
    240_000,
  );

  it.runIf(runE2e)(
    'POST /api/kb/builds → 真实 Leader → amagi 子任务 → 桥接 → 候选接受 → published',
    async () => {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds`, {
        method: 'POST',
        headers: { 'X-Desktop-Token': DESKTOP_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'full', confirm: 'BUILD' }),
      });
      expect(response.status).toBe(202);
      const dto = await response.json() as { id: string; orchestrationMode?: string };
      expect(dto.orchestrationMode).toBe('pi-amagi');
      // 轮询至终态（真实 Leader/子任务/发布管线；宽限 5 分钟）
      const deadline = Date.now() + 300_000;
      let status = 'queued';
      let row: Record<string, unknown> | null = null;
      let leader: Record<string, unknown> | null = null;
      let polls = 0;
      while (Date.now() < deadline) {
        const statusResponse = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${dto.id}`, { headers: { 'X-Desktop-Token': DESKTOP_TOKEN } });
        row = await statusResponse.json() as Record<string, unknown>;
        status = String(row.status);
        const leaderResponse = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${dto.id}/leader`, { headers: { 'X-Desktop-Token': DESKTOP_TOKEN } });
        if (leaderResponse.status === 200) leader = await leaderResponse.json() as Record<string, unknown>;
        polls += 1;
        if (polls % 10 === 1) {
          console.error('[poll]', JSON.stringify({
            status,
            tasks: ((leader?.tasks ?? []) as Array<{ role: string; status: string; execState: string | null }>).map((task) => `${task.role}:${task.status}/${task.execState ?? '-'}`),
            rounds: leader?.rounds,
            summary: leader?.summary,
            publish: (leader?.publishRequest as { status?: string } | null)?.status ?? null,
            ended: leader?.endedReason,
          }).slice(0, 600));
        }
        if (['published', 'failed', 'cancelled', 'interrupted', 'awaiting_release'].includes(status)) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (status !== 'published') {
        console.error('[poll-final]', JSON.stringify({ status, row, leader }).slice(0, 3000));
      }
      // 终态后重取 Leader DTO（账本 settle/监督收尾有亚秒级延迟，接受点直写后仍重取兜底）
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const leaderFinal = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${dto.id}/leader`, { headers: { 'X-Desktop-Token': DESKTOP_TOKEN } });
      if (leaderFinal.status === 200) leader = await leaderFinal.json() as Record<string, unknown>;
      // 断言失败时保留现场（全部通过后复位）
      keepHomeOnFailure = true;
      // 断言：真实成功路径（不允许以 failed 冒充成功）
      expect(status).toBe('published');
      expect(String(row?.releaseId)).toMatch(/^r_/);
      // 真实监督进度：身份登记（writer/reviewer confirmed）+ 发布接受
      expect(leader).not.toBeNull();
      const tasks = (leader?.tasks ?? []) as Array<{ role: string; status: string; execState: string | null }>;
      expect(tasks.some((task) => task.role === 'luban' && task.status === 'confirmed')).toBe(true);
      expect(tasks.some((task) => task.role === 'diting' && task.status === 'confirmed')).toBe(true);
      expect((leader?.publishRequest as { accepted?: boolean })?.accepted).toBe(true);
      expect((leader?.summary as { acceptedDocumentCount: number | null })?.acceptedDocumentCount).toBe(1);
      // steer #3：真实 DTO 字段（openBlockingCount 来自账本；skill 物化路径+内容哈希公开）
      expect((leader?.summary as { openBlockingCount: number | null })?.openBlockingCount).toBe(0);
      expect((leader?.skill as { path: string; revision: string } | null)?.revision).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.existsSync(String((leader?.skill as { path: string } | null)?.path))).toBe(true);
      // 真实发布产物：CURRENT.json 指针（与检查点指针同约定）+ 发布文档
      const outputRoot = path.join(home!, 'standard');
      expect(fs.existsSync(path.join(outputRoot, 'CURRENT.json'))).toBe(true);
      const currentPointer = JSON.parse(fs.readFileSync(path.join(outputRoot, 'CURRENT.json'), 'utf-8')) as { releaseId: string };
      expect(currentPointer.releaseId).toMatch(/^r_/);
      const releaseDir = path.join(outputRoot, 'releases', currentPointer.releaseId);
      expect(fs.existsSync(path.join(releaseDir, 'docs', DOC_PATH))).toBe(true);
      // 真实成果账本与结算锁：以 BuildCheckpointStore 真实布局（.builds/<id>/checkpoints/）读取
      const checkpoint = new BuildCheckpointStore(outputRoot).read(dto.id);
      expect(checkpoint?.leaderRun).toBeTruthy();
      const kinds = (checkpoint?.leaderRun?.actorPayload?.receipts ?? []).map((receipt) => receipt.kind).sort();
      expect(kinds).toContain('write_doc');
      expect(checkpoint?.leaderRun?.actorPayload?.reviews?.length).toBeGreaterThan(0);
      // steer #6：发布窗口结算锁与发布申请快照随检查点持久化
      expect(checkpoint?.leaderRun?.publishLock?.candidateHash).toMatch(/^[0-9a-f]{64}$/);
      expect(checkpoint?.leaderRun?.publishRequest?.accepted).toBe(true);
      // fixture 模型确实被调用（Leader 与子任务两模型都到达）
      expect((fixture?.requests.length ?? 0)).toBeGreaterThan(3);
      keepHomeOnFailure = false;
    },
    330_000,
  );
});
