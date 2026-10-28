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

/** 构造 ops 工具族（S1 registerToolFamily 追加模型；index.ts 注册）。 */
export function createOpsToolFamily(deps: OpsFamilyDeps): AgentToolFamily {
  const findCommand = deps.findCommand ?? findOpsCommand;
  const maxChars = deps.resultMaxChars ?? DEFAULT_RESULT_MAX_CHARS;
  return {
    name: 'ops',
    tools: [{
      spec: APP_COMMAND_SPEC,
      runKinds: ['discuss', 'work'],
      execute: async (context: InternalRunContext, args: Record<string, unknown>): Promise<ToolResult> => {
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
        let specs: OpsRequestSpec[];
        try {
          specs = def.request(filled);
        } catch (error) {
          if (error instanceof OpsArgumentError) {
            throw new ToolError(error.code, error.message, 400);
          }
          throw error;
        }

        const runSpecs = async (): Promise<ToolResult> => {
          // 确认值注入：仅在用户批准后到达这里。request() 派生后的 body
          // 原样转发（T3b-05：source.push 等命令按 allowOverwrite/force
          // 派生 PUSH/OVERWRITE_CLOUD，不能被表基线值覆盖）；表登记字段
          // 缺失时（未来漏烘条目）才补注入基线值。
          if (def.confirm) {
            for (const spec of specs) {
              if (spec.method !== 'GET' && spec.body && typeof spec.body === 'object' && !Array.isArray(spec.body)) {
                const body = spec.body as Record<string, unknown>;
                if (body[def.confirm.field] === undefined) {
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
        const sessionId = context.sessionId ?? '';
        if (!sessionId) {
          throw new ToolError('invalid_request', 'app_command 写级命令需要会话上下文', 400);
        }
        const { settled } = deps.approvals.begin({
          sessionId,
          command: def.name,
          risk: def.risk,
          argsSummary: JSON.stringify(sanitized).slice(0, 400),
          preview: {
            summary: def.summary,
            ...(def.confirm ? { confirmField: def.confirm.field, confirmValue: def.confirm.value } : {}),
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
        // T3b-07：批准后、执行前复核运行状态——停止请求已进入（aborting）
        // 或运行已结束（idle，settled 延迟窗口）时不执行，迟到批准按取消
        // 处理；与 abort 入口即时撤销 pending 批准共同关闭「停止后仍执行」
        // 窗口。
        const runState = deps.sessionRunState?.(sessionId);
        if (runState === 'aborting' || runState === 'idle') {
          throw new ToolError('approval_cancelled', `会话已停止，命令 ${def.name} 的批准已失效，不再执行`, 409);
        }
        return runSpecs();
      },
    }],
  };
}
