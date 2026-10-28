/**
 * ApprovalService 单元测试（S10，设计 kb-agent-upgrade §6.5）
 *
 * 覆盖：批准请求产生（DTO 形状 + SSE 事件 + 审计行）、用户裁决
 * approve/reject、重复裁决 409、跨会话 404、超时、会话结束取消、
 * pending 列表。全部内存 + 临时目录，无 HTTP。每用例独立 sessionId
 * （审计文件按会话分文件，互不串行）。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalService, type ApprovalEmitFn } from '../src/agent/approvals/approval-service.js';
import { ToolError } from '../src/agent/agent-tool-service.js';

interface Emitted { sessionId: string; event: string; data: unknown }

let dataRoot: string;
let emitted: Emitted[];
let emit: ApprovalEmitFn;
let service: ApprovalService;
let seq = 0;

function nextSession(): string {
  seq += 1;
  return `s_test_${seq}`;
}

function auditLines(sessionId: string): Array<Record<string, unknown>> {
  const file = path.join(dataRoot, 'agent', 'audit', `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-svc-'));
  emitted = [];
  emit = (sessionId, event, data) => { emitted.push({ sessionId, event, data }); };
  service = new ApprovalService({ dataRoot, timeoutMs: 10_000, emit });
});

afterEach(() => {
  service.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function begin(sessionId: string, command = 'kb.build', risk: 'mutate' | 'destructive' | 'remote_write' = 'mutate') {
  return service.begin({
    sessionId,
    command,
    risk,
    argsSummary: '{"mode":"full"}',
    preview: { summary: '发起标准库构建' },
  });
}

describe('ApprovalService 批准生命周期', () => {
  it('begin：登记 pending、发 approval_request（完整 DTO 形状）、写审计行', () => {
    const SESSION = nextSession();
    const before = Date.now();
    const { dto } = begin(SESSION);
    expect(dto.id).toMatch(/^apr_/);
    expect(dto.sessionId).toBe(SESSION);
    expect(dto.command).toBe('kb.build');
    expect(dto.risk).toBe('mutate');
    expect(dto.argsSummary).toBe('{"mode":"full"}');
    expect(dto.preview).toEqual({ summary: '发起标准库构建' });
    expect(Date.parse(dto.expiresAt)).toBeGreaterThanOrEqual(before + 9_000);

    expect(service.listPending(SESSION)).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ sessionId: SESSION, event: 'approval_request' });
    expect(emitted[0].data).toEqual(dto);

    const lines = auditLines(SESSION);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      sessionId: SESSION,
      tool: 'app_command',
      path: 'kb.build',
      result: 'approval_requested',
      risk: 'mutate',
    });
  });

  it('decide approve：settled 解析 approve、发 approval_resolved、pending 清空', async () => {
    const SESSION = nextSession();
    const { dto, settled } = begin(SESSION);
    const decided = service.decide(SESSION, dto.id, 'approve');
    expect(decided.id).toBe(dto.id);
    await expect(settled).resolves.toBe('approve');
    expect(service.listPending(SESSION)).toHaveLength(0);
    expect(emitted.map((item) => item.event)).toEqual(['approval_request', 'approval_resolved']);
    expect(emitted[1].data).toEqual({ id: dto.id, decision: 'approve' });
    const lines = auditLines(SESSION);
    expect(lines.map((line) => line.result)).toEqual(['approval_requested', 'approval_approved']);
  });

  it('decide reject：settled 解析 reject + 审计', async () => {
    const SESSION = nextSession();
    const { dto, settled } = begin(SESSION);
    service.decide(SESSION, dto.id, 'reject');
    await expect(settled).resolves.toBe('reject');
    expect(auditLines(SESSION).map((line) => line.result)).toEqual(['approval_requested', 'approval_rejected']);
  });

  it('重复裁决 → 409 approval_already_decided', () => {
    const SESSION = nextSession();
    const { dto } = begin(SESSION);
    service.decide(SESSION, dto.id, 'approve');
    try {
      service.decide(SESSION, dto.id, 'reject');
      expect.unreachable('重复裁决应被拒绝');
    } catch (error) {
      expect((error as ToolError).code).toBe('approval_already_decided');
      expect((error as ToolError).status).toBe(409);
    }
  });

  it('跨会话裁决 / 未知 id → 404 approval_not_found', () => {
    const SESSION = nextSession();
    const { dto } = begin(SESSION);
    try {
      service.decide('s_other', dto.id, 'approve');
      expect.unreachable('跨会话裁决应被拒绝');
    } catch (error) {
      expect((error as ToolError).code).toBe('approval_not_found');
      expect((error as ToolError).status).toBe(404);
    }
    expect(() => service.decide(SESSION, 'apr_nope', 'approve')).toThrowError(ToolError);
  });

  it('decide 非法 decision → 400（服务层守卫，路由层另有一道）', () => {
    const SESSION = nextSession();
    const { dto } = begin(SESSION);
    expect(() => service.decide(SESSION, dto.id, 'later' as 'approve')).toThrowError(/approve/);
    expect(service.listPending(SESSION)).toHaveLength(1);
  });

  it('超时：settled 解析 timeout、发 approval_resolved(decision=timeout)、写审计', async () => {
    const SESSION = nextSession();
    const short = new ApprovalService({ dataRoot, timeoutMs: 25, emit });
    const { settled, dto } = short.begin({ sessionId: SESSION, command: 'clean.trash.purge', risk: 'destructive', argsSummary: '{}' });
    await expect(settled).resolves.toBe('timeout');
    expect(emitted[emitted.length - 1]).toMatchObject({ event: 'approval_resolved' });
    expect(emitted[emitted.length - 1].data).toEqual({ id: dto.id, decision: 'timeout' });
    expect(short.listPending(SESSION)).toHaveLength(0);
    expect(auditLines(SESSION).map((line) => line.result)).toEqual(['approval_requested', 'approval_timeout']);
    short.close();
  });

  it('cancelForSession：会话结束取消全部 pending（其他会话不受影响）', async () => {
    const SESSION = nextSession();
    const OTHER = nextSession();
    const a1 = begin(SESSION);
    const a2 = service.begin({ sessionId: SESSION, command: 'kb.cancel', risk: 'mutate', argsSummary: '{"buildId":"b1"}' });
    service.begin({ sessionId: OTHER, command: 'kb.build', risk: 'mutate', argsSummary: '{}' });
    const cancelled = service.cancelForSession(SESSION);
    expect(cancelled).toBe(2);
    await expect(a1.settled).resolves.toBe('cancelled');
    await expect(a2.settled).resolves.toBe('cancelled');
    expect(service.listPending(SESSION)).toHaveLength(0);
    expect(service.listPending(OTHER)).toHaveLength(1);
    expect(emitted.filter((item) => item.event === 'approval_resolved'))
      .toEqual(expect.arrayContaining([
        { sessionId: SESSION, event: 'approval_resolved', data: { id: a1.dto.id, decision: 'cancelled' } },
      ]));
  });

  it('close：全部 pending 取消且不悬挂', async () => {
    const SESSION = nextSession();
    const { settled } = begin(SESSION);
    service.close();
    await expect(settled).resolves.toBe('cancelled');
    expect(service.pendingCount()).toBe(0);
  });
});
