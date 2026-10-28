/**
 * ApprovalService — app_command 会话内批准流（设计 kb-agent-upgrade §6.5）
 *
 * mutate/destructive/remote_write 级命令执行前挂起：产生批准请求（会话
 * SSE 事件 approval_request）→ 用户在界面批准/拒绝 → 挂起的工具调用继续
 * 或以 approval_rejected 失败；10 分钟无人处理或会话结束（run_end）→
 * approval_timeout / approval_cancelled。确认只能来自人类点击——模型传入
 * 的 confirm 参数在工具层已被剔除（app-command-family.ts）。
 *
 * 审计：批准生命周期逐条追加 <dataRoot>/agent/audit/<sessionId>.jsonl
 * （基线 §9.6 会话审计文件；行格式与 AgentToolService.auditWork 同构：
 * 时间、工具、路径、字节数、结果，附加 approval 专用字段）。
 *
 * 内存态：pending 批准不落库——它们的生命周期上限就是一次工具调用
 * （≤10 分钟），server 重启后 pi 运行也随之失效，不存在需要恢复的状态。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from '../agent-tool-service.js';
import type { OpsRisk } from '../../ops/command-table.js';

/** 用户可表达的裁决（decide API 只接受前两个；后两个由超时/会话结束触发）。 */
export type ApprovalDecision = 'approve' | 'reject' | 'timeout' | 'cancelled';

/** 设计 §6.5 ApprovalRequestDto（SSE approval_request 事件负载 + GET 列表项）。 */
export interface ApprovalRequestDto {
  id: string;
  sessionId: string;
  command: string;
  risk: OpsRisk;
  argsSummary: string;
  preview?: unknown;
  expiresAt: string;
}

interface PendingApproval {
  dto: ApprovalRequestDto;
  decided: boolean;
  resolve: (decision: ApprovalDecision) => void;
  settled: Promise<ApprovalDecision>;
  timer: NodeJS.Timeout;
}

export interface ApprovalEmitFn {
  (sessionId: string, event: 'approval_request' | 'approval_resolved', data: unknown): void;
}

export interface ApprovalServiceDeps {
  dataRoot: string;
  /** 批准等待上限；缺省 10 分钟（设计 §6.5）。 */
  timeoutMs?: number;
  /** SSE 事件出口（index.ts 接到 SessionService.emitSse，并入会话流）。 */
  emit?: ApprovalEmitFn;
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** 审计行 result 后缀（用户裁决用过去时，超时/取消用名词）。 */
const AUDIT_RESULT: Record<ApprovalDecision, string> = {
  approve: 'approved',
  reject: 'rejected',
  timeout: 'timeout',
  cancelled: 'cancelled',
};

export class ApprovalService {
  private readonly dataRoot: string;
  private readonly timeoutMs: number;
  private readonly emit?: ApprovalEmitFn;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(deps: ApprovalServiceDeps) {
    this.dataRoot = deps.dataRoot;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.emit = deps.emit;
  }

  /**
   * 产生批准请求：登记 pending、发 approval_request SSE、启动超时计时。
   * 返回 DTO 与裁决 Promise——工具调用挂起等待该 Promise。
   */
  begin(input: {
    sessionId: string;
    command: string;
    risk: OpsRisk;
    argsSummary: string;
    preview?: unknown;
  }): { dto: ApprovalRequestDto; settled: Promise<ApprovalDecision> } {
    const id = `apr_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
    const dto: ApprovalRequestDto = {
      id,
      sessionId: input.sessionId,
      command: input.command,
      risk: input.risk,
      argsSummary: input.argsSummary,
      ...(input.preview !== undefined ? { preview: input.preview } : {}),
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
    };
    let resolve!: (decision: ApprovalDecision) => void;
    const settled = new Promise<ApprovalDecision>((res) => { resolve = res; });
    const timer = setTimeout(() => {
      this.settle(id, 'timeout');
    }, this.timeoutMs);
    timer.unref?.();
    this.pending.set(id, { dto, decided: false, resolve, settled, timer });
    this.emit?.(dto.sessionId, 'approval_request', dto);
    this.audit(dto.sessionId, {
      path: dto.command,
      result: 'approval_requested',
      risk: dto.risk,
      argsSummary: dto.argsSummary,
    });
    return { dto, settled };
  }

  /** 用户裁决（POST …/decide）。只接受 approve/reject；裁决后不可更改。 */
  decide(sessionId: string, approvalId: string, decision: 'approve' | 'reject'): ApprovalRequestDto {
    if (decision !== 'approve' && decision !== 'reject') {
      throw new ToolError('invalid_request', "decision 必须是 'approve' 或 'reject'", 400);
    }
    const record = this.pending.get(approvalId);
    if (!record || record.dto.sessionId !== sessionId) {
      throw new ToolError('approval_not_found', '批准请求不存在（可能已裁决、超时或会话已结束）', 404);
    }
    if (record.decided) {
      throw new ToolError('approval_already_decided', '该批准请求已有裁决', 409);
    }
    this.settle(approvalId, decision);
    return record.dto;
  }

  /** GET /api/agent/sessions/:id/approvals —— 会话当前待裁决列表。 */
  listPending(sessionId: string): ApprovalRequestDto[] {
    const result: ApprovalRequestDto[] = [];
    for (const record of this.pending.values()) {
      if (!record.decided && record.dto.sessionId === sessionId) result.push(record.dto);
    }
    return result;
  }

  /**
   * 会话结束（run_end/中止）：该会话全部 pending 置 cancelled——挂起的
   * 工具调用立即失败，防止「运行已停、批准迟到仍执行命令」。
   */
  cancelForSession(sessionId: string): number {
    let cancelled = 0;
    for (const [id, record] of this.pending) {
      if (!record.decided && record.dto.sessionId === sessionId) {
        this.settle(id, 'cancelled');
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /** 关闭（server close）：全部 pending 以 cancelled 收尾，不留悬挂计时器。 */
  close(): void {
    for (const [id, record] of [...this.pending]) {
      if (!record.decided) this.settle(id, 'cancelled');
    }
  }

  pendingCount(): number {
    let count = 0;
    for (const record of this.pending.values()) {
      if (!record.decided) count += 1;
    }
    return count;
  }

  /** 已裁决记录保留在表中（decided=true）：重复裁决给 409 而非 404，
 * 用户双击/双开页时可辨；体量为人控小事件，不设淘汰。 */
  private settle(id: string, decision: ApprovalDecision): void {
    const record = this.pending.get(id);
    if (!record || record.decided) return;
    record.decided = true;
    clearTimeout(record.timer);
    record.resolve(decision);
    this.emit?.(record.dto.sessionId, 'approval_resolved', { id, decision });
    this.audit(record.dto.sessionId, {
      path: record.dto.command,
      result: `approval_${AUDIT_RESULT[decision]}`,
      risk: record.dto.risk,
    });
  }

  /**
   * app_command 审计行（批准生命周期 + 执行结果共用）：追加
   * <dataRoot>/agent/audit/<sessionId>.jsonl，格式与既有 Work 写审计
   * 同构（at/sessionId/tool/path/bytes/result），失败不阻断工具。
   */
  audit(sessionId: string, entry: { path: string; result: string; bytes?: number } & Record<string, unknown>): void {
    if (!sessionId) return;
    try {
      const auditDir = path.join(this.dataRoot, 'agent', 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      const line = JSON.stringify({
        at: new Date().toISOString(),
        sessionId,
        tool: 'app_command',
        bytes: entry.bytes ?? 0,
        ...entry,
      });
      fs.appendFileSync(path.join(auditDir, `${sessionId}.jsonl`), `${line}\n`);
    } catch {
      /* 审计失败不阻断批准流（与 auditWork 同策略） */
    }
  }
}
