/**
 * build-runtime-bridge.test.ts — v2 桥接与内部 API（设计 v2 §3.3/§4.1/§10）
 *
 * 覆盖：
 * - agent-internal 路由：X-Amagi-Task-Id/X-Amagi-Agent 头 → meta（身份链
 *   生效）；GET /tools 按身份下发子集并附 annotations.readOnlyHint；
 * - claude-bridge.cjs 子进程（stdio JSON-RPC）：受信 env 身份头透传、
 *   tools/list annotations、tools/call _meta['claudecode/toolUseId'] 透传、
 *   无 _meta 时 cc_ 回退（Claude 旧用法）、新构建变量
 *   FEISHU_SYNC_BUILD_MCP_URL/TOKEN 优先于旧变量。
 *
 * 模式：真实 HTTP 回环（@hono/node-server）+ node 子进程，不依赖 SQLite。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { AgentToolService, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { agentInternalRoutes } from '../src/routes/agent-internal.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { BuildActorStore, V2_CHILD_ALL_TOOLS } from '../src/kb/build-actors.js';
import { V2_LEADER_TOOLS } from '../src/agent/tool-specs.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let service: AgentToolService;
let store: BuildActorStore;
let state: BuildRunState;
let childToken: string;
let leaderToken: string;
let app: Hono;
let server: ServerType;
let port: number;
const procs: ChildProcessWithoutNullStreams[] = [];

const writeRaw = (rel: string, content: string): string => {
  const target = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
  return target;
};

beforeAll(async () => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bridge-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bridge-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-bridge-out-'));
  fs.mkdirSync(path.join(outputRoot, 'releases'), { recursive: true });
  writeRaw('src-a.md', '# 源A\n\n桥接测试内容，稳定锚点。\n');
  const entry: RawSourceSnapshotEntry = {
    objToken: 'tokA',
    objType: 'docx',
    title: 'src-a.md',
    relPath: 'src-a.md',
    contentHash: computeSourceHash(path.join(kbRoot, 'src-a.md'), [], kbRoot),
    objEditTime: null,
  };
  const stagingRoot = path.join(dataRoot, 'staging', 'b-bridge');
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  store = new BuildActorStore({ buildId: 'b-bridge', stagingRoot, generation: 1 });
  state = {
    knowledgeBaseRoot: kbRoot,
    snapshot: RawSourceSnapshot.fromEntries([entry], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] }),
    mode: 'incremental',
    workset: new Map([['tokA', 'added']]),
    stagingRoot,
    finishInfo: null,
    docMeta: new Map(),
    v2: { actorStore: store, generation: 1 },
  };
  service = new AgentToolService({ dataRoot, documentsProvider: () => [] });
  const orchestration = { mode: 'pi-amagi' as const, buildId: 'b-bridge', generation: 1, actorStore: store };
  childToken = service.createRunContext({
    runKind: 'build', buildId: 'b-bridge', outputRoot, knowledgeBaseRoot: kbRoot, buildState: state,
    allowedToolsOverride: V2_CHILD_ALL_TOOLS,
    orchestration: { ...orchestration, credential: 'child' as const },
  }).token;
  leaderToken = service.createRunContext({
    runKind: 'build', buildId: 'b-bridge', outputRoot, knowledgeBaseRoot: kbRoot, buildState: state,
    allowedToolsOverride: [...V2_LEADER_TOOLS],
    orchestration: { ...orchestration, credential: 'leader' as const },
  }).token;
  app = new Hono();
  app.route('/', agentInternalRoutes(service));
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => {
    server.on('listening', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
      resolve();
    });
  });
  // 桥接身份：登记一个 confirmed writer + 一个 pending（无创建事件）
  store.registerTaskCreation({ nativeTaskId: 'task-w1', requestedRole: 'luban' });
  store.ensurePendingIdentity('task-early', 'luban');
});
afterAll(async () => {
  for (const proc of procs) proc.kill('SIGKILL');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kbRoot, { recursive: true, force: true });
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

// ------------------------------------------------------------------
// HTTP 直连（内部 API 身份头）
// ------------------------------------------------------------------

async function http(
  method: 'GET' | 'POST',
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', Host: '127.0.0.1', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

describe('内部 API 身份头（§4.1）', () => {
  it('GET /tools 按身份下发子集；读取类附 annotations.readOnlyHint，写入类不带', async () => {
    const confirmed = await http('GET', '/api/agent-internal/tools', undefined, {
      'X-Agent-Run-Token': childToken,
      'X-Amagi-Task-Id': 'task-w1',
      'X-Amagi-Agent': 'luban',
    });
    expect(confirmed.status).toBe(200);
    const names = confirmed.json.map((spec: { name: string }) => spec.name);
    expect(names).toContain('kb_write_doc');
    expect(names).not.toContain('kb_submit_review');
    const writeSpec = confirmed.json.find((spec: { name: string }) => spec.name === 'kb_write_doc');
    expect(writeSpec.annotations).toBeUndefined();
    const readSpec = confirmed.json.find((spec: { name: string }) => spec.name === 'raw_read');
    expect(readSpec.annotations).toEqual({ readOnlyHint: true });

    const pending = await http('GET', '/api/agent-internal/tools', undefined, {
      'X-Agent-Run-Token': childToken,
      'X-Amagi-Task-Id': 'task-early',
      'X-Amagi-Agent': 'luban',
    });
    const pendingNames = pending.json.map((spec: { name: string }) => spec.name);
    expect(pendingNames).toContain('raw_read');
    expect(pendingNames).not.toContain('kb_write_doc');
  });

  it('POST /tools/:name 身份头 → meta：pending 写入 403 actor_pending；confirmed 未分配 409', async () => {
    const pending = await http('POST', '/api/agent-internal/tools/kb_write_doc', {
      args: { path: 'docs/x.md', title: 't', markdown: 'm', sources: ['tokA'], summary: 's', operationId: 'op1' },
    }, { 'X-Agent-Run-Token': childToken, 'X-Amagi-Task-Id': 'task-early', 'X-Amagi-Agent': 'luban' });
    expect(pending.status).toBe(403);
    expect(pending.json.error).toBe('actor_pending');

    const unassigned = await http('POST', '/api/agent-internal/tools/kb_write_doc', {
      args: { path: 'docs/y.md', title: 't', markdown: 'm', sources: ['tokA'], summary: 's', operationId: 'op2' },
    }, { 'X-Agent-Run-Token': childToken, 'X-Amagi-Task-Id': 'task-w1', 'X-Amagi-Agent': 'luban' });
    expect(unassigned.status).toBe(409);
    expect(unassigned.json.error).toBe('kb_output_not_assigned');
  });

  it('Leader 头无效时 token 仍按凭据类别限定（leader 调正文写工具被拒）', async () => {
    const denied = await http('POST', '/api/agent-internal/tools/kb_write_doc', {
      args: { path: 'docs/z.md', title: 't', markdown: 'm', sources: ['tokA'], summary: 's' },
    }, { 'X-Agent-Run-Token': leaderToken });
    expect(denied.status).toBe(403);
    expect(denied.json.error).toBe('tool_not_allowed');
  });
});

// ------------------------------------------------------------------
// claude-bridge.cjs 子进程（stdio JSON-RPC）
// ------------------------------------------------------------------

interface BridgeHandle {
  send: (message: unknown) => void;
  next: () => Promise<Record<string, unknown>>;
  kill: () => void;
}

function startBridge(env: NodeJS.ProcessEnv): BridgeHandle {
  const proc = spawn(process.execPath, [path.resolve('src/agent/claude-bridge.cjs')], {
    env: { ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  procs.push(proc as unknown as ChildProcessWithoutNullStreams);
  const pending: Array<(value: Record<string, unknown>) => void> = [];
  let buffer = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        try {
          const resolved = pending.shift();
          resolved?.(JSON.parse(line));
        } catch { /* 非 JSON 行忽略 */ }
      }
      index = buffer.indexOf('\n');
    }
  });
  return {
    send: (message) => proc.stdin.write(`${JSON.stringify(message)}\n`),
    next: () => new Promise((resolve, reject) => {
      pending.push(resolve as (value: Record<string, unknown>) => void);
      setTimeout(() => reject(new Error('桥接响应超时')), 5000);
    }),
    kill: () => proc.kill(),
  };
}

const bridgeEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  FEISHU_SYNC_AGENT_URL: `http://127.0.0.1:${port}`,
  FEISHU_SYNC_AGENT_RUN_TOKEN: childToken,
  ...extra,
});

describe('claude-bridge.cjs（§3.3/§10）', () => {
  it('AMAGI env → 身份头透传：tools/list 按角色下发并带 readOnlyHint；tools/call 走身份链', async () => {
    const bridge = startBridge(bridgeEnv({ AMAGI_TASK_ID: 'task-w1', AMAGI_AGENT: 'luban' }));
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    const init = await bridge.next();
    expect((init as { result?: { serverInfo?: { name?: string } } }).result?.serverInfo?.name).toBe('feishu-sync');
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await bridge.next();
    const tools = (list as { result?: { tools?: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> } }).result!.tools!;
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('kb_write_doc');
    expect(names).toContain('kb_edit_doc');
    expect(names).not.toContain('build_manifest');
    const readTool = tools.find((tool) => tool.name === 'raw_read')!;
    expect(readTool.annotations).toEqual({ readOnlyHint: true });
    const writeTool = tools.find((tool) => tool.name === 'kb_write_doc')!;
    expect(writeTool.annotations).toBeUndefined();
    // tools/call：受信身份生效（未分配路径 → kb_output_not_assigned，证明
    // 服务端按 X-Amagi-Task-Id 解析到了 task-w1 的 confirmed 身份）
    bridge.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kb_write_doc', arguments: { path: 'docs/bridge.md', title: 't', markdown: 'm', sources: ['tokA'], summary: 's', operationId: 'op-b1' } } });
    const call = await bridge.next();
    const callResult = (call as { result?: { isError?: boolean; content?: Array<{ text: string }> } }).result!;
    expect(callResult.isError).toBe(true);
    expect(callResult.content![0]!.text).toContain('kb_output_not_assigned');
    bridge.kill();
  });

  it('pending 身份（AMAGI_TASK_ID=task-early）→ 只读清单；写调用被拒', async () => {
    const bridge = startBridge(bridgeEnv({ AMAGI_TASK_ID: 'task-early', AMAGI_AGENT: 'luban' }));
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const list = await bridge.next();
    const tools = (list as { result?: { tools?: Array<{ name: string }> } }).result!.tools!;
    expect(tools.map((tool) => tool.name)).not.toContain('kb_write_doc');
    bridge.kill();
  });

  it('_meta[claudecode/toolUseId] 透传为 toolCallId；无 _meta 保持 cc_ 回退', async () => {
    // 用 read-receipts 验证 toolCallId 透传：raw_read 的回执记录 toolCallId
    const bridge = startBridge(bridgeEnv({ AMAGI_TASK_ID: 'task-w1', AMAGI_AGENT: 'luban' }));
    bridge.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'raw_read', arguments: { objToken: 'tokA', limit: 2 }, _meta: { 'claudecode/toolUseId': 'toolu_claude_abc123' } } });
    const call = await bridge.next();
    const callResult = (call as { result?: { isError?: boolean } }).result!;
    expect(callResult.isError).toBeFalsy();
    bridge.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'raw_read', arguments: { objToken: 'tokA', limit: 2 } } });
    await bridge.next();
    const receipts = fs.readFileSync(path.join(state.stagingRoot, 'read-receipts.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(receipts.some((receipt) => receipt.toolCallId === 'toolu_claude_abc123')).toBe(true);
    expect(receipts.some((receipt) => receipt.toolCallId.startsWith('cc_'))).toBe(true);
    bridge.kill();
  });

  it('新构建变量 FEISHU_SYNC_BUILD_MCP_URL/TOKEN 优先于旧变量', async () => {
    const bridge = startBridge({
      PATH: process.env.PATH,
      FEISHU_SYNC_AGENT_URL: 'http://127.0.0.1:1', // 旧变量指向无效端口
      FEISHU_SYNC_AGENT_RUN_TOKEN: 'stale-token',
      FEISHU_SYNC_BUILD_MCP_URL: `http://127.0.0.1:${port}`,
      FEISHU_SYNC_BUILD_MCP_TOKEN: childToken,
      AMAGI_TASK_ID: 'task-w1',
      AMAGI_AGENT: 'luban',
    });
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const list = await bridge.next();
    const tools = (list as { result?: { tools?: Array<{ name: string }> } }).result!.tools!;
    expect(tools.length).toBeGreaterThan(0);
    bridge.kill();
  });

  it('无 AMAGI env（v2 凭据误配）：清单为空、调用被拒（受信身份必须存在）', async () => {
    const bridge = startBridge(bridgeEnv());
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const list = await bridge.next();
    const tools = (list as { result?: { tools?: Array<{ name: string }> } }).result!.tools!;
    expect(tools).toEqual([]);
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'raw_search', arguments: { query: '稳定锚点' } } });
    const call = await bridge.next();
    const callResult = (call as { result?: { isError?: boolean; content?: Array<{ text: string }> } }).result!;
    expect(callResult.isError).toBe(true);
    expect(callResult.content![0]!.text).toContain('amagi_task_missing');
    bridge.kill();
  });
});
