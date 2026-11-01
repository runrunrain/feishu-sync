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
import nodeHttp from 'node:http';
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

// ------------------------------------------------------------------
// F02（审核修复）：同连接受控工具面刷新（notifications/tools/list_changed）
// 反例（复现于 /tmp/feishu-build-v2-review/mcp-cache-probe.mjs）：桥首次
// tools/list 早于原生创建事件 → pending 只读面被 Pi/amagi 缓存，同连接永不刷新，
// 写工具“尚未连接/已隐藏”。修复后桥声明 tools.listChanged 并在面变化时发送标准
// 通知；逐次业务授权仍由服务端裁决（撤销后调用仍拒）。观测有界/一次性/可清理。
// ------------------------------------------------------------------

describe('claude-bridge.cjs F02 同连接受控刷新（§3.3 + MCP tools/list_changed）', () => {
  /** 帧感知桥接句柄：响应与通知分流（旧 next() FIFO 会被通知帧干扰）。 */
  function startFrameBridge(env: NodeJS.ProcessEnv, onExit?: (code: number | null) => void) {
    const proc = spawn(process.execPath, [path.resolve('src/agent/claude-bridge.cjs')], { env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    procs.push(proc as unknown as ChildProcessWithoutNullStreams);
    const stderrTail: string[] = [];
    proc.stderr.on('data', (chunk: Buffer) => { stderrTail.push(chunk.toString('utf-8')); if (stderrTail.length > 20) stderrTail.shift(); });
    const frames: Record<string, unknown>[] = [];
    const waiters: Array<{ predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }>[] = [];
    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) {
          try {
            const frame = JSON.parse(line) as Record<string, unknown>;
            frames.push(frame);
            for (let i = waiters.length - 1; i >= 0; i -= 1) {
              if (waiters[i].predicate(frame)) {
                const { resolve } = waiters[i];
                waiters.splice(i, 1);
                resolve(frame);
              }
            }
          } catch { /* 非 JSON 行忽略 */ }
        }
        index = buffer.indexOf('\n');
      }
    });
    if (onExit) proc.on('exit', onExit);
    return {
      proc,
      frames,
      send: (message: unknown) => { proc.stdin.write(`${JSON.stringify(message)}\n`); },
      waitFor: (predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 5000) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const existing = frames.find(predicate);
          if (existing) { resolve(existing); return; }
          waiters.push({ predicate, resolve });
          setTimeout(() => reject(new Error(`等待桥接帧超时（已收帧：${JSON.stringify(frames.map((frame) => ({ id: frame.id ?? null, method: frame.method ?? null })))}；桥 stderr 尾部：${stderrTail.join('').slice(-400)}；桥存活：${proc.exitCode === null}`)), timeoutMs);
        }),
      responseOf: (id: number) => frames.find((frame) => frame.id === id),
    };
  }

  const fastWatchEnv = {
    FEISHU_SYNC_BRIDGE_SURFACE_WATCH_INTERVAL_MS: '80',
    FEISHU_SYNC_BRIDGE_SURFACE_WATCH_DEADLINE_MS: '1500',
  };

  it('pending→confirmed 同连接刷新：list_changed 通知后写工具可见可写，撤销仍拒（真实服务全链）', async () => {
    // 新身份 task-late：首次清单时无创建事件（pending 只读面）
    const bridge = startFrameBridge(bridgeEnv({
      AMAGI_TASK_ID: 'task-late',
      AMAGI_AGENT: 'luban',
      ...fastWatchEnv,
    }));
    try {
      bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
      const init = await bridge.waitFor((frame) => frame.id === 1) as { result?: { capabilities?: { tools?: { listChanged?: boolean } } } };
      expect(init.result?.capabilities?.tools?.listChanged).toBe(true); // 声明变更能力（MCP 标准）
      bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const pendingList = await bridge.waitFor((frame) => frame.id === 2) as { result?: { tools?: Array<{ name: string }> } };
      const pendingNames = pendingList.result!.tools!.map((tool) => tool.name);
      expect(pendingNames).toContain('raw_read');
      expect(pendingNames).not.toContain('kb_write_doc'); // 反例起点：pending 只读面

      // 创建事件到达（真实集成者动作）：同连接不重开，等桥的变更通知
      store.registerTaskCreation({ nativeTaskId: 'task-late', requestedRole: 'luban' });
      store.assignOutputs({ targets: ['combat/f02.md'], ownerTaskId: 'task-late' });
      const notification = await bridge.waitFor((frame) => frame.method === 'notifications/tools/list_changed', 4000);
      expect(notification.method).toBe('notifications/tools/list_changed');

      bridge.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
      const confirmedList = await bridge.waitFor((frame) => frame.id === 3) as { result?: { tools?: Array<{ name: string }> } };
      const confirmedNames = confirmedList.result!.tools!.map((tool) => tool.name);
      expect(confirmedNames).toContain('kb_write_doc'); // F02 关闭：同一连接发现写工具

      // 写工具真实可用（受分配保护的服务端裁决链）
      bridge.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'kb_write_doc', arguments: { path: 'combat/f02.md', title: 'F02', markdown: '# f02\n同连接刷新后写入。', sources: ['tokA'], summary: 'f02', operationId: 'op-f02' } } });
      const write = await bridge.waitFor((frame) => frame.id === 4) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
      expect(write.result?.isError).toBeFalsy();
      expect(fs.readFileSync(path.join(state.stagingRoot, 'docs', 'combat', 'f02.md'), 'utf-8')).toContain('同连接刷新后写入');

      // 撤销仍拒：面已可见但服务端逐次授权拒绝（不是靠隐藏工具兜底）
      store.revokeActor('task-late', 'f02-test-revoke');
      bridge.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'kb_write_doc', arguments: { path: 'combat/f02.md', title: 'F02', markdown: '# f02-2', sources: ['tokA'], summary: 'f02', operationId: 'op-f02-2' } } });
      const revoked = await bridge.waitFor((frame) => frame.id === 5) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
      expect(revoked.result?.isError).toBe(true);
      expect(revoked.result?.content?.[0]?.text).toContain('actor_revoked');

      // 通知由服务端真实面变化驱动：本次会话恰两次——pending→confirmed 扩面、
      // 撤销后缩面（面回只读；逐次授权已在上一断言证明仍拒）。无面变化则零通知。
      await new Promise((resolve) => setTimeout(resolve, 400));
      const listChangedCount = bridge.frames.filter((frame) => frame.method === 'notifications/tools/list_changed').length;
      expect(listChangedCount).toBe(2);
    } finally {
      bridge.proc.stdin.end();
    }
  }, 15_000);

  it('两段观测生命周期：快窗到期转低频退避（不自停）、401 即永久终止、无身份不观测、stdin 关闭即退', async () => {
    // 计数 fixture 服务（仅本测试）：面恒定不变；可切 401（令牌失效路径）
    let lists = 0;
    let tokenDead = false;
    const counter = nodeHttp.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/agent-internal/tools') {
        lists += 1;
        if (tokenDead) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'run_token_invalid', message: '运行令牌无效或已过期' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ name: 'raw_read', description: 'raw_read', parameters: { type: 'object' } }]));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }));
    });
    await new Promise<void>((resolve) => { counter.listen(0, '127.0.0.1', resolve); });
    const port2 = (counter.address() as { port: number }).port;
    const baseEnv = (extra: NodeJS.ProcessEnv) => ({
      PATH: process.env.PATH,
      FEISHU_SYNC_AGENT_URL: `http://127.0.0.1:${port2}`,
      FEISHU_SYNC_AGENT_RUN_TOKEN: 'fixture-token',
      // 快窗 60ms×240ms；低频基频 150ms（倍增至 8×=1200ms 上限）——测试不实际等 30s
      FEISHU_SYNC_BRIDGE_SURFACE_WATCH_INTERVAL_MS: '60',
      FEISHU_SYNC_BRIDGE_SURFACE_WATCH_DEADLINE_MS: '240',
      FEISHU_SYNC_BRIDGE_SURFACE_WATCH_LOW_MS: '150',
      ...extra,
    });
    try {
      // A. 有身份 + 面不变：快窗到期后【不停】——转入低频退避段继续观测
      // （迟到确认仍可刷新）；观测率受退避约束，不常驻高频轮询。
      let exitCode: number | null = null;
      const bridge = startFrameBridge(baseEnv({ AMAGI_TASK_ID: 'task-bound', AMAGI_AGENT: 'luban' }), (code) => { exitCode = code; });
      bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await bridge.waitFor((frame) => frame.id === 1);
      bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      await bridge.waitFor((frame) => frame.id === 2);
      await new Promise((resolve) => setTimeout(resolve, 700)); // 跨过快窗(240ms)，处于低频段
      const first = lists;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const growth = lists - first;
      expect(growth).toBeGreaterThanOrEqual(1); // 低频段仍在观测（迟到确认可刷新）
      // 低频退避约束：500ms 窗口内新增 ≤ ceil(500/150)+1=5（基频上界；实际因倍增更少）
      expect(growth).toBeLessThanOrEqual(5);
      expect(bridge.frames.some((frame) => frame.method === 'notifications/tools/list_changed')).toBe(false); // 面未变不发通知
      bridge.proc.stdin.end(); // 清理：低频段中 stdin 关闭即退（unref 定时器不阻退出）
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('桥接进程未随 stdin 关闭退出（疑似定时器残留）')), 3000);
        bridge.proc.on('exit', () => { clearTimeout(timer); resolve(); });
      });
      expect(exitCode).toBe(0);

      // B. 令牌失效（401 run_token_invalid）：观测随 token 生命周期永久终止
      const bridgeAuth = startFrameBridge(baseEnv({ AMAGI_TASK_ID: 'task-auth', AMAGI_AGENT: 'luban' }));
      bridgeAuth.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await bridgeAuth.waitFor((frame) => frame.id === 1);
      bridgeAuth.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      await bridgeAuth.waitFor((frame) => frame.id === 2);
      await new Promise((resolve) => setTimeout(resolve, 150)); // 快窗中若干次观测
      tokenDead = true; // 令牌失效
      await new Promise((resolve) => setTimeout(resolve, 500)); // 观测遇到 401 → 永久停止
      const authSample = lists;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(lists).toBe(authSample); // 已死：不再轮询
      bridgeAuth.proc.stdin.end();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('401 后桥未退出')), 3000);
        bridgeAuth.proc.on('exit', () => { clearTimeout(timer); resolve(); });
      });
      tokenDead = false;

      // C. 无受信身份（Claude 会话面）：不启动面观测
      let listsNoIdentity = 0;
      const counter2 = nodeHttp.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/api/agent-internal/tools') {
          listsNoIdentity += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        res.writeHead(200).end('{}');
      });
      await new Promise<void>((resolve) => { counter2.listen(0, '127.0.0.1', resolve); });
      const port3 = (counter2.address() as { port: number }).port;
      const bridge2 = startFrameBridge({
        PATH: process.env.PATH,
        FEISHU_SYNC_AGENT_URL: `http://127.0.0.1:${port3}`,
        FEISHU_SYNC_AGENT_RUN_TOKEN: 'fixture-token',
      });
      bridge2.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      await bridge2.waitFor((frame) => frame.id === 1);
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(listsNoIdentity).toBe(1); // 仅显式 tools/list，无背景观测
      bridge2.proc.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 3000);
        bridge2.proc.on('exit', () => clearTimeout(timer));
        bridge2.proc.on('exit', resolve);
      });
      await new Promise<void>((resolve) => { counter2.close(() => resolve()); counter2.closeAllConnections?.(); });
    } finally {
      await new Promise<void>((resolve) => { counter.close(() => resolve()); counter.closeAllConnections?.(); });
    }
  }, 15_000);

  it('迟到确认（快窗到期、低频转段后 confirmed）同连接仍刷新：通知→写工具可见可写，逐次授权不变', async () => {
    // Leader steer 回归：缩短观测窗口后跨过快窗，在低频段才确认身份——
    // 不得因快窗停止而永久缓存只读（原生客户端无自愈重连）。
    const bridge = startFrameBridge(bridgeEnv({
      AMAGI_TASK_ID: 'task-late-low',
      AMAGI_AGENT: 'luban',
      FEISHU_SYNC_BRIDGE_SURFACE_WATCH_INTERVAL_MS: '60',
      FEISHU_SYNC_BRIDGE_SURFACE_WATCH_DEADLINE_MS: '240',
      FEISHU_SYNC_BRIDGE_SURFACE_WATCH_LOW_MS: '100',
    }));
    try {
      bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await bridge.waitFor((frame) => frame.id === 1);
      bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const pendingList = await bridge.waitFor((frame) => frame.id === 2) as { result?: { tools?: Array<{ name: string }> } };
      expect(pendingList.result!.tools!.map((tool) => tool.name)).not.toContain('kb_write_doc'); // 反例起点
      // 跨过快窗（240ms），确认落在低频段（低频基频 100ms，倍增上界 800ms）
      await new Promise((resolve) => setTimeout(resolve, 420));
      store.registerTaskCreation({ nativeTaskId: 'task-late-low', requestedRole: 'luban' });
      store.assignOutputs({ targets: ['combat/f02-late.md'], ownerTaskId: 'task-late-low' });
      const notification = await bridge.waitFor((frame) => frame.method === 'notifications/tools/list_changed', 3500);
      expect(notification.method).toBe('notifications/tools/list_changed');
      bridge.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
      const confirmed = await bridge.waitFor((frame) => frame.id === 3) as { result?: { tools?: Array<{ name: string }> } };
      expect(confirmed.result!.tools!.map((tool) => tool.name)).toContain('kb_write_doc'); // 迟到确认后同连接可见
      bridge.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'kb_write_doc', arguments: { path: 'combat/f02-late.md', title: 'F02迟到', markdown: '# f02-late\n迟到确认后写入。', sources: ['tokA'], summary: 'f02', operationId: 'op-f02-late' } } });
      const write = await bridge.waitFor((frame) => frame.id === 4) as { result?: { isError?: boolean } };
      expect(write.result?.isError).toBeFalsy();
      expect(fs.readFileSync(path.join(state.stagingRoot, 'docs', 'combat', 'f02-late.md'), 'utf-8')).toContain('迟到确认后写入');
      // 逐次授权不变：撤销后同工具调用仍拒
      store.revokeActor('task-late-low', 'f02-late-test-revoke');
      bridge.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'kb_write_doc', arguments: { path: 'combat/f02-late.md', title: 'F02迟到', markdown: '# f02-late-2', sources: ['tokA'], summary: 'f02', operationId: 'op-f02-late-2' } } });
      const revoked = await bridge.waitFor((frame) => frame.id === 5) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
      expect(revoked.result?.isError).toBe(true);
      expect(revoked.result?.content?.[0]?.text).toContain('actor_revoked');
      // 通知由服务端真实面变化驱动：迟到确认扩面 + 撤销缩面，恰两次（非常驻/定时播报）
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(bridge.frames.filter((frame) => frame.method === 'notifications/tools/list_changed').length).toBe(2);
    } finally {
      bridge.proc.stdin.end();
    }
  }, 15_000);
});
