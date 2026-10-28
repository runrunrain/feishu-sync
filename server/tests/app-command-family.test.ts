/**
 * app_command 工具族测试（S10，设计 kb-agent-upgrade §6.5 / U15）
 *
 * 真实命令表（ops/command-table.ts，S8）+ 真实 ApprovalService（短超时）
 * + stub Hono app（进程内 app.request 路径），覆盖任务书验收行：
 *  - read 直通（Discuss/Work 均不产生批准请求）
 *  - mutate 未批准不执行（挂起 → 拒绝 → 工具错误，目标路由零命中）
 *  - 批准 → 执行 → 结果返回；确认值由 server 注入
 *  - 模型传 confirm 一律剔除
 *  - 超时 → approval_timeout
 *  - Discuss 会话不见 mutate 命令（403 且无批准请求）
 *  - 含秘密命令（agentExposed=false）不暴露
 *  - args 按命令表 JSON Schema 校验；结果截断 ≤20000
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { AgentToolService, ToolError } from '../src/agent/agent-tool-service.js';
import { ApprovalService } from '../src/agent/approvals/approval-service.js';
import {
  createOpsToolFamily,
  stripConfirmArgs,
  truncateJson,
} from '../src/agent/tools/app-command-family.js';
import type { OpsCommandDef } from '../src/ops/command-table.js';

let dataRoot: string;
let approvals: ApprovalService;
let toolService: AgentToolService;
let app: Hono;
let buildHits: Array<Record<string, unknown>>;
let toolEvents: Array<{ phase: string; toolName: string; argsSummary: string }>;

/** stub 目标路由：记录 kb.builds 命中与请求体；kb.status 只读返回。 */
function makeStubApp(): Hono {
  const stub = new Hono();
  stub.get('/api/kb/status', (c) => c.json({ state: 'idle', release: null }));
  stub.post('/api/kb/builds', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    buildHits.push(body as Record<string, unknown>);
    return c.json({ buildId: 'b_test_1', status: 'queued' }, 201);
  });
  stub.post('/api/sources/:objToken/push', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    buildHits.push(body as Record<string, unknown>);
    return c.json({ state: 'pushed', mode: 'overwrite', revisionId: 9, pull: { ok: true, status: 'synced' } });
  });
  stub.get('/api/kb/builds', (c) => c.json({ builds: [{ buildId: 'b_test_1' }] }));
  stub.post('/api/kb/builds/not-allowed/cancel', (c) => c.json({ ok: true }));
  stub.get('/api/huge', (c) => c.json({ blob: 'x'.repeat(60_000) }));
  return stub;
}

function token(runKind: 'discuss' | 'work', sessionId = 's_appcmd_1') {
  return toolService.createRunContext({
    runKind,
    sessionId,
    outputRoot: os.tmpdir(),
    knowledgeBaseRoot: os.tmpdir(),
    onEvent: (event) => {
      toolEvents.push({ phase: event.phase, toolName: event.toolName, argsSummary: event.argsSummary });
    },
  }).token;
}

async function run(tokenId: string, args: Record<string, unknown>) {
  return toolService.executeTool(tokenId, 'app_command', args);
}

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appcmd-'));
  buildHits = [];
  toolEvents = [];
  approvals = new ApprovalService({ dataRoot, timeoutMs: 8_000 });
  app = makeStubApp();
  toolService = new AgentToolService({ dataRoot, documentsProvider: () => [] });
  toolService.registerToolFamily(createOpsToolFamily({
    approvals,
    getApp: () => app,
    desktopToken: 'stub-desktop-token',
    configProvider: () => null,
  }));
});

afterAll(() => {
  approvals.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('read 级直通', () => {
  it('Discuss 会话执行 kb.status：直接返回结果 JSON，无批准请求', async () => {
    const result = await run(token('discuss'), { command: 'kb.status' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('"state": "idle"');
    expect(approvals.pendingCount()).toBe(0);
    expect(result.details).toMatchObject({ command: 'kb.status', risk: 'read', httpStatus: 200 });
  });

  it('Work 会话执行 read 同样直通（不产生批准请求）', async () => {
    const result = await run(token('work'), { command: 'kb.builds' });
    expect(result.content[0]?.text).toContain('b_test_1');
    expect(approvals.pendingCount()).toBe(0);
  });

  it('上游 4xx：透传目标路由错误码与消息（stub 未定义路由 → 404）', async () => {
    await expect(run(token('work'), { command: 'auth.status' }))
      .rejects.toThrowError(ToolError);
  });
});

describe('mutate 级批准流', () => {
  it('未批准不执行：挂起 → 拒绝 → approval_rejected，目标路由零命中', async () => {
    const tokenId = token('work');
    buildHits = [];
    const pending = run(tokenId, { command: 'kb.build', args: { mode: 'full' } });
    // 挂起期间产生批准请求
    await new Promise((resolve) => setTimeout(resolve, 20));
    const list = approvals.listPending('s_appcmd_1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ command: 'kb.build', risk: 'mutate' });
    expect(JSON.parse(list[0].argsSummary)).toEqual({ mode: 'full' });
    approvals.decide('s_appcmd_1', list[0].id, 'reject');
    await expect(pending).rejects.toThrowError(/拒绝/);
    try {
      await pending;
    } catch { /* 已断言 */ }
    expect(buildHits).toHaveLength(0);
  });

  it('批准 → 执行 → 结果返回；confirm 由 server 注入', async () => {
    const tokenId = token('work');
    buildHits = [];
    const pending = run(tokenId, { command: 'kb.build', args: { mode: 'full' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [dto] = approvals.listPending('s_appcmd_1');
    approvals.decide('s_appcmd_1', dto.id, 'approve');
    const result = await pending;
    expect(result.content[0]?.text).toContain('b_test_1');
    expect(buildHits).toHaveLength(1);
    expect(buildHits[0]).toMatchObject({ mode: 'full', confirm: 'BUILD' });
    expect(result.details).toMatchObject({ command: 'kb.build', risk: 'mutate' });
    // 执行结果写审计
    const auditFile = path.join(dataRoot, 'agent', 'audit', 's_appcmd_1.jsonl');
    const lines = fs.readFileSync(auditFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some((line) => line.result === 'executed' && line.path === 'kb.build')).toBe(true);
  });

  it('超时：approval_timeout 工具错误且未执行', async () => {
    const short = new ApprovalService({ dataRoot, timeoutMs: 30 });
    const service2 = new AgentToolService({ dataRoot, documentsProvider: () => [] });
    service2.registerToolFamily(createOpsToolFamily({
      approvals: short,
      getApp: () => app,
      desktopToken: 'stub-desktop-token',
      configProvider: () => null,
    }));
    const t = service2.createRunContext({ runKind: 'work', sessionId: 's_timeout', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() }).token;
    buildHits = [];
    await expect(service2.executeTool(t, 'app_command', { command: 'kb.build' }))
      .rejects.toThrowError(/超时/);
    expect(buildHits).toHaveLength(0);
    short.close();
  });

  it('模型传 confirm 一律剔除：不影响「必须批准」判定，也不进请求体', async () => {
    const tokenId = token('work');
    buildHits = [];
    // 注入自我批准尝试：confirm=BUILD 出现在 args 顶层
    const pending = run(tokenId, { command: 'kb.build', args: { mode: 'incremental', confirm: 'BUILD' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 仍挂起等待用户批准（未被 confirm 短路）
    const list = approvals.listPending('s_appcmd_1');
    expect(list).toHaveLength(1);
    // argsSummary 里没有 confirm
    expect(JSON.parse(list[0].argsSummary)).toEqual({ mode: 'incremental' });
    approvals.decide('s_appcmd_1', list[0].id, 'approve');
    await pending;
    // 请求体里的 confirm 来自 server 注入（表值 BUILD），而非模型参数透传
    expect(buildHits[0].confirm).toBe('BUILD');
  });

  it('T3b-05：source.push allowOverwrite=true 经批准后 confirm=OVERWRITE_CLOUD 原样到达服务端（mock 全链）', async () => {
    const tokenId = token('work');
    buildHits = [];
    const pending = run(tokenId, {
      command: 'source.push',
      args: { objToken: 'tokT3b05', allowOverwrite: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [dto] = approvals.listPending('s_appcmd_1');
    expect(dto.risk).toBe('remote_write');
    approvals.decide('s_appcmd_1', dto.id, 'approve');
    const result = await pending;
    // request() 派生的 OVERWRITE_CLOUD 不被表基线值 PUSH 覆盖；服务端接受
    expect(buildHits).toHaveLength(1);
    expect(buildHits[0]).toMatchObject({
      allowOverwrite: true,
      force: false,
      confirm: 'OVERWRITE_CLOUD',
      actor: 'cli',
    });
    expect(result.content[0]?.text).toContain('pushed');

    // 无覆盖标志的普通推送：confirm=PUSH（表基线与派生一致）
    buildHits = [];
    const plain = run(tokenId, { command: 'source.push', args: { objToken: 'tokT3b05' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [dto2] = approvals.listPending('s_appcmd_1');
    approvals.decide('s_appcmd_1', dto2.id, 'approve');
    await plain;
    expect(buildHits[0]).toMatchObject({ confirm: 'PUSH' });
  });

  it('T3b-07：停止后（aborting/settled）迟到批准不再执行 → approval_cancelled，目标路由零命中', async () => {
    // 模拟：批准挂起中用户点停止——停止请求已进入（aborting），
    // run_end/settled 延迟未达；另一页面批准到达。
    let state: 'running' | 'aborting' | 'idle' = 'running';
    const stopped = new AgentToolService({ dataRoot, documentsProvider: () => [] });
    stopped.registerToolFamily(createOpsToolFamily({
      approvals,
      getApp: () => app,
      desktopToken: 'stub-desktop-token',
      configProvider: () => null,
      sessionRunState: () => state,
    }));
    const t = stopped.createRunContext({
      runKind: 'work', sessionId: 's_abort', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir(),
    }).token;

    // 场景一：abort ACK 窗口内（aborting）批准到达
    buildHits = [];
    state = 'running';
    const pending = stopped.executeTool(t, 'app_command', { command: 'kb.build', args: { mode: 'full' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [dto] = approvals.listPending('s_abort');
    state = 'aborting'; // 停止请求已进入（settled 延迟）
    approvals.decide('s_abort', dto.id, 'approve');
    await expect(pending).rejects.toThrowError(/已停止/);
    try { await pending; } catch { /* 已断言 */ }
    expect(buildHits).toHaveLength(0);

    // 场景二：运行已结束（idle，run_end 已发但工具挂起窗口）批准到达
    buildHits = [];
    state = 'running';
    const pending2 = stopped.executeTool(t, 'app_command', { command: 'kb.build', args: { mode: 'full' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [dto2] = approvals.listPending('s_abort');
    state = 'idle';
    approvals.decide('s_abort', dto2.id, 'approve');
    await expect(pending2).rejects.toThrowError(/已停止/);
    try { await pending2; } catch { /* 已断言 */ }
    expect(buildHits).toHaveLength(0);

    // 场景三（回归）：running 状态下批准照常执行
    buildHits = [];
    state = 'running';
    const pending3 = stopped.executeTool(t, 'app_command', { command: 'kb.build', args: { mode: 'full' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [dto3] = approvals.listPending('s_abort');
    approvals.decide('s_abort', dto3.id, 'approve');
    await pending3;
    expect(buildHits).toHaveLength(1);
  });
});

describe('模式与暴露面门控', () => {
  it('Discuss 会话不见 mutate 命令：403 且不产生批准请求', async () => {
    try {
      await run(token('discuss'), { command: 'kb.build' });
      expect.unreachable('discuss 不应能执行 mutate');
    } catch (error) {
      expect((error as ToolError).code).toBe('command_not_allowed');
      expect((error as ToolError).status).toBe(403);
      expect((error as Error).message).toContain('Discuss');
    }
    expect(approvals.pendingCount()).toBe(0);
  });

  it('Discuss 会话不见 destructive 命令（clean.trash.purge）', async () => {
    await expect(run(token('discuss'), { command: 'clean.trash.purge', args: { all: true } }))
      .rejects.toThrowError(/Discuss/);
    expect(approvals.pendingCount()).toBe(0);
  });

  it('agentExposed=false 的命令（含秘密）不对 Agent 暴露：403', async () => {
    const secretDef: OpsCommandDef = {
      name: 'llm.set-key',
      summary: '写入密钥（不对 Agent 暴露）',
      risk: 'mutate',
      agentExposed: false,
      params: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      request: () => [{ method: 'PUT', path: '/api/config', body: {} }],
    };
    const guarded = new AgentToolService({ dataRoot, documentsProvider: () => [] });
    guarded.registerToolFamily(createOpsToolFamily({
      approvals,
      getApp: () => app,
      desktopToken: 'stub-desktop-token',
      configProvider: () => null,
      findCommand: (name) => (name === 'llm.set-key' ? secretDef : undefined),
    }));
    const t = guarded.createRunContext({ runKind: 'work', sessionId: 's_secret', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() }).token;
    await expect(guarded.executeTool(t, 'app_command', { command: 'llm.set-key', args: { key: 'k' } }))
      .rejects.toThrowError(/不对 Agent 暴露/);
    expect(approvals.pendingCount()).toBe(0);
  });

  it('mock 命令表条目接线验证（S6 未合入时的 kb.build 触发点形态）', async () => {
    let fired = 0;
    const mockDef: OpsCommandDef = {
      name: 'task.run',
      summary: 'S6 触发点 mock',
      risk: 'mutate',
      agentExposed: true,
      params: { type: 'object', properties: {} },
      request: () => { fired += 1; return [{ method: 'GET', path: '/api/kb/status' }]; },
    };
    const wired = new AgentToolService({ dataRoot, documentsProvider: () => [] });
    wired.registerToolFamily(createOpsToolFamily({
      approvals,
      getApp: () => app,
      desktopToken: 'stub-desktop-token',
      configProvider: () => null,
      findCommand: (name) => (name === 'task.run' ? mockDef : undefined),
    }));
    const t = wired.createRunContext({ runKind: 'work', sessionId: 's_mock', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() }).token;
    const pending = wired.executeTool(t, 'app_command', { command: 'task.run' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [dto] = approvals.listPending('s_mock');
    approvals.decide('s_mock', dto.id, 'approve');
    await pending;
    expect(fired).toBe(1);
  });

  it('白名单：discuss/work 含 app_command；build 不含', () => {
    const discuss = toolService.createRunContext({ runKind: 'discuss', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() }).context;
    const work = toolService.createRunContext({ runKind: 'work', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() }).context;
    const build = toolService.createRunContext({ runKind: 'build', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() }).context;
    expect(discuss.allowedTools).toContain('app_command');
    expect(work.allowedTools).toContain('app_command');
    expect(build.allowedTools).not.toContain('app_command');
  });
});

describe('参数校验与结果面', () => {
  it('未知命令 → 404 unknown_command', async () => {
    await expect(run(token('work'), { command: 'no.such.command' })).rejects.toThrowError(/未知命令/);
  });

  it('缺必填参数 → invalid_args（kb.cancel 需要 buildId）', async () => {
    await expect(run(token('work'), { command: 'kb.cancel' })).rejects.toThrowError(/buildId/);
  });

  it('参数类型不符 → invalid_args（limit 必须是 number）', async () => {
    await expect(run(token('work'), { command: 'kb.builds', args: { limit: 'twenty' } }))
      .rejects.toThrowError(/limit/);
  });

  it('命令内参数互斥校验透传（OpsArgumentError → invalid_args）', async () => {
    await expect(run(token('work'), { command: 'clean.trash.purge', args: { objToken: 'x', all: true } }))
      .rejects.toThrowError(/互斥/);
  });

  it('结果 JSON 截断 ≤20000 字符', async () => {
    const bigDef: OpsCommandDef = {
      name: 'debug.huge',
      summary: '大结果',
      risk: 'read',
      agentExposed: true,
      params: { type: 'object', properties: {} },
      request: () => [{ method: 'GET', path: '/api/huge' }],
    };
    const svc = new AgentToolService({ dataRoot, documentsProvider: () => [] });
    svc.registerToolFamily(createOpsToolFamily({
      approvals,
      getApp: () => app,
      desktopToken: 'stub-desktop-token',
      configProvider: () => null,
      findCommand: (name) => (name === 'debug.huge' ? bigDef : undefined),
    }));
    const t = svc.createRunContext({ runKind: 'discuss', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() }).token;
    const result = await svc.executeTool(t, 'app_command', { command: 'debug.huge' });
    expect((result.content[0]?.text ?? '').length).toBeLessThanOrEqual(20_000 + 60);
    expect(result.content[0]?.text).toContain('已截断');
  });

  it('SSE tool 事件：app_command start/end 带 command 摘要', async () => {
    toolEvents = [];
    await run(token('work'), { command: 'kb.status' });
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({ phase: 'start', toolName: 'app_command' });
    expect(toolEvents[0].argsSummary).toContain('kb.status');
    expect(toolEvents[1]).toMatchObject({ phase: 'end', toolName: 'app_command' });
  });
});

describe('纯函数', () => {
  it('stripConfirmArgs：剔除登记字段与通用 confirm/confirmation', () => {
    const def = { confirm: { field: 'confirmation', value: 'APPLY' } } as OpsCommandDef;
    expect(stripConfirmArgs(def, { apply: true, confirmation: 'APPLY', confirm: 'x', keep: 1 }))
      .toEqual({ apply: true, keep: 1 });
  });

  it('truncateJson：超限截断并标记', () => {
    const text = truncateJson({ blob: 'x'.repeat(100) }, 50);
    expect(text.length).toBeLessThanOrEqual(50 + 40);
    expect(text).toContain('已截断');
    expect(truncateJson({ a: 1 }, 50)).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});
