/**
 * ops 工具族 — app_command（设计 kb-agent-upgrade §6.5 / U14/U15）
 *
 * 命令表（ops/command-table.ts，S8）是 CLI 与 app_command 共用的唯一
 * 数据面：本族只做命令裁决 + 批准编排 + 进程内执行，不发明路由。
 *
 * 裁决顺序（每一步 fail fast）：
 *   1. 命令存在且 agentExposed（含秘密的命令不对 Agent 暴露）；
 *   2. Discuss 会话只见 read 级——非 read 直接 403，不产生批准请求；
 *   3. args 按命令表 JSON Schema 轻校验（required + 声明属性类型）；
 *   4. **模型传入的 confirm/confirmation 一律剔除**（防提示注入自我批准）；
 *      确认值只由 server 在用户批准后注入请求体；
 *   5. read 级直接执行；mutate/destructive/remote_write 经
 *      ApprovalService 挂起等待用户批准（拒绝/超时/会话结束 → 工具错误）。
 *
 * 执行与 S8 CLI 执行器同构：app.request() 携 desktop token 穿透目标
 * 路由的鉴权（不走网络），复用既有路由全部校验/错误语义；结果 JSON
 * 截断 ≤20000 字符（设计 §6.5）。多步命令逐步执行、按 key 聚合。
 */

import type { Hono } from 'hono';
import { ToolError, type AgentToolFamily, type ToolResult, type InternalRunContext } from '../agent-tool-service.js';
import { APP_COMMAND_SPEC } from '../tool-specs.js';
import { ApprovalService } from '../approvals/approval-service.js';
import {
  OpsArgumentError,
  findOpsCommand,
  type OpsCommandDef,
  type OpsRequestSpec,
} from '../../ops/command-table.js';
import type { Config } from '../../types/index.js';

export interface OpsFamilyDeps {
  approvals: ApprovalService;
  /** 进程内转发用的 Hono app（index.ts 挂载后回填；与 cliRoutes 同模式）。 */
  getApp: () => Hono | undefined;
  /** buildServer 生成的 desktop token（转发穿透目标路由鉴权）。 */
  desktopToken: string;
  configProvider: () => Config | null;
  /** 命令查找（缺省真实命令表；测试可注入 mock 表条目验证接线）。 */
  findCommand?: (name: string) => OpsCommandDef | undefined;
  /** 结果 JSON 截断上限（设计 §6.5：20000）。 */
  resultMaxChars?: number;
  /**
   * T3b-07：会话运行状态复核（批准后、执行前）。返回 'aborting'（停止
   * 已请求）或 'idle'（运行已结束）时不执行——迟到批准按取消处理。
   * 缺省不复核（非会话内调用/测试场景）。
   */
  sessionRunState?: (sessionId: string) => 'running' | 'aborting' | 'idle';
  /**
   * T3b-07R：toolCallId → 所属 runId（server 权威轮次归属，由
   * SessionService 从 pi tool_execution_start 事件记录）。与
   * currentRunId 同时注入时启用跨轮迟到请求拒绝；缺省不绑定（测试/
   * 非会话场景）。
   */
  toolCallRun?: (sessionId: string, toolCallId: string) => string | null;
  /** T3b-07R：会话当前可执行轮 runId；无活跃运行返回 null。 */
  currentRunId?: (sessionId: string) => string | null;
  approvalMode?: (sessionId: string) => 'ask' | 'auto';
  /**
   * T3e-R3-02：会话停止信号（批准后异步复核链取消源）。停止请求时
   * 触发——复核 preview 挂起期间立即按停止处理，不等它返回。缺省不
   * 取消（非会话内调用/测试场景）。
   */
  sessionAbortSignal?: (sessionId: string) => AbortSignal | undefined;
}

const DEFAULT_RESULT_MAX_CHARS = 20_000;

/** 顶层注入面：模型传入即剔除的确认字段（含命令表登记字段）。 */
const CONFIRM_FIELDS = ['confirm', 'confirmation'] as const;

/**
 * 剔除模型 args 中的确认字段（纯函数，导出供单测锚定）：
 * 命令登记的 confirm.field + 通用 confirm/confirmation 全部删除——
 * 确认只能来自人类在界面上的批准。
 */
export function stripConfirmArgs(def: OpsCommandDef, args: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  const banned = new Set<string>(CONFIRM_FIELDS);
  if (def.confirm) banned.add(def.confirm.field);
  for (const [key, value] of Object.entries(args)) {
    if (!banned.has(key)) stripped[key] = value;
  }
  return stripped;
}

/** args 按命令表 JSON Schema 轻校验（与 S8 CLI 执行器同口径）。 */
export function validateOpsArgs(def: OpsCommandDef, args: Record<string, unknown>): void {
  for (const key of def.params.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) {
      throw new ToolError('invalid_args', `命令 ${def.name} 缺少必填参数 ${key}`, 400);
    }
  }
  for (const [key, schema] of Object.entries(def.params.properties)) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    const value = args[key];
    if (value === undefined || value === null) continue;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (actual !== schema.type) {
      throw new ToolError('invalid_args', `命令 ${def.name} 参数 ${key} 必须是 ${schema.type}（实际 ${actual}）`, 400);
    }
  }
}

/** JSON 序列化并截断（≤maxChars；截断时尾部标记）。 */
export function truncateJson(value: unknown, maxChars = DEFAULT_RESULT_MAX_CHARS): string {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(结果超过 ${maxChars} 字符已截断)`;
}

async function executeSpecs(
  deps: OpsFamilyDeps,
  specs: OpsRequestSpec[],
): Promise<{ data: unknown; httpStatus: number }> {
  const app = deps.getApp();
  if (!app) {
    throw new ToolError('server_not_ready', '服务尚未完成挂载', 503);
  }
  const results: Array<{ spec: OpsRequestSpec; status: number; json: unknown }> = [];
  for (const spec of specs) {
    const query = spec.query && Object.keys(spec.query).length > 0
      ? `?${new URLSearchParams(spec.query).toString()}`
      : '';
    const hasBody = spec.body !== undefined && spec.method !== 'GET';
    const response = await app.request(new Request(`http://127.0.0.1${spec.path}${query}`, {
      method: spec.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Desktop-Token': deps.desktopToken,
      },
      ...(hasBody ? { body: JSON.stringify(spec.body) } : {}),
    }));
    const json = await response.json().catch(() => null);
    results.push({ spec, status: response.status, json });
  }
  if (results.length === 1) {
    const only = results[0];
    if (only.status >= 400) {
      const err = only.json && typeof only.json === 'object' ? only.json as { error?: unknown; message?: unknown } : {};
      throw new ToolError(
        typeof err.error === 'string' ? err.error : 'upstream_error',
        typeof err.message === 'string' ? err.message : `目标路由返回 ${only.status}`,
        only.status >= 400 && only.status <= 599 ? only.status : 502,
      );
    }
    return { data: only.json, httpStatus: only.status };
  }
  // 多步聚合（status 等）：每步独立成败，失败步保留错误面（与 S8 一致）。
  const data: Record<string, unknown> = {};
  results.forEach((result, index) => {
    const key = result.spec.key ?? `step${index + 1}`;
    data[key] = result.status < 400
      ? result.json
      : {
        ok: false,
        error: result.json && typeof result.json === 'object'
          && typeof (result.json as { error?: unknown }).error === 'string'
          ? (result.json as { error: string }).error
          : 'upstream_error',
        httpStatus: result.status,
      };
  });
  return { data, httpStatus: 200 };
}
/**
 * T3e-R3-02：可取消的复核调用——批准后复核 preview 挂起期间停止信号
 * 触发时立即按停止处理（底层 preview 只读、结果弃置），不再等它返回
 * 后派发写入。信号未触发则透传原结果/错误。
 */
async function raceAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  commandName: string,
): Promise<T> {
  if (!signal) return promise;
  const cancelled = () => new ToolError(
    'approval_cancelled',
    `会话已停止，命令 ${commandName} 的批准已失效，不再执行`,
    409,
  );
  if (signal.aborted) throw cancelled();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/** 构造 ops 工具族（S1 registerToolFamily 追加模型；index.ts 注册）。 */
export function createOpsToolFamily(deps: OpsFamilyDeps): AgentToolFamily {
  const findCommand = deps.findCommand ?? findOpsCommand;
  const maxChars = deps.resultMaxChars ?? DEFAULT_RESULT_MAX_CHARS;
  return {
    name: 'ops',
    tools: [{
      spec: APP_COMMAND_SPEC,
      runKinds: ['discuss', 'work'],
      execute: async (
        context: InternalRunContext,
        args: Record<string, unknown>,
        meta?: { toolCallId?: string },
      ): Promise<ToolResult> => {
        const commandName = typeof args.command === 'string' ? args.command : '';
        if (!commandName) {
          throw new ToolError('invalid_request', 'command 必须是非空字符串');
        }
        const def = findCommand(commandName);
        if (!def) {
          throw new ToolError('unknown_command', `未知命令 ${commandName}`, 404);
        }
        if (!def.agentExposed) {
          throw new ToolError('command_not_allowed', `命令 ${commandName} 不对 Agent 暴露`, 403);
        }
        // Discuss 只见 read 级：非 read 在产生任何批准请求前拒绝。
        if (context.runKind !== 'work' && def.risk !== 'read') {
          throw new ToolError('command_not_allowed', `Discuss 会话只能执行 read 级命令（${commandName} 为 ${def.risk} 级，需 Work 会话并经用户批准）`, 403);
        }
        const rawArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
          ? args.args as Record<string, unknown>
          : {};
        const sanitized = stripConfirmArgs(def, rawArgs);
        validateOpsArgs(def, sanitized);
        const config = deps.configProvider();
        const filled = def.fillDefaults ? def.fillDefaults(sanitized, { config }) : sanitized;
        // T3e-R3-02：sessionId 提前到批准流之前（本轮可执行复核闭包用）。
        const sessionId = context.sessionId ?? '';
        // T3b-07R：工具请求绑定的 server 权威轮次（Work 分支赋值；
        // confirmPlan 复核闭包在调用时已赋值）。
        let requestRunId: string | null = null;
        /**
         * T3e-R3-02：本轮可执行复核（停止请求/运行结束/换轮均不可执行）
         *——批准后与异步复核 preview 完成后各查一次（同一判定两处使用，
         * 关闭「批准后异步窗口内停止/换轮仍写入」）。
         */
        const assertRoundExecutable = (): void => {
          const runState = deps.sessionRunState?.(sessionId);
          if (runState === 'aborting' || runState === 'idle') {
            throw new ToolError('approval_cancelled', `会话已停止，命令 ${def.name} 的批准已失效，不再执行`, 409);
          }
          if (requestRunId !== null && deps.currentRunId && deps.currentRunId(sessionId) !== requestRunId) {
            throw new ToolError(
              'approval_round_expired',
              `命令 ${def.name} 的批准所属运行已结束，不再执行`,
              409,
            );
          }
        };
        let specs: OpsRequestSpec[];
        try {
          specs = def.request(filled);
        } catch (error) {
          if (error instanceof OpsArgumentError) {
            throw new ToolError(error.code, error.message, 400);
          }
          throw error;
        }

        // T3d-05R：server 权威确认值——挂 confirmPlan 的命令在批准前经
        // 内部 preview 请求取得权威 push plan，按实际 mode/force 派生确认值
        //（不再由命令表静态参数猜测）；批准卡展示与执行注入同一派生值。
        let confirmValue: string | undefined = def.confirm?.value;
        let approvedPlanKey: string | null = null;
        if (def.confirmPlan) {
          const previewSpecs = def.confirmPlan.previewSpecs(filled);
          const { data: previewJson } = await executeSpecs(deps, previewSpecs);
          try {
            confirmValue = def.confirmPlan.deriveConfirm(previewJson, filled);
          } catch (error) {
            if (error instanceof OpsArgumentError) {
              throw new ToolError(error.code, error.message, 400);
            }
            throw error;
          }
          approvedPlanKey = def.confirmPlan.planKey(previewJson);
        }

        const runSpecs = async (): Promise<ToolResult> => {
          // 确认值注入：仅在用户批准后到达这里。confirmPlan 命令强制注入
          // 派生值（覆盖 request() 的静态猜测）；其余命令仅在表登记字段
          // 缺失时（未来漏烘条目）补注入基线值。
          if (def.confirm) {
            if (def.confirmPlan) {
              // T3d-05R：计划过期复核——批准期间权威 plan 变化（如 append
              // 变 overwrite）则旧批准的确认语义不再成立，拒执行（重新
              // 发起命令即重新批准）。T3e-R3-02：复核 preview 可取消——
              // 挂起期间停止信号触发立即按停止处理；preview 完成后、派发
              // mutation 紧前再复核本轮可执行（停止/换轮均拒）。
              const { data: recheckJson } = await raceAbortSignal(
                executeSpecs(deps, def.confirmPlan.previewSpecs(filled)),
                deps.sessionAbortSignal?.(sessionId),
                def.name,
              );
              assertRoundExecutable();
              if (def.confirmPlan.planKey(recheckJson) !== approvedPlanKey) {
                throw new ToolError(
                  'approval_plan_expired',
                  `命令 ${def.name} 的批准已过期（推送计划在批准期间发生变化），请重新发起以重新批准`,
                  409,
                );
              }
            }
            for (const spec of specs) {
              if (spec.method !== 'GET' && spec.body && typeof spec.body === 'object' && !Array.isArray(spec.body)) {
                const body = spec.body as Record<string, unknown>;
                if (def.confirmPlan) {
                  body[def.confirm.field] = confirmValue;
                } else if (body[def.confirm.field] === undefined) {
                  body[def.confirm.field] = def.confirm.value;
                }
              }
            }
          }
          const { data, httpStatus } = await executeSpecs(deps, specs);
          deps.approvals.audit(context.sessionId ?? '', {
            path: def.name,
            result: 'executed',
            risk: def.risk,
            httpStatus,
          });
          return {
            content: [{ type: 'text', text: truncateJson(data, maxChars) }],
            details: { command: def.name, risk: def.risk, httpStatus },
          };
        };

        // read 级直通（Discuss/Work 均不产生批准）。
        if (def.risk === 'read') {
          return runSpecs();
        }

        // Work 会话：非 read 级挂起等待用户批准。
        if (!sessionId) {
          throw new ToolError('invalid_request', 'app_command 写级命令需要会话上下文', 400);
        }
        // T3b-07R：工具请求绑定 server 权威轮次——toolCallId 所属轮已结束
        //（或换轮）的迟到请求在此拒绝，不产生批准请求；旧轮批准不能被
        //「新轮正在跑」洗白。（requestRunId 在 confirmPlan 复核闭包声明，
        // 此处赋值。）
        if (deps.toolCallRun && deps.currentRunId) {
          const toolCallId = meta?.toolCallId ?? '';
          if (toolCallId) {
            requestRunId = deps.toolCallRun(sessionId, toolCallId);
            const current = deps.currentRunId(sessionId);
            if (!requestRunId || requestRunId !== current) {
              throw new ToolError(
                'stale_tool_request',
                `命令 ${def.name} 的工具请求所属运行已结束（跨轮迟到请求不再可执行）`,
                409,
              );
            }
          }
        }
        if (deps.approvalMode?.(sessionId) === 'auto') {
          assertRoundExecutable();
          deps.approvals.audit(sessionId, { path: def.name, result: 'auto_approved', risk: def.risk });
          return runSpecs();
        }
        const { settled } = deps.approvals.begin({
          sessionId,
          command: def.name,
          risk: def.risk,
          argsSummary: JSON.stringify(sanitized).slice(0, 400),
          ...(requestRunId !== null ? { runId: requestRunId } : {}),
          preview: {
            summary: def.summary,
            ...(def.confirm
              ? { confirmField: def.confirm.field, confirmValue: confirmValue ?? def.confirm.value }
              : {}),
          },
        });
        const decision = await settled;
        if (decision !== 'approve') {
          if (decision === 'reject') {
            throw new ToolError('approval_rejected', `用户拒绝执行命令 ${def.name}`, 403);
          }
          if (decision === 'timeout') {
            throw new ToolError('approval_timeout', `命令 ${def.name} 等待批准超时（10 分钟无人处理）`, 408);
          }
          throw new ToolError('approval_cancelled', `会话已结束，命令 ${def.name} 的批准请求已取消`, 409);
        }
        // T3b-07 + T3b-07R + T3e-R3-02：批准后、执行前复核本轮可执行
        //（aborting/idle/换轮均不执行）；confirmPlan 命令在异步复核
        // preview 完成后会再查一次（runSpecs 内 assertRoundExecutable）。
        assertRoundExecutable();
        return runSpecs();
      },
    }],
  };
}
