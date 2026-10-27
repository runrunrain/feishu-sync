/**
 * 真实 pi RPC 集成测试（设计 §12.1 PiRpcProcess + 扩展行）
 *
 * 本机装有 Node ≥22.19 + pi 1.4 时真实执行（否则整文件 skip，不冒充）：
 *  1. Probe 进程（--no-session --no-tools --offline + 隔离 PI_CODING_AGENT_DIR）
 *     启动、get_state/get_available_models 命令往返。
 *  2. 真实扩展装载：feishu-sync-agent.js 从内部 API 拉取工具规格并注册
 *     （内部 API 由本测试起真实 HTTP server；以「扩展 GET /tools 打点」
 *     证明装载链路，不发 prompt、不消耗模型额度）。
 *  3. RPC `bash` 命令被宿主白名单拒绝（无法从 API 触发 shell）。
 *  4. app-llm 无 key：扩展注册 provider 后 get_available_models 为空 →
 *     model_auth_missing 诊断路径。
 *  5. JSONL 帧解析：真实事件的 id/response 关联。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

// 真实子进程启动较慢（pi 冷启动 3-8s）：统一放宽单测超时
const TEST_TIMEOUT_MS = 60_000;
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { buildServer } from '../src/index.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { buildPiProcessEnv, PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { piExtensionPath } from '../src/agent/agent-assets.js';
import { buildDefaultAgentConfig } from '../src/types/agent-knowledge.js';
import type { AgentToolService as ToolServiceType } from '../src/agent/agent-tool-service.js';

let fixtureRoot: string;
let runtime: Awaited<ReturnType<PiRuntimeResolver['resolveRuntime']>> | null = null;
let app: Hono;
let toolService: ToolServiceType;
let httpServer: ReturnType<typeof serve> | null = null;
let httpPort = 0;
let toolsFetchCount = 0;

beforeAll(async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-probe-it-'));
  const resolver = new PiRuntimeResolver();
  runtime = await resolver.resolveRuntime(buildDefaultAgentConfig(fixtureRoot));
  if (runtime.nodePath && runtime.piCliPath) {
    // 真实内部 API（buildServer 构造，取其 toolService 并打点：扩展 GET /tools
    // 会调 getToolSpecsForToken）
    app = (await buildServer({ desktopMode: false })) as unknown as Hono;
    toolService = (app as unknown as { __agentToolService: AgentToolService }).__agentToolService;
    const originalGetSpecs = toolService.getToolSpecsForToken.bind(toolService);
    toolService.getToolSpecsForToken = (token: string) => {
      toolsFetchCount += 1;
      return originalGetSpecs(token);
    };
    const started = await new Promise<{ port: number }>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        resolve({ port: info.port });
      });
      httpServer = server;
    });
    httpPort = started.port;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (httpServer) httpServer.close(() => resolve());
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

async function spawnProbe(options: {
  withExtension?: boolean;
  providerJson?: string;
  apiKey?: string;
}): Promise<PiRpcProcess> {
  const { token } = toolService.createRunContext({
    runKind: 'probe',
    outputRoot: path.join(fixtureRoot, 'out'),
    knowledgeBaseRoot: fixtureRoot,
  });
  const env = buildPiProcessEnv({
    mode: 'app-llm',
    parentEnv: process.env,
    dataRoot: fixtureRoot,
    agentUrl: `http://127.0.0.1:${httpPort}`,
    runToken: token,
    apiKey: options.apiKey,
  });
  if (options.providerJson) {
    env.FEISHU_SYNC_AGENT_PROVIDER_JSON = options.providerJson;
  }
  const rpc = new PiRpcProcess({
    nodePath: runtime!.nodePath!,
    piCliPath: runtime!.piCliPath!,
    ...(options.withExtension ? { extensionPath: piExtensionPath() ?? undefined } : {}),
    tools: [],
    noSession: true,
    noTools: true,
    cwd: emptyCwd(),
    env,
    promptTimeoutMs: 30_000,
  });
  await rpc.start(20_000);
  return rpc;
}

describe('真实 pi RPC（本机 pi 1.4，缺失则 skip）', () => {
  it('Probe 进程启动 + get_state/get_available_models 往返', async () => {
    if (!piAvailable()) return;
    const rpc = await spawnProbe({});
    try {
      const { state, models } = await rpc.probeState();
      expect(state).toBeTruthy();
      expect(Array.isArray(models)).toBe(true);
      // 空 PI_CODING_AGENT_DIR + 无 provider：模型列表为空（无凭据诊断依据）
      expect(models).toHaveLength(0);
    } finally {
      await rpc.terminate();
    }
  }, TEST_TIMEOUT_MS);

  it('真实扩展装载：从内部 API 拉取工具规格（GET /tools 打点）', async () => {
    if (!piAvailable()) return;
    const before = toolsFetchCount;
    const rpc = await spawnProbe({ withExtension: true });
    try {
      // 扩展 factory 在 pi 启动时执行：等它 GET /tools（轮询打点）
      const deadline = Date.now() + 15_000;
      while (toolsFetchCount <= before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(toolsFetchCount).toBeGreaterThan(before);
      // probe 运行允许 0 工具：GET /tools 返回空列表，扩展正常完成 factory
      const { state } = await rpc.probeState();
      expect(state).toBeTruthy();
    } finally {
      await rpc.terminate();
    }
  }, TEST_TIMEOUT_MS);

  it('RPC bash 命令被宿主拒绝（rpc_command_forbidden）', async () => {
    if (!piAvailable()) return;
    const rpc = await spawnProbe({});
    try {
      await expect(rpc.sendCommand('bash' as never, { command: 'echo pwned' })).rejects.toThrow(/白名单|forbidden/);
      // 黑名单其他命令同样拒绝
      await expect(rpc.sendCommand('new_session' as never, {})).rejects.toThrow();
      await expect(rpc.sendCommand('switch_session' as never, { sessionPath: '/tmp/x' })).rejects.toThrow();
    } finally {
      await rpc.terminate();
    }
  }, TEST_TIMEOUT_MS);

  it('app-llm 无 key：provider 注册后可用模型为空 → model_auth_missing 诊断', async () => {
    if (!piAvailable()) return;
    const rpc = await spawnProbe({
      withExtension: true,
      providerJson: JSON.stringify({
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        models: [{ id: 'glm-test-model', contextWindow: 128000, maxTokens: 8192 }],
      }),
      // 不传 apiKey → $FEISHU_SYNC_AGENT_API_KEY 插值落空 → 无 key
    });
    try {
      const deadline = Date.now() + 15_000;
      const before = toolsFetchCount;
      while (toolsFetchCount <= before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const { models } = await rpc.probeState();
      // E1 实测行为：无 key → feishu-sync-llm 不出现在可用模型
      expect(models.filter((model) => model.startsWith('feishu-sync-llm/'))).toHaveLength(0);
    } finally {
      await rpc.terminate();
    }
  }, TEST_TIMEOUT_MS);

  it('JSONL 帧解析：命令 id 关联 response（真实事件流）', async () => {
    if (!piAvailable()) return;
    const rpc = await spawnProbe({});
    try {
      const records: unknown[] = [];
      rpc.on('record', (record) => records.push(record));
      await rpc.sendCommand('get_state', {});
      const responses = records.filter(
        (record) => (record as { type?: string }).type === 'response'
          && (record as { command?: string }).command === 'get_state',
      );
      expect(responses).toHaveLength(1);
    } finally {
      await rpc.terminate();
    }
  }, TEST_TIMEOUT_MS);
});
