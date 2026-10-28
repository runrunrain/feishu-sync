/**
 * SessionService 单元测试（设计 §7.6 / §9.3）
 *
 * - pi 会话 JSONL v3 树解析：沿 parentId 回溯当前分支、未知 entry 跳过
 * - SSE 环形缓冲 + Last-Event-ID 续传 + resync
 * - 会话 CRUD/模式切换校验（confirm WORK、workspace 校验、运行中拒绝）
 * 全部用内存 store stub，不触真实 DB 与进程。
 */

import { describe, expect, it, afterAll } from 'vitest';
import { Hono } from 'hono';
import { agentRoutes, type AgentRouteDeps } from '../src/routes/agent.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionService, parseSessionJsonl, toAssistantMessageDto } from '../src/agent/session-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import type { SessionStoreApi } from '../src/agent/session-service.js';
import type { Config } from '../src/types/index.js';

function makeStore(): SessionStoreApi & {
  rows: Map<string, Record<string, unknown>>;
} {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    getAgentSession: (id: string) => (rows.get(id) ? { ...rows.get(id)! } : null),
    createAgentSession: (input: { id: string; title: string; mode: string; workspaceId: string | null; createdAt: string; updatedAt: string }) => {
      rows.set(input.id, {
        id: input.id, title: input.title, mode: input.mode, workspace_id: input.workspaceId,
        pi_session_file: null, last_error_code: null, last_error_message: null,
        created_at: input.createdAt, updated_at: input.updatedAt, deleted_at: null,
      });
    },
    listAgentSessions: () => [...rows.values()].filter((row) => !row.deleted_at),
    updateAgentSession: (id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id);
      if (!row) throw new Error(`agent_session 不存在: ${id}`);
      // 与真实 LocalMapStore 同语义：驼峰 patch → 蛇形列
      const mapped: Record<string, unknown> = {};
      if ('title' in patch) mapped.title = patch.title;
      if ('mode' in patch) mapped.mode = patch.mode;
      if ('workspaceId' in patch) mapped.workspace_id = patch.workspaceId;
      if ('piSessionFile' in patch) mapped.pi_session_file = patch.piSessionFile;
      if ('lastErrorCode' in patch) mapped.last_error_code = patch.lastErrorCode;
      if ('lastErrorMessage' in patch) mapped.last_error_message = patch.lastErrorMessage;
      if ('updatedAt' in patch) mapped.updated_at = patch.updatedAt;
      if ('deletedAt' in patch) mapped.deleted_at = patch.deletedAt;
      rows.set(id, { ...row, ...mapped });
    },
    listSessionsByWorkspace: (workspaceId: string) =>
      [...rows.values()].filter((row) => row.workspace_id === workspaceId && !row.deleted_at),
  } as ReturnType<typeof makeStore>;
}

const temporaryRoots: string[] = [];
afterAll(() => { for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true }); });

function makeService(config: Config): { service: SessionService; store: ReturnType<typeof makeStore> } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-it-'));
  temporaryRoots.push(dataRoot);
  const store = makeStore();
  const service = new SessionService({
    dataRoot,
    pool: new AgentProcessPool(),
    toolService: new AgentToolService({ dataRoot, documentsProvider: () => [] }),
    resolver: new PiRuntimeResolver(),
    configProvider: () => config,
    internalBaseUrl: () => 'http://127.0.0.1:39999',
    extensionPath: () => null,
  });
  return { service, store };
}

function makeConfig(): Config {
  return {
    llm: {
      openAiCompatBaseUrl: 'https://x/v1', apiKey: '', model: 'm', temperature: 0.2,
      primaryChannel: 'direct', fallbackOnFailure: false,
    },
    agent: {
      runtime: {},
      model: { source: 'app-llm', thinkingLevel: 'off', contextWindow: 128000, maxTokens: 8192 },
      maxConcurrentProcesses: 2,
      idleTimeoutMinutes: 10,
      workspaces: [{ id: 'ws_test1', name: '测试工作区', path: '/tmp/ws-test', createdAt: new Date().toISOString() }],
    },
    standardKb: {
      outputRoot: '/tmp/out-test', retainReleases: 3, buildBatchSize: 10,
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 180, autoBuildAfterSync: false,
    },
    pollIntervalMinutes: 30,
    knowledgeBaseRoot: '/tmp/kb-test',
    watchedRoots: [],
    watchedRootUrls: [],
    requiredScopopes: [] as never,
    requiredScopes: [],
    enableAutoStart: true,
    enableNotifications: true,
  } as unknown as Config;
}

describe('RPC message_end 必须是完整DTO（不能把Partial塞入前端列表）', () => {
  it('工具调用与最终文本都带独立id、assistant角色和时间', () => {
    const call = toAssistantMessageDto({ content: [{ type: 'toolCall', id: 'tc', name: 'raw_read', arguments: { objToken: 'synthetic' } }] }, 'live-first');
    const final = toAssistantMessageDto({ content: [{ type: 'text', text: '最终回复' }] }, 'live-final');
    expect(call).toMatchObject({ id: 'live-first', role: 'assistant', at: expect.any(String), toolCalls: [{ id: 'tc', name: 'raw_read', argsSummary: expect.any(String) }] });
    expect(final).toMatchObject({ id: 'live-final', role: 'assistant', text: '最终回复' });
    expect(Number.isFinite(Date.parse(final.at))).toBe(true);
    expect(call.id).not.toBe(final.id);
  });
});

describe('parseSessionJsonl（pi 会话 v3 树）', () => {
  it('沿最后 entry 的 parentId 回溯当前分支；未知 entry 跳过', () => {
    const jsonl = [
      JSON.stringify({ type: 'session', version: 3, id: 'u1', timestamp: '2026-01-01T00:00:00Z', cwd: '/x' }),
      JSON.stringify({ type: 'message', id: 'e1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: '问题一', timestamp: 1735689601000 } }),
      JSON.stringify({ type: 'message', id: 'e2', parentId: 'e1', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: '回答一' }], stopReason: 'stop', model: 'glm-x', timestamp: 1735689602000 } }),
      // 分叉：e3 从 e1 分出（未走分支，不在当前链上）
      JSON.stringify({ type: 'message', id: 'e3', parentId: 'e1', timestamp: '2026-01-01T00:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: '被放弃的分支' }], timestamp: 1735689603000 } }),
      JSON.stringify({ type: 'message', id: 'e4', parentId: 'e2', timestamp: '2026-01-01T00:00:04Z', message: { role: 'user', content: '问题二', timestamp: 1735689604000 } }),
      // 未知 entry 类型（compaction）
      JSON.stringify({ type: 'compaction', id: 'c1', parentId: 'e4', timestamp: '2026-01-01T00:00:05Z' }),
      JSON.stringify({ type: 'message', id: 'e5', parentId: 'e4', timestamp: '2026-01-01T00:00:06Z', message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'raw_read', content: [{ type: 'text', text: '原始内容' }], isError: false, timestamp: 1735689606000 } }),
      JSON.stringify({ type: 'message', id: 'e6', parentId: 'e5', timestamp: '2026-01-01T00:00:07Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'raw_read', arguments: { objToken: 't1' } }, { type: 'text', text: '综合回答' }], stopReason: 'stop', timestamp: 1735689607000 } }),
    ].join('\n');
    const messages = parseSessionJsonl(jsonl);
    expect(messages.map((message) => message.id)).toEqual(['e1', 'e2', 'e4', 'e5', 'e6']);
    expect(messages[0]).toMatchObject({ role: 'user', text: '问题一' });
    expect(messages[1]).toMatchObject({ role: 'assistant', text: '回答一', model: 'glm-x' });
    expect(messages[3]).toMatchObject({ role: 'tool', tool: { callId: 'tc1', name: 'raw_read', isError: false } });
    expect(messages[4].toolCalls).toEqual([{ id: 'tc1', name: 'raw_read', argsSummary: expect.stringContaining('t1') }]);
    expect(messages[4].text).toBe('综合回答');
  });

  it('空文件/仅 header → 空数组', () => {
    expect(parseSessionJsonl('')).toEqual([]);
    expect(parseSessionJsonl(JSON.stringify({ type: 'session', version: 3 }))).toEqual([]);
  });
});

describe('SessionService（内存 store）', () => {
  it('create 只允许 discuss；rename 校验长度', () => {
    const { service, store } = makeService(makeConfig());
    const session = service.create(store, { title: '测试', mode: 'discuss' });
    expect(session.mode).toBe('discuss');
    expect(() => service.create(store, { mode: 'work' })).toThrow(/只允许 discuss/);
    expect(() => service.rename(store, session.id, '')).toThrow(/1\.\.80/);
    const renamed = service.rename(store, session.id, '新名字');
    expect(renamed?.title).toBe('新名字');
  });

  it('模式切换：work 需 confirm WORK + 有效 workspace；discuss 回切清绑定', async () => {
    const { service, store } = makeService(makeConfig());
    const session = service.create(store, {});
    await expect(service.switchMode(store, session.id, { mode: 'work', workspaceId: 'ws_test1' }))
      .rejects.toThrow(/confirm.*WORK|用户显式授权/);
    await expect(service.switchMode(store, session.id, { mode: 'work', workspaceId: 'ws_missing', confirm: 'WORK' }))
      .rejects.toThrow(/Workspace 不存在/);
    const switched = await service.switchMode(store, session.id, { mode: 'work', workspaceId: 'ws_test1', confirm: 'WORK' });
    expect(switched?.mode).toBe('work');
    expect(switched?.workspace?.id).toBe('ws_test1');
    const back = await service.switchMode(store, session.id, { mode: 'discuss' });
    expect(back?.mode).toBe('discuss');
    expect(back?.workspace).toBeNull();
  });

  it('Workspace 删除时绑定的 Work 会话自动切回 discuss', async () => {
    const { service, store } = makeService(makeConfig());
    const session = service.create(store, {});
    await service.switchMode(store, session.id, { mode: 'work', workspaceId: 'ws_test1', confirm: 'WORK' });
    await service.demoteSessionsOnWorkspaceRemoval(store, 'ws_test1');
    const dto = service.get(store, makeConfig(), session.id);
    expect(dto?.mode).toBe('discuss');
  });

  it('SSE 环形缓冲：id 递增、超限裁剪、Last-Event-ID 早于缓冲 → resync', () => {
    const { service } = makeService(makeConfig());
    for (let i = 0; i < 1100; i += 1) {
      service.emitSse('s_x', 'text_delta', { delta: String(i) });
    }
    const all = service.sseSince('s_x', null);
    expect(all.events).toHaveLength(1000); // 缓冲上限
    expect(all.resync).toBe(false);
    const latest = all.events[all.events.length - 1];
    expect(latest.id).toBe(1100);
    const tail = service.sseSince('s_x', 1095);
    expect(tail.events.map((event) => event.id)).toEqual([1096, 1097, 1098, 1099, 1100]);
    // 早于缓冲 → resync
    const stale = service.sseSince('s_x', 1);
    expect(stale.resync).toBe(true);
    expect(stale.events).toEqual([]);
    // 未知会话：空
    expect(service.sseSince('s_none', null).events).toEqual([]);
  });

  it('SSE 初始游标 0 接收首个事件；返回独立快照而非可变缓冲引用', () => {
    const { service } = makeService(makeConfig());
    expect(service.sseSince('new', 0)).toEqual({ events: [], resync: false });
    service.emitSse('new', 'text_delta', { delta: 'first' });
    const first = service.sseSince('new', 0);
    service.emitSse('new', 'text_delta', { delta: 'second' });
    expect(first.events).toHaveLength(1);
    expect(first.resync).toBe(false);
    expect(service.sseSince('new', 0).events).toHaveLength(2);
  });

  for (const staleHeader of [false, true]) it(`HTTP SSE 空连接后首个事件可达、溢出 resync 后继续（旧游标=${staleHeader}）`, async () => {
    const { service } = makeService(makeConfig());
    const app = new Hono();
    app.route('/', await agentRoutes({ sessionService: service } as AgentRouteDeps));
    const abort = new AbortController();
    const response = await app.request('/api/agent/sessions/http-stream/events', {
      signal: abort.signal,
      ...(staleHeader ? { headers: { 'Last-Event-ID': '9999' } } : {}),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const readUntil = async (fragment: string): Promise<string> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            let text = '';
            while (!text.includes(fragment)) {
              const next = await reader.read();
              if (next.done) throw new Error('SSE unexpectedly closed');
              text += decoder.decode(next.value, { stream: true });
            }
            return text;
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`SSE did not deliver ${fragment}`)), 1500); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    try {
      if (staleHeader) expect(await readUntil('resync')).toContain('id: 0');
      service.emitSse('http-stream', 'text_delta', { delta: 'first-live-delta' });
      expect(await readUntil('first-live-delta')).toMatch(/event: ?text_delta/);
      for (let i = 0; i < 1100; i++) service.emitSse('http-stream', 'text_delta', { delta: `burst-${i}` });
      expect(await readUntil('resync')).toContain('1101');
      service.emitSse('http-stream', 'text_delta', { delta: 'after-gap' });
      expect(await readUntil('after-gap')).toMatch(/event: ?text_delta/);
    } finally {
      abort.abort();
      await reader.cancel();
    }
  });

  it('消息校验：空/超长拒绝', async () => {
    const { service, store } = makeService(makeConfig());
    const session = service.create(store, {});
    await expect(service.sendMessage(store, session.id, { text: '' })).rejects.toThrow(/1\.\.20000/);
    await expect(service.sendMessage(store, session.id, { text: 'x'.repeat(20_001) })).rejects.toThrow(/1\.\.20000/);
    await expect(service.sendMessage(store, 's_missing', { text: 'hi' })).rejects.toThrow(/会话不存在/);
  });
});

describe('T3b-07：停止即撤销批准窗口（abort 入口）', () => {
  it('abort() 立即发 session_abort 事件（不等 run_end）；runState 反映 aborting/idle；新运行清除旧标记', async () => {
    const { service, store } = makeService(makeConfig());
    const session = service.create(store, {});
    const events: string[] = [];
    service.on('session_abort', ({ sessionId }: { sessionId: string }) => events.push(sessionId));

    // 无活跃运行时 abort 也立即发事件（批准窗口即刻关闭，不等 run_end）
    expect(service.runState(session.id)).toBe('idle');
    await service.abort(store, session.id);
    expect(events).toEqual([session.id]);

    // 幂等：重复 abort 继续发事件；不存在的会话无事件
    await service.abort(store, session.id);
    expect(events).toEqual([session.id, session.id]);
    await service.abort(store, 's_none');
    expect(events).toHaveLength(2);
  });
});

describe('R11：JSONL 回溯索引全部带 id/parentId 节点（不截断、不串支）', () => {
  const ts = '2026-01-01T00:00:00.000Z';
  const line = (value: unknown) => JSON.stringify(value);
  const msg = (id: string, parentId: string | null, role: string, text: string) => line({
    type: 'message', id, parentId, timestamp: ts,
    message: { role, content: text, timestamp: Date.parse(ts) },
  });
  const header = line({ type: 'session', id: 'sess_root', parentId: null, timestamp: ts });

  it('compaction 夹在消息链中间：更早分支不截断', () => {
    const jsonl = [
      header,
      msg('m1', null, 'user', '问题一'),
      msg('a1', 'm1', 'assistant', '回答一'),
      // 压缩节点作为后续消息的父节点：只索引 message 时回溯会断在这里
      line({ type: 'compaction', id: 'c1', parentId: 'a1', timestamp: ts, summary: '已压缩' }),
      msg('m2', 'c1', 'user', '问题二'),
      msg('a2', 'm2', 'assistant', '回答二'),
    ].join('\n');
    const result = parseSessionJsonl(jsonl);
    expect(result.map((item) => item.id)).toEqual(['m1', 'a1', 'm2', 'a2']);
    expect(result.map((item) => item.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('model_change 作为最终叶：消息不截断，自身不进消息流', () => {
    const jsonl = [
      header,
      msg('m1', null, 'user', '问题一'),
      msg('a1', 'm1', 'assistant', '回答一'),
      line({ type: 'model_change', id: 'mc1', parentId: 'a1', timestamp: ts, model: 'x/y' }),
    ].join('\n');
    const result = parseSessionJsonl(jsonl);
    expect(result.map((item) => item.id)).toEqual(['m1', 'a1']);
  });

  it('分叉分支：文件顺序最后一条决定当前分支，另一支不串入', () => {
    const jsonl = [
      header,
      msg('m1', null, 'user', '问题一'),
      msg('a1', 'm1', 'assistant', '回答一'),
      msg('m2', 'a1', 'user', '问题二（将被放弃）'),
      msg('a2', 'm2', 'assistant', '回答二（被放弃分支）'),
      // 回溯重来：文件顺序最后一条是另一支的用户消息
      msg('m3', 'a1', 'user', '问题三（当前分支）'),
    ].join('\n');
    const result = parseSessionJsonl(jsonl);
    expect(result.map((item) => item.id)).toEqual(['m1', 'a1', 'm3']);
    expect(result.some((item) => item.id === 'a2')).toBe(false);
  });
});
