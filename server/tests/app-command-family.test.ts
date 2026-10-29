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

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { AgentToolService, ToolError } from '../src/agent/agent-tool-service.js';
import { ApprovalService } from '../src/agent/approvals/approval-service.js';
import { SessionService } from '../src/agent/session-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { modelRevision } from '../src/agent/model-revision.js';
import type { SessionStoreApi } from '../src/agent/session-service.js';
import type { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import type { Config } from '../src/types/index.js';
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
/** push/preview 桩计划（T3d-05R：可按用例切换 append/overwrite） */
let pushPreviewPlan: { mode: string; blockedReason?: string };

/** stub 目标路由：记录 kb.builds 命中与请求体；kb.status 只读返回。 */
function makeStubApp(): Hono {
  const stub = new Hono();
  stub.get('/api/kb/status', (c) => c.json({ state: 'idle', release: null }));
  stub.post('/api/kb/builds', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    buildHits.push(body as Record<string, unknown>);
    return c.json({ buildId: 'b_test_1', status: 'queued' }, 201);
  });
  stub.post('/api/sources/:objToken/push/preview', (c) => c.json(pushPreviewPlan));
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
  pushPreviewPlan = { mode: 'append' };
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
  it('免审批只对授权的 Work 会话生效，并保留停止状态检查', async () => {
    const auto = new AgentToolService({ dataRoot, documentsProvider: () => [] });
    let state: 'running' | 'idle' = 'running';
    auto.registerToolFamily(createOpsToolFamily({ approvals, getApp: () => app, desktopToken: 'stub', configProvider: () => null,
      approvalMode: (id) => id === 'auto-session' ? 'auto' : 'ask', sessionRunState: () => state }));
    const work = auto.createRunContext({ runKind: 'work', sessionId: 'auto-session', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() }).token;
    const discuss = auto.createRunContext({ runKind: 'discuss', sessionId: 'auto-session', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() }).token;
    buildHits = [];
    await auto.executeTool(work, 'app_command', { command: 'kb.build', args: { mode: 'full' } });
    expect(buildHits).toHaveLength(1);
    expect(approvals.pendingCount()).toBe(0);
    await expect(auto.executeTool(discuss, 'app_command', { command: 'kb.build', args: { mode: 'full' } })).rejects.toThrow();
    state = 'idle';
    await expect(auto.executeTool(work, 'app_command', { command: 'kb.build', args: { mode: 'full' } })).rejects.toThrow(/停止/);
    expect(buildHits).toHaveLength(1);
  });
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

  it('T3d-05R：source.push 确认值由权威 preview 派生（append+allowOverwrite → PUSH；overwrite → OVERWRITE_CLOUD；blocked → 拒绝）', async () => {
    const tokenId = token('work');
    buildHits = [];
    // 真实 diff 形态 = 纯追加：即使 allowOverwrite=true，确认值也是 PUSH
    //（diting T3b-05R 回归——旧实现按参数猜 OVERWRITE_CLOUD 会被服务拒）
    pushPreviewPlan = { mode: 'append' };
    const appendPending = run(tokenId, {
      command: 'source.push',
      args: { objToken: 'tokT3b05', allowOverwrite: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [appendDto] = approvals.listPending('s_appcmd_1');
    expect(appendDto.risk).toBe('remote_write');
    // 批准卡展示派生值（非表基线 PUSH 猜测路径，而是 preview 派生结果）
    expect((appendDto.preview as { confirmValue?: string }).confirmValue).toBe('PUSH');
    approvals.decide('s_appcmd_1', appendDto.id, 'approve');
    await appendPending;
    expect(buildHits[0]).toMatchObject({ allowOverwrite: true, force: false, confirm: 'PUSH', actor: 'cli' });

    // 真实 diff 形态 = 覆盖：确认值升级 OVERWRITE_CLOUD
    buildHits = [];
    pushPreviewPlan = { mode: 'overwrite' };
    const overwritePending = run(token('work'), {
      command: 'source.push',
      args: { objToken: 'tokT3b05', allowOverwrite: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [overwriteDto] = approvals.listPending('s_appcmd_1');
    expect((overwriteDto.preview as { confirmValue?: string }).confirmValue).toBe('OVERWRITE_CLOUD');
    approvals.decide('s_appcmd_1', overwriteDto.id, 'approve');
    await overwritePending;
    expect(buildHits[0]).toMatchObject({ confirm: 'OVERWRITE_CLOUD' });

    // force=true（append 形态）：确认值 OVERWRITE_CLOUD（与真实服务同契约）
    buildHits = [];
    pushPreviewPlan = { mode: 'append' };
    const forcePending = run(token('work'), {
      command: 'source.push',
      args: { objToken: 'tokT3b05', force: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [forceDto] = approvals.listPending('s_appcmd_1');
    expect((forceDto.preview as { confirmValue?: string }).confirmValue).toBe('OVERWRITE_CLOUD');
    approvals.decide('s_appcmd_1', forceDto.id, 'approve');
    await forcePending;
    expect(buildHits[0]).toMatchObject({ force: true, confirm: 'OVERWRITE_CLOUD' });

    // 计划不可推送（blocked）：不产生批准请求，直接工具错误
    buildHits = [];
    pushPreviewPlan = { mode: 'blocked', blockedReason: 'no_changes' };
    await expect(run(token('work'), { command: 'source.push', args: { objToken: 'tokT3b05' } }))
      .rejects.toMatchObject({ code: 'source_push_blocked', status: 400 });
    expect(approvals.pendingCount()).toBe(0);
    expect(buildHits).toHaveLength(0);

    // 批准期间计划变化（append→overwrite）→ 批准过期拒执行
    buildHits = [];
    pushPreviewPlan = { mode: 'append' };
    const stalePending = run(token('work'), { command: 'source.push', args: { objToken: 'tokT3b05' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [staleDto] = approvals.listPending('s_appcmd_1');
    pushPreviewPlan = { mode: 'overwrite' }; // 批准前真实计划变化
    approvals.decide('s_appcmd_1', staleDto.id, 'approve');
    await expect(stalePending).rejects.toMatchObject({ code: 'approval_plan_expired', status: 409 });
    expect(buildHits).toHaveLength(0);
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

// ===========================================================================
// T3b-07R：工具请求绑定 server 权威轮次（真实 SessionService 流时序）
// ===========================================================================

/** 受控 RPC double：prompt 挂起等 resolvePrompt；可注入 tool_execution_start。 */
class RoundFakeRpc extends EventEmitter {
  prompts: string[] = [];
  exited = false;
  active = false;
  private resolvers: Array<(value: unknown) => void> = [];

  isExited(): boolean { return this.exited; }
  hasActiveRun(): boolean { return this.active; }
  async start(): Promise<void> {}
  async prompt(message: string): Promise<unknown> {
    this.prompts.push(message);
    this.active = true;
    return new Promise((resolve) => { this.resolvers.push(resolve); });
  }
  resolvePrompt(value: unknown): void {
    this.active = false;
    this.resolvers.shift()?.(value);
  }
  async sendCommand(type: string): Promise<unknown> {
    return type === 'get_state' ? { success: true, data: {} } : { success: true, data: {} };
  }
  async abort(): Promise<void> {}
  async terminate(): Promise<void> { this.exited = true; this.emit('exit'); }
}

function roundStore(): SessionStoreApi {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    getAgentSession: (id) => (rows.get(id) ? { ...rows.get(id)! } : null),
    createAgentSession: (input) => {
      rows.set(input.id, {
        id: input.id, title: input.title, mode: input.mode, workspace_id: input.workspaceId,
        pi_session_file: null, last_error_code: null, last_error_message: null,
        created_at: input.createdAt, updated_at: input.updatedAt, deleted_at: null,
      });
    },
    listAgentSessions: () => [...rows.values()],
    updateAgentSession: (id, patch) => {
      const row = rows.get(id);
      if (!row) throw new Error(`agent_session 不存在: ${id}`);
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
    listSessionsByWorkspace: () => [],
  } as SessionStoreApi;
}

function roundConfig(): Config {
  return {
    llm: {
      openAiCompatBaseUrl: 'https://x/v1', apiKey: '', model: 'm', temperature: 0.2,
      primaryChannel: 'direct', fallbackOnFailure: false,
    },
    agent: {
      runtime: {}, model: { source: 'app-llm', thinkingLevel: 'off', contextWindow: 128000, maxTokens: 8192 },
      maxConcurrentProcesses: 2, idleTimeoutMinutes: 10, workspaces: [],
    },
    standardKb: {
      outputRoot: '/tmp/round-out', retainReleases: 3, buildBatchSize: 10,
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 180, autoBuildAfterSync: false,
    },
  } as unknown as Config;
}

describe('T3b-07R：工具请求与批准绑定权威轮次（真实 SessionService 流时序）', () => {
  it('旧轮迟到请求跨到新轮 → 409 stale_tool_request（零批准零执行）；同轮请求照常且批准卡带 runId', async () => {
    const roundRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appcmd-round-'));
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
    const config = roundConfig();
    const store = roundStore();
    const roundApprovals = new ApprovalService({ dataRoot: roundRoot, timeoutMs: 8_000 });
    const roundTools = new AgentToolService({ dataRoot: roundRoot, documentsProvider: () => [] });
    const resolver = new PiRuntimeResolver();
    const sessions = new SessionService({
      dataRoot: roundRoot,
      pool,
      toolService: roundTools,
      resolver,
      configProvider: () => config,
      internalBaseUrl: () => 'http://127.0.0.1:39999',
      extensionPath: () => null,
      workspaceGuards: () => ({
        knowledgeBaseRoot: '/tmp/round-kb', outputRoot: config.standardKb.outputRoot, dataRoot: roundRoot,
      }),
    });
    roundTools.registerToolFamily(createOpsToolFamily({
      approvals: roundApprovals,
      getApp: () => app,
      desktopToken: 'stub-desktop-token',
      configProvider: () => null,
      sessionRunState: (sid) => sessions.runState(sid),
      toolCallRun: (sid, toolCallId) => sessions.runOfToolCall(sid, toolCallId),
      currentRunId: (sid) => sessions.currentRunId(sid),
    }));
    // 预注册 fake 进程并同步 modelRevisions（复用进程不触发真实 spawn）
    const register = pool.register.bind(pool);
    vi.spyOn(pool, 'register').mockImplementation((...args) => {
      (sessions as unknown as { modelRevisions: WeakMap<PiRpcProcess, string> }).modelRevisions.set(
        args[1], modelRevision(config),
      );
      return register(...args);
    });
    const session = sessions.create(store, { title: '跨轮请求' });
    const fake = new RoundFakeRpc();
    pool.register(session.id, fake as unknown as PiRpcProcess, 'session');
    const token = roundTools.createRunContext({
      runKind: 'work', sessionId: session.id, outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir(),
    }).token;

    try {
      // 第一轮：运行中，pi 发起 tc_r1 工具调用（服务端权威记录归属）
      const run1 = await sessions.sendMessage(store, session.id, { text: '第一轮' });
      await vi.waitFor(() => expect(sessions.currentRunId(session.id)).toBe(run1.runId));
      fake.emit('tool_execution_start', { toolCallId: 'tc_r1', toolName: 'app_command' });
      expect(sessions.runOfToolCall(session.id, 'tc_r1')).toBe(run1.runId);
      fake.resolvePrompt({ outcome: 'completed', lastAssistantText: '完成' });
      await vi.waitFor(() => expect(sessions.currentRunId(session.id)).toBeNull());

      // 第二轮开始（复用同一进程——旧令牌与进程均未变）
      const run2 = await sessions.sendMessage(store, session.id, { text: '第二轮' });
      await vi.waitFor(() => expect(sessions.currentRunId(session.id)).toBe(run2.runId));

      // 旧轮迟到的工具 HTTP 请求（携 tc_r1）跨到新轮 → 拒绝；不产生批准
      buildHits = [];
      await expect(roundTools.executeTool(token, 'app_command', { command: 'kb.build' }, { toolCallId: 'tc_r1' }))
        .rejects.toMatchObject({ code: 'stale_tool_request', status: 409 });
      expect(roundApprovals.pendingCount()).toBe(0);
      expect(buildHits).toHaveLength(0);

      // 同轮（run2）请求照常：批准卡携带 runId；批准 → 执行
      buildHits = [];
      fake.emit('tool_execution_start', { toolCallId: 'tc_r2', toolName: 'app_command' });
      const pending = roundTools.executeTool(
        token, 'app_command', { command: 'kb.build', args: { mode: 'full' } }, { toolCallId: 'tc_r2' },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const [dto] = roundApprovals.listPending(session.id);
      expect(dto.runId).toBe(run2.runId);
      expect((dto.preview as { confirmValue?: string }).confirmValue).toBe('BUILD');
      roundApprovals.decide(session.id, dto.id, 'approve');
      const result = await pending;
      expect(result.details).toMatchObject({ command: 'kb.build' });
      expect(buildHits).toHaveLength(1);

      fake.resolvePrompt({ outcome: 'completed', lastAssistantText: '第二轮完成' });
      await vi.waitFor(() => expect(sessions.currentRunId(session.id)).toBeNull());
    } finally {
      roundApprovals.close();
      await pool.closeAll();
      fs.rmSync(roundRoot, { recursive: true, force: true });
    }
  });
});
