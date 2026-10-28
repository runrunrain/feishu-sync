/**
 * 批准 API + SSE 集成测试（S10，设计 kb-agent-upgrade §6.5）
 *
 * buildServer 真实入口 + app.fetch：
 *  - GET /api/agent/sessions/:id/approvals → pending 列表（404 会话不存在）
 *  - POST /api/agent/sessions/:id/approvals/:approvalId/decide → 裁决
 *  - approval_request / approval_resolved 并入会话 SSE 缓冲（sseSince）
 *  - run_end 取消 pending（index.ts 接线：sessionService.on('sse')）
 *  - 审计行落 <dataRoot>/agent/audit/<sessionId>.jsonl
 * 隔离 FEISHU_SYNC_HOME（CLAUDE.md：测试一律临时根）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/index.js';
import type { ApprovalService } from '../src/agent/approvals/approval-service.js';
import type { SessionService } from '../src/agent/session-service.js';
import type { Hono } from 'hono';

let app: Hono;
let approvals: ApprovalService;
let sessions: SessionService;
let home: string;
let previousHome: string | undefined;
let sessionId: string;

function isolateHome(): string {
  previousHome = process.env.FEISHU_SYNC_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-approval-test-'));
  process.env.FEISHU_SYNC_HOME = dir;
  return dir;
}

async function call(
  method: 'GET' | 'POST',
  urlPath: string,
  body: unknown = undefined,
): Promise<{ status: number; json: any }> {
  const request = new Request(`http://127.0.0.1${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', Host: '127.0.0.1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const response = await app.fetch(request);
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

function sseEvents(sid: string, event?: string): Array<{ id: number; event: string; data: any }> {
  return sessions.sseSince(sid, null).events
    .filter((record) => !event || record.event === event);
}

beforeAll(async () => {
  home = isolateHome();
  app = await buildServer({ desktopMode: false }) as unknown as Hono;
  approvals = (app as unknown as { __approvalService: ApprovalService }).__approvalService;
  sessions = (app as unknown as { __agentSessionService: SessionService }).__agentSessionService;
  const created = await call('POST', '/api/agent/sessions', { title: '批准流测试' });
  expect(created.status).toBe(201);
  sessionId = created.json.id;
});

afterAll(() => {
  approvals.close();
  process.env.FEISHU_SYNC_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('批准 API', () => {
  it('GET approvals：无 pending → 空列表；未知会话 → 404', async () => {
    const empty = await call('GET', `/api/agent/sessions/${sessionId}/approvals`);
    expect(empty.status).toBe(200);
    expect(empty.json.approvals).toEqual([]);
    const missing = await call('GET', '/api/agent/sessions/s_none/approvals');
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe('session_not_found');
  });

  it('decide：批准成功、SSE 事件序列、pending 清空、审计行', async () => {
    const { dto } = approvals.begin({
      sessionId,
      command: 'kb.build',
      risk: 'mutate',
      argsSummary: '{"mode":"full"}',
    });
    const before = sseEvents(sessionId).length;
    expect(before).toBeGreaterThan(0); // approval_request 已并入缓冲
    const requestEvents = sseEvents(sessionId, 'approval_request');
    expect(requestEvents.at(-1)?.data).toMatchObject({ id: dto.id, command: 'kb.build', risk: 'mutate' });

    const listed = await call('GET', `/api/agent/sessions/${sessionId}/approvals`);
    expect(listed.json.approvals).toHaveLength(1);
    expect(listed.json.approvals[0]).toMatchObject({ id: dto.id, command: 'kb.build' });

    const decision = await call('POST', `/api/agent/sessions/${sessionId}/approvals/${dto.id}/decide`, { decision: 'approve' });
    expect(decision.status).toBe(200);
    expect(decision.json).toEqual({ id: dto.id, decision: 'approve' });

    const resolved = sseEvents(sessionId, 'approval_resolved').at(-1);
    expect(resolved?.data).toEqual({ id: dto.id, decision: 'approve' });

    const after = await call('GET', `/api/agent/sessions/${sessionId}/approvals`);
    expect(after.json.approvals).toEqual([]);

    const auditFile = path.join(home, 'agent', 'audit', `${sessionId}.jsonl`);
    const lines = fs.readFileSync(auditFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.result)).toEqual(['approval_requested', 'approval_approved']);
    expect(lines[0]).toMatchObject({ tool: 'app_command', path: 'kb.build' });
  });

  it('decide：拒绝路径 + 重复裁决 409', async () => {
    const { dto, settled } = approvals.begin({ sessionId, command: 'kb.cancel', risk: 'mutate', argsSummary: '{"buildId":"b1"}' });
    const rejected = await call('POST', `/api/agent/sessions/${sessionId}/approvals/${dto.id}/decide`, { decision: 'reject' });
    expect(rejected.status).toBe(200);
    expect(rejected.json).toEqual({ id: dto.id, decision: 'reject' });
    await expect(settled).resolves.toBe('reject');

    const again = await call('POST', `/api/agent/sessions/${sessionId}/approvals/${dto.id}/decide`, { decision: 'approve' });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('approval_already_decided');
  });

  it('decide：非法 decision → 400；未知 approvalId → 404；未知会话 → 404', async () => {
    const { dto } = approvals.begin({ sessionId, command: 'kb.build', risk: 'mutate', argsSummary: '{}' });
    const invalid = await call('POST', `/api/agent/sessions/${sessionId}/approvals/${dto.id}/decide`, { decision: 'later' });
    expect(invalid.status).toBe(400);
    expect(invalid.json.error).toBe('invalid_request');

    const missing = await call('POST', `/api/agent/sessions/${sessionId}/approvals/apr_none/decide`, { decision: 'approve' });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe('approval_not_found');

    const missingSession = await call('POST', `/api/agent/sessions/s_none/approvals/${dto.id}/decide`, { decision: 'approve' });
    expect(missingSession.status).toBe(404);

    approvals.decide(sessionId, dto.id, 'reject'); // 清场
  });

  it('run_end（会话 SSE）→ pending 批准被取消（接线验证）', async () => {
    const { dto, settled } = approvals.begin({ sessionId, command: 'clean.orphans', risk: 'destructive', argsSummary: '{"apply":true}' });
    // 模拟 run 结束（index.ts：sessionService.on('sse') 监听 run_end）
    sessions.emitSse(sessionId, 'run_end', { runId: 'run_x', outcome: 'completed' });
    await expect(settled).resolves.toBe('cancelled');
    const resolved = sseEvents(sessionId, 'approval_resolved').at(-1);
    expect(resolved?.data).toEqual({ id: dto.id, decision: 'cancelled' });
    const listed = await call('GET', `/api/agent/sessions/${sessionId}/approvals`);
    expect(listed.json.approvals).toEqual([]);
  });
});
