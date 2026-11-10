/**
 * SessionService 单元测试（设计 §7.6 / §9.3）
 *
 * - pi 会话 JSONL v3 树解析：沿 parentId 回溯当前分支、未知 entry 跳过
 * - SSE 环形缓冲 + Last-Event-ID 续传 + resync
 * - 会话 CRUD/模式切换校验（confirm WORK、workspace 校验、运行中拒绝）
 * 全部用内存 store stub，不触真实 DB 与进程。
 */

import { describe, expect, it, afterAll, vi } from 'vitest';
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

function makeStore() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    getAgentSession: (id: string) => (rows.get(id) ? { ...rows.get(id)! } : null),
    createAgentSession: (input: Parameters<import('../src/modules/local-map-store.js').LocalMapStore['createAgentSession']>[0]) => {
      rows.set(input.id, {
        id: input.id, title: input.title, mode: input.mode, workspace_id: input.workspaceId,
        approval_mode: input.approvalMode, model_config_json: input.modelConfig,
        pi_session_file: null, last_error_code: null, last_error_message: null,
        created_at: input.createdAt, updated_at: input.updatedAt, deleted_at: null,
      });
    },
    listAgentSessions: () => [...rows.values()].filter((row) => !row.deleted_at),
    getAgentSessionDefaults: () => ({ approvalMode: 'ask' as const, modelConfig: null }),
    saveAgentSessionPreferences: (id: string, patch: { approvalMode?: 'ask' | 'auto'; modelConfig?: string | null }) => {
      if (patch.approvalMode !== undefined) rows.get(id)!.approval_mode = patch.approvalMode;
      if (patch.modelConfig !== undefined) rows.get(id)!.model_config_json = patch.modelConfig;
    },
    updateAgentSession: (id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id);
      if (!row) throw new Error(`agent_session 不存在: ${id}`);
      // 与真实 LocalMapStore 同语义：驼峰 patch → 蛇形列
      const mapped: Record<string, unknown> = {};
      if ('title' in patch) mapped.title = patch.title;
      if ('mode' in patch) mapped.mode = patch.mode;
      if ('approvalMode' in patch) mapped.approval_mode = patch.approvalMode;
      if ('workspaceId' in patch) mapped.workspace_id = patch.workspaceId;
      if ('piSessionFile' in patch) mapped.pi_session_file = patch.piSessionFile;
      if ('lastErrorCode' in patch) mapped.last_error_code = patch.lastErrorCode;
      if ('lastErrorMessage' in patch) mapped.last_error_message = patch.lastErrorMessage;
      if ('updatedAt' in patch) mapped.updated_at = patch.updatedAt;
      if ('deletedAt' in patch) mapped.deleted_at = patch.deletedAt;
      if ('localResources' in patch) mapped.local_resources = patch.localResources ? 1 : 0;
      rows.set(id, { ...row, ...mapped });
    },
    listSessionsByWorkspace: (workspaceId: string) =>
      [...rows.values()].filter((row) => row.workspace_id === workspaceId && !row.deleted_at),
  } satisfies SessionStoreApi & Record<string, unknown>;
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

it('审批方式仅适用于 Work，会话隔离并在移除工作区后恢复默认', async () => {
  const { service, store } = makeService(makeConfig());
  const first = service.create(store, {});
  const second = service.create(store, {});
  expect(() => service.setApprovalMode(store, first.id, 'auto')).toThrow(/Work/);
  store.updateAgentSession(first.id, { mode: 'work', workspaceId: 'ws_test1' });
  expect(service.setApprovalMode(store, first.id, 'auto').approvalMode).toBe('auto');
  expect(service.approvalMode(store, second.id)).toBe('ask');
  await service.demoteSessionsOnWorkspaceRemoval(store, 'ws_test1');
  expect(service.approvalMode(store, first.id)).toBe('ask');
});

it('按工作区创建只读会话并用首条消息命名，不覆盖手动标题', async () => {
  const { service, store } = makeService(makeConfig());
  const grouped = service.create(store, { workspaceId: 'ws_test1' });
  expect(grouped.mode).toBe('discuss');
  expect(grouped.workspace?.id).toBe('ws_test1');
  expect(() => service.create(store, { workspaceId: 'missing' })).toThrow(/Workspace/);
  vi.spyOn(service as any, 'executeRun').mockResolvedValue(undefined);
  await service.sendMessage(store, grouped.id, { text: '设计一个\n技能系统' });
  expect(service.get(store, makeConfig(), grouped.id)?.title).toBe('设计一个 技能系统');
  service.rename(store, grouped.id, '用户命名');
  await service.sendMessage(store, grouped.id, { text: '后续消息' });
  expect(service.get(store, makeConfig(), grouped.id)?.title).toBe('用户命名');
});

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

  it('模式切换：work 需 confirm WORK + 有效 workspace；discuss 保留分组', async () => {
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
    expect(back?.workspace?.id).toBe('ws_test1');
  });

  it('Pi Work 无需绑定 Workspace；已有分组可以继续作为起始目录', async () => {
    const { service, store } = makeService(makeConfig());
    const session = service.create(store, {});
    const work = await service.switchMode(store, session.id, { mode: 'work', confirm: 'WORK' });
    expect(work).toMatchObject({ mode: 'work', workspace: null });
    await service.switchMode(store, session.id, { mode: 'discuss' });
    expect(service.get(store, makeConfig(), session.id)?.mode).toBe('discuss');
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
    await expect(service.sendMessage(store, session.id, { text: '' })).rejects.toThrow(/请输入消息或添加附件/);
    await expect(service.sendMessage(store, session.id, { text: 'x'.repeat(20_001) })).rejects.toThrow(/消息不能超过 20000 字符/);
    await expect(service.sendMessage(store, 's_missing', { text: 'hi' })).rejects.toThrow(/会话不存在/);
  });

  it('附件可单独发送，服务端解析的图像字节进入运行参数且不能跨会话引用', async () => {
    const { service, store } = makeService(makeConfig());
    const session = service.create(store, {});
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC', 'base64');
    const attachment = await service.attachments.add(session.id, '示例.png', image);
    const execute = vi.spyOn(service as any, 'executeRun').mockResolvedValue(undefined);
    await service.sendMessage(store, session.id, { text: '', attachmentIds: [attachment.id] });
    expect(execute).toHaveBeenCalledWith(store, session.id, expect.stringContaining(attachment.id), expect.any(String), [{ type: 'image', mimeType: 'image/png', data: image.toString('base64') }]);
    expect(service.messages(store, session.id)[0]).toMatchObject({ text: '', attachments: [attachment] });
    const other = service.create(store, {});
    await expect(service.sendMessage(store, other.id, { text: 'read', attachmentIds: [attachment.id] })).rejects.toMatchObject({ code: 'attachment_not_found' });
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

describe('会话分叉（fork）', () => {
  const userEntry = (id: string, parentId: string | null, text: string) => ({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text }] } });
  const assistantEntry = (id: string, parentId: string | null, text: string) => ({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const modelChange = (id: string, parentId: string | null) => ({ type: 'model_change', id, parentId, timestamp: '2026-01-01T00:00:02.000Z', provider: 'p', modelId: 'm' });

  function seed(entries: unknown[]) {
    const { service, store } = makeService(makeConfig());
    const source = service.create(store, { workspaceId: 'ws_test1' });
    store.updateAgentSession(source.id, { mode: 'work', workspaceId: 'ws_test1', approvalMode: 'auto', localResources: true });
    const dir = path.join((service as any).deps.dataRoot, 'agent', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `2026_${source.id}.jsonl`);
    const header = { type: 'session', version: 3, id: source.id, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/ws-test' };
    fs.writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    store.updateAgentSession(source.id, { piSessionFile: file });
    return { service, store, source, file };
  }
  const tree = () => [
    userEntry('u1', null, '第一问'), assistantEntry('a1', 'u1', '第一答'),
    modelChange('m1', 'a1'),
    userEntry('u2', 'm1', '第二问'), assistantEntry('a2', 'u2', '第二答'),
    userEntry('u3', 'a2', '第三问'), assistantEntry('a3', 'u3', '第三答'),
  ];

  it('从中间轮次分叉：保留到该轮末尾，继承 Work 配置，header 指向新会话并记录父会话', async () => {
    const { service, store, source, file } = seed(tree());
    const fork = await service.fork(store, source.id, { messageId: 'u2' });
    expect(fork.id).not.toBe(source.id);
    expect(fork).toMatchObject({ mode: 'work', approvalMode: 'auto', workspace: { id: 'ws_test1' }, title: expect.stringContaining('分叉') });
    const row = store.getAgentSession(fork.id)!;
    expect(row.local_resources).toBe(1);
    const lines = fs.readFileSync(String(row.pi_session_file), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: 'session', id: fork.id, cwd: '/tmp/ws-test', parentSession: file });
    expect(lines.slice(1).map((entry) => entry.id)).toEqual(['u1', 'a1', 'm1', 'u2', 'a2']);
    const messages = await service.messagesAsync(store, fork.id);
    expect(messages.map((m) => m.text)).toEqual(['第一问', '第一答', '第二问', '第二答']);
    // 源会话与源文件不受影响
    expect((await service.messagesAsync(store, source.id)).map((m) => m.text)).toHaveLength(6);
    expect(store.getAgentSession(source.id)!.pi_session_file).toBe(file);
  });

  it('锚点落在轮次中的助手消息时仍取整轮；尾部非消息节点不带入', async () => {
    const entries = [userEntry('u1', null, 'q1'), assistantEntry('a1', 'u1', 'r1'), modelChange('m1', 'a1'), userEntry('u2', 'm1', 'q2')];
    const { service, store, source } = seed(entries);
    const fork = await service.fork(store, source.id, { messageId: 'a1', title: '自定义' });
    expect(fork.title).toBe('自定义');
    const ids = fs.readFileSync(String(store.getAgentSession(fork.id)!.pi_session_file), 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l).id);
    expect(ids).toEqual(['u1', 'a1']);
  });

  it('只沿当前分支分叉；分叉点不在当前分支/非消息/live id 一律拒绝', async () => {
    const entries = [...tree(), userEntry('ub', 'a1', '另一分支'), assistantEntry('ab', 'ub', '另一答')];
    const { service, store, source } = seed(entries);
    const fork = await service.fork(store, source.id, { messageId: 'ub' });
    const ids = fs.readFileSync(String(store.getAgentSession(fork.id)!.pi_session_file), 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l).id);
    expect(ids).toEqual(['u1', 'a1', 'ub', 'ab']);
    await expect(service.fork(store, source.id, { messageId: 'u2' })).rejects.toMatchObject({ code: 'fork_point_invalid' }); // 非当前分支
    await expect(service.fork(store, source.id, { messageId: 'm1' })).rejects.toMatchObject({ code: 'fork_point_invalid' }); // 非消息节点
    await expect(service.fork(store, source.id, { messageId: 'live_run_x' })).rejects.toMatchObject({ code: 'fork_point_invalid' });
    await expect(service.fork(store, source.id, { messageId: 'attachment_x' })).rejects.toMatchObject({ code: 'fork_point_invalid' });
    await expect(service.fork(store, 'missing', { messageId: 'u1' })).rejects.toMatchObject({ code: 'session_not_found' });
  });

  it('运行中的末尾轮次拒绝，已完成的更早轮次允许', async () => {
    const { service, store, source } = seed(tree());
    (service as any).runs.set(source.id, { runId: 'r', sessionId: source.id, phase: 'running' });
    await expect(service.fork(store, source.id, { messageId: 'u3' })).rejects.toMatchObject({ code: 'session_busy' });
    await expect(service.fork(store, source.id, { messageId: 'u1' })).resolves.toMatchObject({ mode: 'work' });
  });

  it('没有历史文件或为 Claude Code 会话时拒绝', async () => {
    const { service, store } = makeService(makeConfig());
    const empty = service.create(store, {});
    await expect(service.fork(store, empty.id, { messageId: 'u1' })).rejects.toMatchObject({ code: 'fork_source_missing' });
    store.rows.get(empty.id)!.runtime_backend = 'claude-code';
    await expect(service.fork(store, empty.id, { messageId: 'u1' })).rejects.toMatchObject({ code: 'fork_unsupported' });
  });

  it('附件只带入被保留用户消息引用的提交', async () => {
    const submission1 = '11111111-1111-1111-1111-111111111111';
    const submission2 = '22222222-2222-2222-2222-222222222222';
    const wrap = (text: string, id: string) => `${text}\n\n<chat-attachments id="${id}">x</chat-attachments>`;
    const { service, store, source } = seed([
      userEntry('u1', null, wrap('看文档', submission1)), assistantEntry('a1', 'u1', 'ok'),
      userEntry('u2', 'a1', wrap('再看一个', submission2)), assistantEntry('a2', 'u2', 'ok2'),
    ]);
    const root = (service as any).deps.dataRoot as string;
    const dirOf = (id: string) => path.join(root, 'agent', 'attachments', require('node:crypto').createHash('sha256').update(id).digest('hex'));
    const sourceDir = dirOf(source.id); fs.mkdirSync(sourceDir, { recursive: true });
    const attachment = (n: number) => `att_${String(n).repeat(32)}`;
    const meta = (id: string) => JSON.stringify({ id, name: `${id}.txt`, size: 1, mimeType: 'text/plain', kind: 'document', textLength: 1, lineCount: 1, sha256: 'x', submitted: true });
    for (const [n, submission] of [[1, submission1], [2, submission2]] as const) {
      fs.writeFileSync(path.join(sourceDir, `${attachment(n)}.json`), meta(attachment(n)));
      fs.writeFileSync(path.join(sourceDir, `${attachment(n)}.txt`), 'content');
      fs.writeFileSync(path.join(sourceDir, `message_${submission}.json`), JSON.stringify({ text: `文本${n}`, ids: [attachment(n)], submissionId: submission }));
    }
    fs.writeFileSync(path.join(sourceDir, 'submitted.jsonl'), [[1, submission1], [2, submission2]].map(([n, s]) => JSON.stringify({ submissionId: s, text: `文本${n}`, ids: [attachment(Number(n))], at: '2026-01-01T00:00:00.000Z' })).join('\n') + '\n');
    const fork = await service.fork(store, source.id, { messageId: 'u1' });
    const messages = await service.messagesAsync(store, fork.id);
    const users = messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: '文本1', attachments: [{ id: attachment(1) }] });
    expect(fs.existsSync(path.join(dirOf(fork.id), `${attachment(2)}.json`))).toBe(false);
  });
});
