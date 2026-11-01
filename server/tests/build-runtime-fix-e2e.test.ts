/**
 * 重构 v2 F09/F10/F15 后端修复端到端试验（真实 pi/amagi/桥接；fixture 模型）。
 *
 * 必测项（任务书）：
 * 1. 真实 Pi Leader + 长驻 child → 对 Leader 硬 SIGKILL → 残留回收或明确
 *    unconfirmed 阻止新启动；异常退出不假 finished。
 * 2. PID 复用模拟不发终止信号（真实 OS 进程表/出生令牌，无注入）。
 * 3. 同会话真正续接 vs 成果级全新内部库（不同 epoch/agentDir/sessionId，
 *    未导入旧内部任务）。
 *
 * fixture 模型与状态机复用 d21 续批 e2e（build-v2-integration 树，6/6 已验证），
 * 单文档简化。模型为本地 fixture——非真实模型质量。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { buildServer } from '../src/index.js';
import { BuildCheckpointStore } from '../src/kb/build-checkpoint.js';
import { readBirthIdentities } from '../src/agent/build-runtime/process-identity.js';
import { reconcileResidualProcesses } from '../src/agent/build-runtime/process-residual.js';

const AMAGI_SOURCE_DIR = process.env.AMAGI_PI_SOURCE_DIR || '';
const DESKTOP_TOKEN = 'e2e-desktop-token';
const DOC_PATH = 'combat/overview.md';

function findPiOnPath(): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'pi');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

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

/** 由会话推导下一个动作（Leader/写作者/审查者状态机；单文档）。 */
function nextAction(messages: Array<Record<string, unknown>>): { text?: string; calls?: FixtureCall[] } {
  const all = messages.map((message) => textOf(message as { content?: unknown })).join('\n');
  const results = toolResultsOf(messages);
  const firstUser = messages.find((message) => message.role === 'user');
  const taskText = firstUser ? textOf(firstUser as { content?: unknown }) : '';
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const lastUserText = lastUser ? textOf(lastUser as { content?: unknown }) : '';
  const lastToolResult = [...messages].reverse().find((message) => message.role === 'tool');
  const lastResultText = lastToolResult ? textOf(lastToolResult as { content?: unknown }) : '';
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant' && Array.isArray((message as { tool_calls?: unknown }).tool_calls) && (message as { tool_calls: unknown[] }).tool_calls.length > 0);
  const lastCallName = (() => {
    const calls = (lastAssistant as { tool_calls?: Array<{ function?: { name?: string } }> } | undefined)?.tool_calls;
    return calls && calls.length > 0 ? calls[calls.length - 1]?.function?.name ?? '' : '';
  })();

  if (messages.filter((message) => message.role === 'assistant').length > 200) {
    return { text: '（fixture 步数上限，终止任务）' };
  }
  if (lastCallName === 'mcp_call' && /尚未连接|not connected|is disabled|connection closed/.test(lastResultText)) {
    const skillFile = taskText.match(/read 读取技能文件 (\S+)/)?.[1];
    if (skillFile) return { calls: [{ name: 'read', args: { path: skillFile } }] };
  }

  if ((taskText.includes('本次构建交代') || lastUserText.includes('续接交代')) && !(taskText.includes('写作任务') || taskText.includes('审查任务'))) {
    // ---- Leader 状态机（单文档：写作 → 审查 → 发布）----
    if (results.includes('已结算：accepted') || /发布申请 pub_[0-9a-f]+ 已结算/.test(results)) {
      return { text: '发布已接受，构建收尾。' };
    }
    if (/\[task_submit 完成 diting\/[0-9a-f]{8}\] 状态: done/.test(all)) {
      return { calls: [{ name: 'build_request_publish', args: { summary: '全部成果通过审查（fixture e2e）' } }] };
    }
    const done = /\[task_submit 完成 luban\/[0-9a-f]{8}\] 状态: done｜任务: 「写作任务：撰写标准文档 combat\/overview.md/.test(all);
    const ditingDone = /\[task_submit 完成 diting\/[0-9a-f]{8}\] 状态: done/.test(all);
    const ditingError = [...all.matchAll(/\[task_submit 完成 diting\/[0-9a-f]{8}\] 状态: error/g)].length;
    const ditingDispatched = messages.some((message) => {
      const calls = (message as { role?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls;
      return message.role === 'assistant' && Array.isArray(calls) && calls.some((call) => call.function?.name === 'task_submit' && String(call.function?.arguments).includes('diting'));
    });
    if (lastCallName === 'task_submit') {
      const handle = lastResultText.match(/句柄:\s*([0-9a-fA-F-]{20,})/);
      const lastArgs = (() => {
        try {
          const raw = (lastAssistant as { tool_calls?: Array<{ function?: { arguments?: string } }> } | undefined)?.tool_calls?.[0]?.function?.arguments;
          return raw ? JSON.parse(raw) as { agent?: string } : null;
        } catch { return null; }
      })();
      if (lastArgs?.agent === 'luban' && handle) {
        return { calls: [{ name: 'build_assign_output', args: { ownerTaskId: handle[1], targets: [DOC_PATH] } }] };
      }
    }
    if (done && !ditingDone && !(ditingDispatched && ditingError >= 1)) {
      const skillForReview = taskText.match(/技能文件（子任务可 read 校验正文，正文与系统规则同源）：(\S+)/)?.[1] ?? '(未知)';
      return { calls: [{ name: 'task_submit', args: {
        agent: 'diting',
        task: `审查任务：对 staging 草稿（combat/overview.md）做独立审查。可先 read 读取技能文件 ${skillForReview} 确认含「内容质量基线」标记，再经 mcp_call 调用 kb_submit_review 提交审查报告（conclusion=pass，coverage.sourceRefs=["tok1"]），最后经 mcp_call 调用 build_handoff_submit 提交交接。`,
        delivery: 'handle',
      } }] };
    }
    if (!done) {
      const dispatched = messages.some((message) => {
        const calls = (message as { role?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls;
        return message.role === 'assistant' && Array.isArray(calls) && calls.some((call) => call.function?.name === 'task_submit' && String(call.function?.arguments).includes('撰写标准文档'));
      });
      const writerError = [...all.matchAll(/\[task_submit 完成 luban\/[0-9a-f]{8}\] 状态: error/g)].length >= 2;
      if (!dispatched) {
        const skillFileForTask = taskText.match(/技能文件（子任务可 read 校验正文，正文与系统规则同源）：(\S+)/)?.[1] ?? '(未知)';
        return { calls: [{ name: 'task_submit', args: {
          agent: 'luban',
          task: `写作任务：撰写标准文档 ${DOC_PATH}（慢速：写作前反复 read 技能文件校验规则）。先用 read 读取技能文件 ${skillFileForTask} 并确认含「内容质量基线」标记，再经 mcp_call 调用 kb_write_doc 写入草稿（path=${DOC_PATH}），最后经 mcp_call 调用 build_handoff_submit 提交交接。`,
          delivery: 'handle',
        } }] };
      }
      if (writerError) return { text: '写作任务反复失败，构建无法收口（fixture 放弃）。' };
      return { text: '写作任务执行中，等待完成通知。' };
    }
    return { text: '写作已完成，等待审查完成。' };
  }
  if (taskText.includes('写作任务')) {
    // ---- 写作者状态机（慢速读循环保 kill 窗口；先验证技能标记再写）----
    if (results.includes('handoffId=') || /已提交交接记录 ho_[0-9a-f]+/.test(results)) return { text: '写作完成。' };
    const skillFile = taskText.match(/read 读取技能文件 (\S+)/)?.[1];
    const markerCount = (results.match(/内容质量基线/g) ?? []).length;
    if (skillFile && markerCount === 0) {
      if (lastCallName === 'read') return { text: '技能正文读取失败或缺少「内容质量基线」规则标记（fixture 终止）。' };
      return { calls: [{ name: 'read', args: { path: skillFile } }] };
    }
    if (skillFile && lastCallName === 'read') {
      const readCallCount = messages.reduce((count, message) => {
        const calls = (message as { role?: string; tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls;
        return count + (message.role === 'assistant' && Array.isArray(calls) ? calls.filter((call) => call.function?.name === 'read').length : 0);
      }, 0);
      if (readCallCount < 90) {
        const homeDir = skillFile.replace(/\/skills\/[^/]+$/, '');
        const target = readCallCount % 2 === 0 ? skillFile : `${homeDir}/work/rule-check-${readCallCount}.md`;
        return { calls: [{ name: 'read', args: { path: target } }] };
      }
    }
    if (lastCallName === 'mcp_call' && lastResultText.includes(DOC_PATH) && !/尚未连接|revoked|not_assigned|actor_pending|失败|拒绝|disabled/.test(lastResultText)) {
      return { calls: [{ name: 'mcp_call', args: {
        server: 'feishu-kb-bridge', tool: 'build_handoff_submit',
        arguments: { operationId: 'writer-handoff-a', summary: `${DOC_PATH} 已提交`, artifactRefs: [DOC_PATH], sourceScope: ['tok1'] },
      } }] };
    }
    return { calls: [{ name: 'mcp_call', args: {
      server: 'feishu-kb-bridge', tool: 'kb_write_doc',
      arguments: {
        path: DOC_PATH,
        operationId: 'writer-doc-a',
        title: '战斗行动总览',
        markdown: '战斗以回合制推进：先手由速度决定，每回合累计怒气，怒气满后可释放战技。fixture e2e 正文。',
        sources: ['tok1'],
        summary: '战斗回合推进、先手判定与怒气消耗的总览。',
        tags: ['战斗'],
      },
    } }] };
  }
  if (taskText.includes('审查任务')) {
    // ---- 审查者状态机 ----
    if (results.includes('handoffId=') || /已提交交接记录 ho_[0-9a-f]+/.test(results)) return { text: '审查完成。' };
    const skillFileReview = taskText.match(/read 读取技能文件 (\S+)/)?.[1];
    if (skillFileReview && !results.includes('内容质量基线')) {
      if (lastCallName === 'read' && !lastResultText.includes('内容质量基线')) {
        return { text: '技能正文读取失败或缺少「内容质量基线」规则标记（fixture 终止）。' };
      }
      return { calls: [{ name: 'read', args: { path: skillFileReview } }] };
    }
    if (results.includes('已提交审查报告') || /kr_[0-9a-f]{8,}/.test(results) || results.includes('krev_')) {
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

/** 极小 OpenAI 兠容 chat/completions 服务（支持 stream 与否都回应）。 */
function startFixtureModel(): Promise<{ server: http.Server; port: number; requests: Array<{ model?: string; t: number }> }> {
  const requests: Array<{ model?: string; t: number }> = [];
  const server = http.createServer((req, res) => {
    if (!req.url || !req.url.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8'); });
    req.on('end', () => {
      let parsed: { model?: string; stream?: boolean; messages?: Array<Record<string, unknown>> } = {};
      try { parsed = JSON.parse(body) as typeof parsed; } catch { /* 空体 */ }
      requests.push({ model: parsed.model, t: Date.now() });
      const action = nextAction(parsed.messages ?? []);
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
// 端到端（真实 pi/amagi/桥；fixture 模型）
// ---------------------------------------------------------------------------

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function isPosix(): boolean { return process.platform === 'darwin' || process.platform === 'linux'; }

/** 读 epoch home 下全部 amagi 启动锚点（发现残留个体的受信线索）。 */
function readAnchors(homeDir: string): Array<{ taskId: string; rootPid: number; rootIdentityToken?: string; leaderPid: number }> {
  const auditsRoot = path.join(homeDir, 'amagi', 'data', 'process-audits');
  const out: Array<{ taskId: string; rootPid: number; rootIdentityToken?: string; leaderPid: number }> = [];
  if (!fs.existsSync(auditsRoot)) return out;
  for (const name of fs.readdirSync(auditsRoot)) {
    const file = path.join(auditsRoot, name, 'launch-anchor.json');
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { taskId?: string; runs?: Array<Record<string, unknown>> };
      for (const run of parsed.runs ?? []) {
        if (typeof run.rootPid === 'number' && typeof run.leaderPid === 'number') {
          out.push({
            taskId: String(parsed.taskId ?? name),
            rootPid: run.rootPid,
            ...(typeof run.rootIdentityToken === 'string' ? { rootIdentityToken: run.rootIdentityToken } : {}),
            leaderPid: run.leaderPid,
          });
        }
      }
    } catch { /* 坏文件跳过 */ }
  }
  return out;
}

function psBridgeCount(): number {
  try {
    const out = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf-8', timeout: 5000 });
    return out.split('\n').filter((line) => line.includes('claude-bridge.cjs')).length;
  } catch { return -1; }
}

describe('F09/F10 修复端到端（真实 pi/amagi/桥接；fixture 模型，非真实模型质量）', () => {
  const piPath = findPiOnPath();
  const hasAmagiSource = Boolean(AMAGI_SOURCE_DIR) && fs.existsSync(path.join(AMAGI_SOURCE_DIR, 'package.json'));
  const runE2e = Boolean(piPath) && hasAmagiSource;
  if (!runE2e) console.warn('[fix-e2e] 明确跳过真实链路：需 PATH 中的 pi 及显式 AMAGI_PI_SOURCE_DIR；未执行不计通过。');

  let home: string | null = null;
  let keepHomeOnFailure = false;
  let fixture: { server: http.Server; port: number; requests: Array<{ model?: string; t: number }> } | null = null;
  let builtApp: Awaited<ReturnType<typeof buildServer>> | null = null;
  let httpServer: ReturnType<typeof serve> | null = null;
  let apiPort = 0;
  const prevHome = process.env.FEISHU_SYNC_HOME;

  beforeAll(async () => {
    if (!runE2e) return;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-fix-e2e-'));
    process.env.FEISHU_SYNC_HOME = home;
    fixture = await startFixtureModel();
    const raw = path.join(home, 'raw');
    fs.mkdirSync(path.join(raw, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(raw, 'docs', 'src1.md'), '# 源文档：战斗规则\n\n战斗以回合制推进，先手由速度决定，每回合累计怒气。\n');
    const manager = new ConfigManager(path.join(home, 'config.json'));
    await manager.load();
    await manager.updateConfig({
      knowledgeBaseRoot: raw,
      agent: { runtime: { backend: 'pi' }, model: { source: 'app-llm' } },
      llm: {
        activeProviderId: 'fixtureglm',
        activeModelId: 'glm-5.3',
        providers: [{
          id: 'fixtureglm', name: 'fixture GLM', enabled: true, protocol: 'openai-completions',
          openAiCompatBaseUrl: `http://127.0.0.1:${fixture.port}/v1`,
          apiKey: 'fixture-key', defaultModelId: 'glm-5.3',
          models: [{ id: 'glm-5.3', name: 'glm-5.3', enabled: true, openAiModel: 'glm-5.3' }],
        }],
      },
      standardKb: {
        outputRoot: path.join(home, 'standard'),
        orchestrationMode: 'pi-amagi',
        publishMode: 'auto',
        buildConcurrency: 2,
      },
    } as never);
    const built = await buildServer({ desktopMode: true, desktopToken: DESKTOP_TOKEN, configPath: path.join(home, 'config.json') });
    builtApp = built;
    await new Promise<void>((resolve) => {
      httpServer = serve({ fetch: builtApp.fetch, port: 0, hostname: '127.0.0.1' }, (info) => { apiPort = info.port; resolve(); });
    });
    expect(apiPort).toBeGreaterThan(0);
    (builtApp as unknown as { __setAgentInternalPort: (port: number) => void }).__setAgentInternalPort(apiPort);
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
    // ENOTEMPTY 根因收口：裸 buildServer 测试必须走正式服务级关闭链
    // （__shutdownServices 与 startServer.close 同一实现）——先取消活动构建
    // 并等待流水线收口（Leader 宽限终止 + 残留回收对账；业务 cancelled
    // ≠ OS 退出），再关 HTTP/fixture。修正轮：pipelineRuns 清空≠quiescence
    // ——§九实测 unconfirmed 活子任务在 rm 成功后仍会重建 auth.json（惰性
    // 写者），只有 shutdown 报告 quiesced=true（含持久/内存终止对账）才允许
    // 删 home；未收口/报告不可得时保留现场并明确标记，不冒充退出。
    let shutdownReport: { quiesced: boolean; unsettled: string[]; unconfirmedTerminations: Array<{ buildId: string; source: string; note: string }> } | null = null;
    try {
      shutdownReport = await (builtApp as unknown as { __shutdownServices?: () => Promise<typeof shutdownReport> }).__shutdownServices?.() ?? null;
    } catch (error) {
      console.error('[fix-e2e] shutdownServices failed:', error);
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
    expect(isPosix()).toBe(true); // 本套真实链路断言依赖 POSIX 进程组/出生令牌
  }, 30_000);

  it.runIf(runE2e)('安装版本化 amagi（source 模式真实安装）', async () => {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/kb/build-runtime/install`, {
      method: 'POST',
      headers: { 'X-Desktop-Token': DESKTOP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceDir: AMAGI_SOURCE_DIR }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { installed: boolean; version: string };
    expect(body.installed).toBe(true);
    expect(body.version).toBe('2.21.31');
  }, 240_000);

  it.runIf(runE2e)(
    'F10：Leader 硬 SIGKILL → 子进程/桥按锚点回收、终止对账持久化、不假 finished',
    async () => {
      keepHomeOnFailure = true;
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds`, {
        method: 'POST',
        headers: { 'X-Desktop-Token': DESKTOP_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'full', confirm: 'BUILD' }),
      });
      expect(response.status).toBe(202);
      const dto = await response.json() as { id: string };
      const buildId = dto.id;
      // 等待：leader pid 已知 + 首个子任务锚点出现且 rootPid 存活（长驻 child 证据）
      const epoch1Home = path.join(home!, 'agent', 'builds', buildId, 'epochs', 'e1', 'home');
      const deadline = Date.now() + 120_000;
      let leaderPid: number | null = null;
      let anchors: ReturnType<typeof readAnchors> = [];
      while (Date.now() < deadline) {
        const leaderResp = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${buildId}/leader`, { headers: { 'X-Desktop-Token': DESKTOP_TOKEN } });
        if (leaderResp.status === 200) {
          const leader = await leaderResp.json() as { leader?: { pid: number | null } | null };
          if (typeof leader.leader?.pid === 'number') leaderPid = leader.leader.pid;
        }
        anchors = readAnchors(epoch1Home);
        if (leaderPid !== null && anchors.length > 0 && anchors.some((anchor) => pidAlive(anchor.rootPid))) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(leaderPid).not.toBeNull();
      expect(anchors.length).toBeGreaterThan(0);
      const liveAnchors = anchors.filter((anchor) => pidAlive(anchor.rootPid));
      expect(liveAnchors.length).toBeGreaterThan(0);
      // 对 Leader 硬 SIGKILL（外部强杀；不触发任何正常关闭路径）
      process.kill(leaderPid!, 'SIGKILL');
      // 等待监督终局（异常退出 → failed，绝不假 finished/published）
      const deadline2 = Date.now() + 90_000;
      let status = '';
      while (Date.now() < deadline2) {
        const rowResp = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${buildId}`, { headers: { 'X-Desktop-Token': DESKTOP_TOKEN } });
        status = String((await rowResp.json() as { status: string }).status);
        if (['failed', 'cancelled', 'published', 'interrupted'].includes(status)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(status).toBe('failed');
      // 终止对账持久化（检查点 leaderRun.termination；任务定义双出口：
      // 回收收敛=confirmed（自然退出/exited，生产零信号裁决 #5），或探测失效
      // /存活个体 → unconfirmed 且阻断后续 Leader——
      // 都不弱化证明强凑绿）
      const outputRoot = path.join(home!, 'standard');
      const checkpointStore = new BuildCheckpointStore(outputRoot);
      const deadline3 = Date.now() + 60_000;
      let termination: { state?: string; children?: Array<{ pid: number; verdict: string; proof: string }> } | null | undefined;
      while (Date.now() < deadline3) {
        const checkpoint = checkpointStore.read(buildId);
        termination = checkpoint?.leaderRun?.termination;
        if (termination) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(termination).toBeTruthy();
      // /leader DTO：processTermination 摘要与 termination 映射（F10 调整 #1；
      // 在任何后续恢复/取消改变状态前读取）
      const leaderResp2 = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${buildId}/leader`, { headers: { 'X-Desktop-Token': DESKTOP_TOKEN } });
      const leaderDto = await leaderResp2.json() as {
        processTermination: { state: string; unconfirmedPids: number[] } | null;
        termination: string | null;
        runtimeEpoch: number | null;
        rounds: { started: number; ended: number } | null;
      };
      expect(leaderDto.processTermination?.state).toBe(termination!.state);
      expect(leaderDto.termination).toBe(termination!.state === 'unconfirmed' ? 'termination-unconfirmed' : 'finished');
      expect(leaderDto.runtimeEpoch).toBe(1);
      expect(leaderDto.rounds === null || typeof leaderDto.rounds.started === 'number').toBe(true);
      // 首次运行（SIGKILL 造成）的 endedReason 在任何后续恢复/取消覆盖前断言
      const firstCheckpoint = checkpointStore.read(buildId);
      expect(firstCheckpoint?.leaderRun?.endedReason).toBe('leader-failed');
      if (termination!.state === 'confirmed') {
        // 裁决 #5：生产不对历史发现/仅数字 PID 目标自动发信号——confirmed 只能
        // 由自然退出/自有句柄路径达成（exited/not-ours），不再期待 reaped 正例。
        const bad = termination!.children?.filter((child) => !['exited', 'not-ours', 'reaped'].includes(child.verdict)) ?? [];
        expect(bad).toEqual([]);
      } else {
        // 未确认出口：DTO 显式暴露（UI 不当 finished）；随即验证阻断行为——
        // 恢复尝试会先重试对账：仍未确认 → kb_termination_unconfirmed 阻断；
        // 若重试清障（探测恢复）→ 恢复放行也是合法收敛，取消后继续
        expect(termination!.state).toBe('unconfirmed');
        const blockedResp = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${buildId}/resume`, {
          method: 'POST',
          headers: { 'X-Desktop-Token': DESKTOP_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: 'RESUME', resumeStrategy: 'session' }),
        });
        expect(blockedResp.status).toBe(202);
        const deadlineBlocked = Date.now() + 60_000;
        let blockedError = '';
        let postResumeStatus = '';
        while (Date.now() < deadlineBlocked) {
          const rowResp = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${buildId}`, { headers: { 'X-Desktop-Token': DESKTOP_TOKEN } });
          const row = await rowResp.json() as { status: string; error?: { code?: string } | null };
          blockedError = row.error?.code ?? '';
          postResumeStatus = row.status;
          if (row.status === 'failed') break;
          if (['running', 'publishing', 'queued'].includes(row.status)) break; // 重试清障后放行
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        if (postResumeStatus === 'failed') {
          expect(blockedError).toContain('kb_termination_unconfirmed');
        } else {
          // 重试对账清障 → 恢复已启动：取消收敛，交后续测试重新接手
          await cancelAndWait(buildId);
        }
      }
      // 全部锚点个体退出（confirmed=已回收；unconfirmed=已阻断/重试清障，均不假确认）
      const settleDeadline = Date.now() + 90_000;
      const epoch1AnchorsPids = (): number[] => readAnchors(epoch1Home).map((anchor) => anchor.rootPid);
      while (Date.now() < settleDeadline && epoch1AnchorsPids().some((pid) => pidAlive(pid))) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      for (const pid of epoch1AnchorsPids()) {
        expect(pidAlive(pid)).toBe(false);
      }
      // Leader 进程本身已死（旧 pid ESRCH）
      expect(pidAlive(leaderPid!)).toBe(false);
      // 桥进程零残留（stdio 桥随 child 死亡/回收）
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(psBridgeCount()).toBe(0);
      killLeaderBuildId = buildId;
      keepHomeOnFailure = false;
    },
    300_000,
  );

  let killLeaderBuildId: string | null = null;

  it.runIf(runE2e)(
    'F09：同会话真正续接（同 epoch/同 sessionId）与成果级重建（新 epoch/agentDir/sessionId、不导入旧内部库）',
    async () => {
      keepHomeOnFailure = true;
      expect(killLeaderBuildId).toBeTruthy();
      const buildId = killLeaderBuildId!;
      const headers = { 'X-Desktop-Token': DESKTOP_TOKEN, 'Content-Type': 'application/json' };
      const outputRoot = path.join(home!, 'standard');
      const checkpointStore = new BuildCheckpointStore(outputRoot);
      const run1 = checkpointStore.read(buildId)?.leaderRun;
      expect(run1?.runtimeEpoch).toBe(1);
      expect(run1?.binding?.leaderSessionId).toBe(`build-${buildId}-e1`);
      const epoch1Home = path.join(home!, 'agent', 'builds', buildId, 'epochs', 'e1', 'home');
      const run1Anchors = readAnchors(epoch1Home);
      expect(run1Anchors.length).toBeGreaterThan(0);
      // ① 同会话续接：同 epoch、同 sessionId、新 pid（旧 binding 快照会在
      // 新 Leader 启动前短暂残留，等待条件必须钉住 pid 已换代）
      const sessionResp = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${buildId}/resume`, {
        method: 'POST', headers, body: JSON.stringify({ confirm: 'RESUME', resumeStrategy: 'session' }),
      });
      expect(sessionResp.status).toBe(202);
      const sessionLeader = await waitForLeader(buildId, (leader) => leader.leader?.sessionId === `build-${buildId}-e1`
        && typeof leader.leader?.pid === 'number' && leader.leader?.pid !== run1?.binding?.leaderPid, 60_000);
      expect(sessionLeader.leader?.pid).not.toBe(run1?.binding?.leaderPid);
      expect(pidAlive(sessionLeader.leader?.pid ?? 0)).toBe(true);
      // 等待检查点回写 binding（新 launch）后核对 epoch 未变
      await waitForCheckpoint(checkpointStore, buildId, (state) => state.runtimeEpoch === 1 && state.binding?.launchId !== run1?.binding?.launchId, 30_000);
      await cancelAndWait(buildId);
      // ② 成果级重建：新 epoch/agentDir/sessionId；新内部库不含旧任务锚点
      const rebuildResp = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${buildId}/resume`, {
        method: 'POST', headers, body: JSON.stringify({ confirm: 'RESUME', resumeStrategy: 'rebuild' }),
      });
      expect(rebuildResp.status).toBe(202);
      const rebuildLeader = await waitForLeader(buildId, (leader) => leader.leader?.sessionId === `build-${buildId}-e2`, 60_000);
      expect(rebuildLeader.leader?.sessionId).not.toBe(run1?.binding?.leaderSessionId);
      const epoch2Home = path.join(home!, 'agent', 'builds', buildId, 'epochs', 'e2', 'home');
      expect(fs.existsSync(path.join(epoch2Home, 'settings.json'))).toBe(true);
      // 未导入旧内部任务：e2 内部库在 Leader 启动时无旧锚点（新 epoch 全新 amagi 内部存储）
      const e2AnchorsEarly = readAnchors(epoch2Home);
      expect(e2AnchorsEarly.filter((anchor) => run1Anchors.some((old) => old.taskId === anchor.taskId)).length).toBe(0);
      // 旧 epoch 证据保留（不复制、不删除——历史）
      expect(readAnchors(epoch1Home).length).toBe(run1Anchors.length);
      // 检查点 epoch=2、binding 指向 e2
      await waitForCheckpoint(checkpointStore, buildId, (state) => state.runtimeEpoch === 2
        && state.binding?.agentDir === epoch2Home
        && state.binding?.leaderSessionId === `build-${buildId}-e2`, 30_000);
      // 旧 epoch 任务不挂住新运行：rebuild Leader 正常运行（不在旧 actor 上空转/阻塞）
      const rebuilt = checkpointStore.read(buildId)?.leaderRun;
      const oldActors = rebuilt?.actors.filter((actor) => actor.runtimeEpoch === 1) ?? [];
      expect(oldActors.length).toBeGreaterThan(0); // 旧任务保留为历史
      expect(oldActors.every((actor) => actor.status === 'revoked' || actor.runtimeEpoch === 1)).toBe(true);
      await cancelAndWait(buildId);
      keepHomeOnFailure = false;
    },
    300_000,
  );

  async function waitForLeader(buildId: string, predicate: (leader: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    let leader: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const resp = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${buildId}/leader`, { headers: { 'X-Desktop-Token': DESKTOP_TOKEN } });
      if (resp.status === 200) {
        leader = await resp.json() as Record<string, unknown>;
        if (predicate(leader)) return leader;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`waitForLeader 超时：${JSON.stringify(leader ?? null).slice(0, 400)}`);
  }

  async function waitForCheckpoint(store: BuildCheckpointStore, buildId: string, predicate: (state: NonNullable<ReturnType<BuildCheckpointStore['read']>['leaderRun']>) => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = store.read(buildId)?.leaderRun;
      if (state && predicate(state)) return;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error('waitForCheckpoint 超时');
  }

  async function cancelAndWait(buildId: string): Promise<void> {
    const cancelResp = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${buildId}/cancel`, { method: 'POST', headers: { 'X-Desktop-Token': DESKTOP_TOKEN } });
    expect(cancelResp.status).toBe(200);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const rowResp = await fetch(`http://127.0.0.1:${apiPort}/api/kb/builds/${buildId}`, { headers: { 'X-Desktop-Token': DESKTOP_TOKEN } });
      const status = String((await rowResp.json() as { status: string }).status);
      if (['cancelled', 'failed', 'published', 'interrupted'].includes(status)) return;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error('cancelAndWait 超时');
  }
});

// ---------------------------------------------------------------------------
// PID 复用模拟与真实回收（真实 OS 进程表/出生令牌；不依赖应用 server）
// ---------------------------------------------------------------------------

describe('F10：真实 OS 个体对账（无注入：真实 ps/出生令牌/信号）', () => {
  it.runIf(isPosix())('PID 复用模拟：锚点令牌不匹配的存活个体 → not-ours，绝不发信号', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'residual-real-'));
    try {
      const homeDir = path.join(root, 'home');
      const buildRoot = path.join(root, 'build');
      fs.mkdirSync(path.join(homeDir, 'amagi', 'data', 'process-audits', 'victim'), { recursive: true });
      // 无关存活进程（用 sleep 模拟被复用的 pid）
      const victim = spawn('sleep', ['60'], { detached: false, stdio: 'ignore' });
      const victimPid = victim.pid!;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pidAlive(victimPid)).toBe(true);
      // 锚点声称该 pid 是我们的任务，但出生令牌与真实内核令牌不一致（pid 复用）
      fs.writeFileSync(path.join(homeDir, 'amagi', 'data', 'process-audits', 'victim', 'launch-anchor.json'), JSON.stringify({
        version: 1,
        taskId: 'victim-task',
        runs: [{ backendRunId: 'run_v', rootPid: victimPid, pgid: victimPid, rootIdentityToken: 'darwin:1:1', leaderPid: process.pid, at: Date.now() }],
      }));
      const outcome = await reconcileResidualProcesses({ homeDir, buildRoot, leaderPids: new Set([process.pid]) }, { reap: true });
      const finding = outcome.children.find((child) => child.pid === victimPid);
      expect(finding?.verdict).toBe('not-ours');
      expect(finding?.proof).toBe('birth-token');
      // 绝不发信号：victim 仍存活
      expect(pidAlive(victimPid)).toBe(true);
      victim.kill('SIGKILL');
      await new Promise((resolve) => victim.once('exit', resolve));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(isPosix())('真实令牌匹配 + 自有 ChildProcess 句柄桥接 → TERM→复核→KILL 回收；生产（无注入）零信号', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'residual-real-'));
    let owned: ReturnType<typeof spawn> | null = null;
    try {
      const homeDir = path.join(root, 'home');
      const buildRoot = path.join(root, 'build');
      const audits = path.join(homeDir, 'amagi', 'data', 'process-audits', 'owned');
      fs.mkdirSync(audits, { recursive: true });
      const writeAnchor = (rootPid: number, token: string) => {
        fs.writeFileSync(path.join(audits, 'launch-anchor.json'), JSON.stringify({
          version: 1,
          taskId: 'owned-task',
          runs: [{ backendRunId: 'run_o', rootPid, pgid: rootPid, rootIdentityToken: token, leaderPid: process.pid, at: Date.now() }],
        }));
      };
      // ① 生产形态（不注入出口）：归属可证且存活 → unconfirmed 零信号（裁决 #5）
      owned = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' }); // pgid === pid
      const ownedPid = owned.pid!;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const tokens = await readBirthIdentities([ownedPid]);
      const token = tokens.get(ownedPid);
      expect(token).toBeTruthy();
      writeAnchor(ownedPid, token);
      const observed = await reconcileResidualProcesses({ homeDir, buildRoot, leaderPids: new Set([process.pid]) }, { reap: true });
      expect(observed.children.find((child) => child.pid === ownedPid)).toMatchObject({ verdict: 'unconfirmed', proof: 'birth-token' });
      expect(pidAlive(ownedPid)).toBe(true); // 生产对历史发现/仅数字 PID 目标零信号
      // ② 固定正例（裁决 #5）：桥接到测试当前持有的真实自有 ChildProcess 句柄
      //（不是模拟原子出口，也不代表生产默认能力）
      const reaped = await reconcileResidualProcesses({ homeDir, buildRoot, leaderPids: new Set([process.pid]) }, { reap: true }, {
        platform: process.platform,
        kill: (pid, signal) => {
          if (pid !== ownedPid || !owned) throw new Error(`意外信号目标 pid=${pid}`); // 出口只绑定本测试自有句柄
          owned.kill(signal);
        },
      });
      expect(reaped.children.find((child) => child.pid === ownedPid)).toMatchObject({ verdict: 'reaped', proof: 'birth-token' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pidAlive(ownedPid)).toBe(false);
    } finally {
      if (owned && owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
