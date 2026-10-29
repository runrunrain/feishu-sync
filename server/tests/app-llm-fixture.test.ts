/**
 * F3-R03/R04 真实 pi + 本地 OpenAI 兼容 fixture 回归（不消耗任何真实额度）
 *
 *  - R03：app-llm 会话链路注入与 probe/构建共用的 provider descriptor——
 *    本地起一个最小 OpenAI 兼容 SSE 端点，真实 pi + 真实扩展装载后：
 *    模型选中 feishu-sync-llm/fixture-model、fixture 收到
 *    `Authorization: Bearer <sentinel>`（key 只进子进程 env，测试用临时
 *    sentinel，不碰真实 key）、run token 不出现在 LLM 请求里。
 *  - R04：steer 真正投递【同一活跃 RPC 运行】——第一轮 fixture 返回
 *    kb_search 工具调用并挂起等待；宿主发官方 steer 命令（queued）后
 *    释放；第二轮请求的 messages 必须包含 steer 文本（pi 正式队列语义，
 *    非伪造），最终 assistant 回复带 STEERED_OK，JSONL 历史含两条 user。
 * 本机无 pi/Node 环境时整文件 skip（不冒充）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { buildServer } from '../src/index.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { buildPiProcessEnv, PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { piExtensionPath } from '../src/agent/agent-assets.js';
import { parseSessionJsonl } from '../src/agent/session-service.js';
import { buildDefaultAgentConfig } from '../src/types/agent-knowledge.js';

const TEST_TIMEOUT_MS = 90_000;
const SENTINEL_KEY = 'test-sentinel-key-f3r03';

let fixtureRoot: string;
let runtime: Awaited<ReturnType<PiRuntimeResolver['resolveRuntime']>> | null = null;
let app: Hono;
let toolService: AgentToolService;
let internalServer: ReturnType<typeof serve> | null = null;
let internalPort = 0;
let llmServer: http.Server | null = null;
let llmPort = 0;

/** fixture 收到的请求（url/auth/headers/body） */
const llmRequests: Array<{ url: string; auth: string | undefined; headers: http.IncomingHttpHeaders; body: any }> = [];
/** steer 场景控制：'text' 直答 | 'toolround' 挂起等 steer 后回工具调用 | 'steered' 第二轮 */
let llmMode: 'text' | 'toolround' | 'steered' | 'quota' = 'text';
let steerSent = false;

function sseBody(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textStreamChunks(text: string): string {
  const chunk = (delta: unknown, finish: string | null) => ({
    id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return sseBody(chunk({ role: 'assistant', content: '' }, null))
    + sseBody(chunk({ content: text }, null))
    + sseBody(chunk({}, 'stop'))
    + sseBody({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
}

function toolCallStreamChunks(): string {
  const chunk = (delta: unknown, finish: string | null) => ({
    id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return sseBody(chunk({ role: 'assistant', content: '' }, null))
    + sseBody(chunk({ tool_calls: [{ index: 0, id: 'call_fix1', type: 'function', function: { name: 'kb_search', arguments: '{"query":"fixture"}' } }] }, null))
    + sseBody(chunk({}, 'tool_calls'));
}

function waitFor(predicate: () => boolean, timeoutMs = 20_000, label = 'condition'): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待超时: ${label}`));
      }
    }, 50);
  });
}

beforeAll(async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'app-llm-fixture-'));
  const resolver = new PiRuntimeResolver();
  runtime = await resolver.resolveRuntime(buildDefaultAgentConfig(fixtureRoot));
  if (!runtime.nodePath || !runtime.piCliPath) return; // 环境缺失 → skip

  app = (await buildServer({ desktopMode: false })) as unknown as Hono;
  toolService = (app as unknown as { __agentToolService: AgentToolService }).__agentToolService;
  await new Promise<void>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      internalPort = info.port;
      resolve();
    });
    internalServer = server;
  });

  // 本地 OpenAI 兼容 SSE fixture
  llmServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (data: Buffer) => chunks.push(data));
    req.on('end', () => {
      let body: any = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { body = null; }
      llmRequests.push({ url: String(req.url), auth: req.headers.authorization, headers: { ...req.headers }, body });
      if (req.method === 'POST' && String(req.url).includes('chat/completions')) {
        if (llmMode === 'quota') {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: '1113', message: `余额不足或无可用资源包: ${SENTINEL_KEY}` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (llmMode === 'toolround') {
          void (async () => {
            try {
              // 挂起：给宿主时间发 steer（保证 steer 落在流式运行中）
              await waitFor(() => steerSent, 25_000, 'steer 命令');
              res.write(toolCallStreamChunks());
            } catch {
              res.write(textStreamChunks('FIXTURE_TOOLROUND_TIMEOUT'));
            }
            res.end('data: [DONE]\n\n');
          })();
        } else if (llmMode === 'steered') {
          const sawSteer = JSON.stringify(body?.messages ?? []).includes('STEER_TEXT_补充指令');
          res.write(textStreamChunks(sawSteer ? 'STEERED_OK_9c2e' : 'STEER_MISS'));
          res.end('data: [DONE]\n\n');
        } else {
          res.write(textStreamChunks('FIXTURE_ACK_7f3a 收到'));
          res.end('data: [DONE]\n\n');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => {
    llmServer!.listen(0, '127.0.0.1', () => {
      llmPort = (llmServer!.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (llmServer) llmServer.close(() => resolve());
    else resolve();
  });
  await new Promise<void>((resolve) => {
    if (internalServer) internalServer.close(() => resolve());
    else resolve();
  });
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

const piAvailable = () => Boolean(runtime?.nodePath && runtime?.piCliPath);

function emptyCwd(): string {
  const dir = path.join(fixtureRoot, 'empty-cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface SpawnOptions {
  withSession?: { sessionDir: string; sessionId: string };
  tools?: string[];
  runKind: 'discuss' | 'work';
  sharedHome?: string;
}

async function spawnFixturePi(options: SpawnOptions): Promise<PiRpcProcess> {
  const { token } = toolService.createRunContext({
    runKind: options.runKind,
    ...(options.withSession ? { sessionId: options.withSession.sessionId } : {}),
    outputRoot: path.join(fixtureRoot, 'out'),
    knowledgeBaseRoot: fixtureRoot,
  });
  const env = buildPiProcessEnv({
    mode: options.sharedHome ? 'pi-agent-dir' : 'app-llm',
    parentEnv: options.sharedHome ? { PATH: process.env.PATH, HOME: fixtureRoot, USERPROFILE: fixtureRoot, SystemRoot: process.env.SystemRoot, PI_CODING_AGENT_DIR: options.sharedHome } : process.env,
    dataRoot: fixtureRoot,
    agentUrl: `http://127.0.0.1:${internalPort}`,
    runToken: token,
    apiKey: SENTINEL_KEY,
  });
  env.FEISHU_SYNC_AGENT_PI_PACKAGE_ROOT = runtime!.piPackageRoot!;
  if (!options.sharedHome) env.FEISHU_SYNC_AGENT_PROVIDER_JSON = JSON.stringify({
    baseUrl: `http://127.0.0.1:${llmPort}/v1`,
    models: [{ id: 'fixture-model', contextWindow: 8192, maxTokens: 1024 }],
  });
  const rpc = new PiRpcProcess({
    nodePath: runtime!.nodePath!,
    piCliPath: runtime!.piCliPath!,
    ...(piExtensionPath() ? { extensionPath: piExtensionPath()! } : {}),
    tools: options.tools ?? [],
    ...(options.withSession ? { sessionDir: options.withSession.sessionDir, sessionId: options.withSession.sessionId } : { noSession: true }),
    model: options.sharedHome ? 'fixture-local/fixture-model' : 'feishu-sync-llm/fixture-model',
    thinking: 'off',
    cwd: emptyCwd(),
    env,
    promptTimeoutMs: 45_000,
  });
  await rpc.start(30_000);
  return rpc;
}

describe('R03：app-llm provider 注入（真实 pi + 本地 OpenAI 兼容 fixture）', () => {
  it('模型额度不足时返回具体原因并隐藏服务商回显的密钥', async (ctx) => {
    if (!piAvailable()) { ctx.skip(); return; }
    llmMode = 'quota';
    const rpc = await spawnFixturePi({ runKind: 'discuss' });
    try {
      await rpc.sendCommand('set_auto_retry', { enabled: false });
      const result = await rpc.prompt('使用合成内容测试额度错误', { timeoutMs: 40000 });
      expect(result.outcome).toBe('failed');
      expect(result.error?.code).toBe('model_quota_exceeded');
      expect(result.error?.message).toContain('余额不足');
      expect(result.error?.message).toContain('1113');
      expect(result.error?.message).not.toContain(SENTINEL_KEY);
    } finally { llmMode = 'text'; await rpc.terminate(); }
  }, TEST_TIMEOUT_MS);
  it('local auth.json credentials reach the selected model without copying or changing shared files', async () => {
    if (!piAvailable()) return;
    const sharedHome = path.join(fixtureRoot, 'shared-local'); fs.mkdirSync(sharedHome);
    const auth = JSON.stringify({ 'fixture-local': { type: 'api_key', key: SENTINEL_KEY } });
    const models = JSON.stringify({ providers: { 'fixture-local': { api: 'openai-completions', baseUrl: `http://127.0.0.1:${llmPort}/v1`, models: [{ id: 'fixture-model', contextWindow: 8192, maxTokens: 1024 }] } } });
    fs.writeFileSync(path.join(sharedHome, 'auth.json'), auth); fs.writeFileSync(path.join(sharedHome, 'models.json'), models);
    llmRequests.length = 0;
    const rpc = await spawnFixturePi({ runKind: 'discuss', sharedHome });
    try {
      const result = await rpc.prompt('Reply with the fixture acknowledgement', { timeoutMs: 40000 });
      expect(result.outcome).toBe('completed');
      expect(result.lastAssistantText).toContain('FIXTURE_ACK_7f3a');
      expect(llmRequests[0].body.model).toBe('fixture-model');
      expect(llmRequests[0].auth).toBe(`Bearer ${SENTINEL_KEY}`);
      expect(fs.readFileSync(path.join(sharedHome, 'auth.json'), 'utf8')).toBe(auth);
      expect(fs.readFileSync(path.join(sharedHome, 'models.json'), 'utf8')).toBe(models);
      const appAuth = path.join(fixtureRoot, 'agent/pi-home/auth.json');
      expect(fs.existsSync(appAuth) ? fs.readFileSync(appAuth, 'utf8') : '').not.toContain(SENTINEL_KEY);
    } finally { await rpc.terminate(); }
  }, TEST_TIMEOUT_MS);

  it('会话选中注册模型，受控请求携带 sentinel key，run token 不进 LLM 请求', async () => {
    if (!piAvailable()) return;
    llmMode = 'text';
    const rpc = await spawnFixturePi({ runKind: 'discuss' });
    const assistantTexts: string[] = [];
    rpc.on('assistant_message_end', (message: unknown) => {
      const content = (message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        assistantTexts.push(content.map((block) =>
          (block && typeof block === 'object' && (block as { type?: string }).type === 'text'
            ? String((block as { text?: string }).text ?? '') : '')).join(''));
      }
    });
    try {
      const outcome = await rpc.prompt('请回复收到', { timeoutMs: 40_000 });
      expect(outcome.outcome).toBe('completed');
      expect(llmRequests.length).toBeGreaterThanOrEqual(1);
      const first = llmRequests[0];
      expect(first.url).toContain('/chat/completions');
      expect(first.auth).toBe(`Bearer ${SENTINEL_KEY}`); // key 只经子 env → SDK header
      expect(JSON.stringify(first.headers)).not.toContain('X-Agent-Run-Token'); // run token 不外发
      expect(assistantTexts.join('')).toContain('FIXTURE_ACK_7f3a'); // 模型输出真往返
    } finally {
      await rpc.terminate();
    }
  }, TEST_TIMEOUT_MS);
});

describe('R04：steer 投递同一活跃 RPC 运行（真实 pi 官方队列语义）', () => {
  it('工具轮挂起时发 steer → 第二轮 messages 含 steer 文本，历史含两条 user', async () => {
    if (!piAvailable()) return;
    llmMode = 'toolround';
    steerSent = false;
    llmRequests.length = 0;
    const sessionDir = path.join(fixtureRoot, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const rpc = await spawnFixturePi({
      runKind: 'work',
      tools: ['kb_search'],
      withSession: { sessionDir, sessionId: 's_fixture_steer' },
    });
    try {
      // 第一轮：模型发 kb_search 工具调用（fixture 挂起等 steer）
      const promptPromise = rpc.prompt('第一轮任务：调用 kb_search 工具', { timeoutMs: 60_000 });
      await waitFor(() => llmRequests.length >= 1, 30_000, '第一轮 LLM 请求');
      // 流式运行中发官方 steer 命令
      const steerResp = await rpc.sendCommand('steer', { message: 'STEER_TEXT_补充指令：完成后回答加 OK' }, 20_000) as { success?: boolean; data?: { disposition?: string } };
      expect(steerResp.success).toBe(true);
      expect(['queued', 'handled']).toContain(String(steerResp.data?.disposition));
      steerSent = true;
      // 工具轮释放后，pi 执行 kb_search（真实内部 API；未发布 → 错误结果，流程继续），
      // 再发第二轮 LLM 请求（此时 steer 已入 messages）
      llmMode = 'steered';
      const outcome = await promptPromise;
      expect(outcome.outcome).toBe('completed');
      // 第二轮请求带上了 steer 文本（同一运行的消息流，非伪造队列）
      const second = llmRequests[1];
      expect(second).toBeTruthy();
      expect(second.auth).toBe(`Bearer ${SENTINEL_KEY}`);
      expect(JSON.stringify(second.body?.messages)).toContain('STEER_TEXT_补充指令');
      expect(JSON.stringify(second.body?.messages)).toContain('call_fix1'); // 工具轮真实执行
      // 历史：两条 user（原始 + steer）都在当前分支
      const state = await rpc.sendCommand('get_state', {}) as { success?: boolean; data?: { sessionFile?: string } };
      expect(state.success).toBe(true);
      const sessionFile = String(state.data?.sessionFile ?? '');
      expect(sessionFile).toBeTruthy();
      const history = parseSessionJsonl(fs.readFileSync(sessionFile, 'utf-8'));
      const userTexts = history.filter((item) => item.role === 'user').map((item) => item.text ?? '');
      expect(userTexts.some((text) => text.includes('第一轮任务'))).toBe(true);
      expect(userTexts.some((text) => text.includes('STEER_TEXT_补充指令'))).toBe(true);
    } finally {
      await rpc.terminate();
    }
  }, TEST_TIMEOUT_MS);
});
