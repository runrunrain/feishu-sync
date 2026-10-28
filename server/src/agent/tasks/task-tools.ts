/**
 * task_* 工具族（S6，设计 kb-agent-upgrade §5.2）—— 经 S1 registerToolFamily
 * 注册；仅编排启用的 Discuss/Work 会话可见（SessionService 在编排关闭时
 * 按 TASK_TOOL_FAMILY_NAME 整族剔除，pi --tools 参数面同步收窄）。
 * 子任务运行（runKind='task'）不在本族 runKinds 内，永不获得 task_*。
 */

import {
  ToolError,
  type AgentToolFamily,
  type InternalRunContext,
  type ToolResult,
} from '../agent-tool-service.js';
import {
  TASK_CANCEL_SPEC,
  TASK_QUERY_SPEC,
  TASK_RESUME_SPEC,
  TASK_SUBMIT_SPEC,
} from '../tool-specs.js';
import type { TaskService, TaskStoreApi } from './task-service.js';

/**
 * Leader 编排提示正文（内置插件条目「任务编排」的默认 content，可经
 * 插件 overrides 覆盖；启用后随插件快照注入 Discuss/Work 会话上下文）。
 */
export const LEADER_ORCHESTRATION_PROMPT = [
  '你已启用任务编排（Leader）：可以把独立的分析、转换、审校工作派发为后台子任务并行执行。',
  '',
  '工具使用：',
  '- task_submit：派发子任务。role 选角色（kb-analyst 分析 / kb-converter 转换写入 / kb-reviewer 审校）；task 文本必须自包含（子任务看不到本对话历史），写清目标、输入材料与期望产出；转换写入类任务必须给 outputDir（Workspace 相对目录，子任务写入被限制在该目录内）。',
  '- task_query：查询任务状态；wait 可阻塞等待任一/全部任务落定。任务 blocked 表示它在等用户回答问题——把 questions 原样转呈用户，不要自行猜测作答。',
  '- task_resume：把用户对阻塞问题的答复转发给对应任务使其继续。',
  '- task_cancel：取消不再需要的任务。',
  '',
  '纪律：',
  '- 每个子任务一轮只做一件事；需要多步时拆成多个任务或自己直接做。',
  '- 子任务是受限执行者；「做什么、怎么裁定」由你和用户决定，不外包给子任务。',
  '- 结果以子任务最终回复为准；与其结论冲突时先核对材料，不盲信也不静默改写。',
  '- 构建或重建标准库只能经 app_command kb.build 触发，不要让子任务手工拼装标准库发布。',
].join('\n');

function jsonString(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function requireString(args: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ToolError('invalid_request', `${key} 必须是 ${min}..${max} 字符的字符串`);
  }
  return value;
}

/** task_query 的 wait 参数解析。 */
function parseWait(args: Record<string, unknown>): { mode: 'any' | 'all'; timeoutSeconds: number } | null {
  const wait = args.wait;
  if (wait === undefined || wait === null) return null;
  if (!wait || typeof wait !== 'object' || Array.isArray(wait)) {
    throw new ToolError('invalid_request', 'wait 必须是 { mode, timeoutSeconds }');
  }
  const { mode, timeoutSeconds } = wait as { mode?: unknown; timeoutSeconds?: unknown };
  if (mode !== 'any' && mode !== 'all') {
    throw new ToolError('invalid_request', "wait.mode 必须是 'any' 或 'all'");
  }
  if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
    throw new ToolError('invalid_request', 'wait.timeoutSeconds 必须是 1..600 的整数');
  }
  return { mode, timeoutSeconds };
}

export function taskToolFamily(deps: { service: TaskService; store: TaskStoreApi }): AgentToolFamily {
  /** task_* 只属于编排启用的 Discuss/Work 父会话运行（白名单外早已 403）。 */
  const requireParentSession = (context: InternalRunContext): string => {
    if (!context.sessionId || (context.runKind !== 'discuss' && context.runKind !== 'work')) {
      throw new ToolError('tool_not_allowed', 'task_* 工具仅编排启用的 Discuss/Work 会话可用', 403);
    }
    return context.sessionId;
  };

  return {
    name: 'task',
    tools: [
      {
        spec: TASK_SUBMIT_SPEC,
        runKinds: ['discuss', 'work'],
        execute: (context, args) => {
          const sessionId = requireParentSession(context);
          const outputDir = args.outputDir === undefined || args.outputDir === null || args.outputDir === ''
            ? undefined
            : requireString(args, 'outputDir', 1, 600);
          const dto = deps.service.submit(deps.store, {
            sessionId,
            role: requireString(args, 'role', 1, 64),
            title: requireString(args, 'title', 1, 80),
            task: requireString(args, 'task', 1, 20_000),
            ...(outputDir !== undefined ? { outputDir } : {}),
          });
          return jsonString({ taskId: dto.id, status: dto.status, queuePosition: dto.queuePosition });
        },
      },
      {
        spec: TASK_QUERY_SPEC,
        runKinds: ['discuss', 'work'],
        execute: async (context, args) => {
          const sessionId = requireParentSession(context);
          let taskIds: string[] | undefined;
          if (args.taskIds !== undefined && args.taskIds !== null) {
            if (!Array.isArray(args.taskIds) || args.taskIds.length < 1 || args.taskIds.length > 32
              || !args.taskIds.every((id): id is string => typeof id === 'string' && id.length >= 1 && id.length <= 128)) {
              throw new ToolError('invalid_request', 'taskIds 必须是 1..32 个任务 ID 字符串');
            }
            taskIds = args.taskIds;
          }
          const wait = parseWait(args);
          if (wait) {
            const ids = taskIds ?? deps.service.listBySession(deps.store, sessionId).map((dto) => dto.id);
            const result = await deps.service.waitFor(deps.store, sessionId, ids, wait.mode, wait.timeoutSeconds);
            return jsonString(result);
          }
          // 非等待分支同样走工具投影（result ≤20000 字符）
          const tasks = deps.service.listForTool(deps.store, sessionId, taskIds);
          return jsonString({ tasks, timedOut: false });
        },
      },
      {
        spec: TASK_RESUME_SPEC,
        runKinds: ['discuss', 'work'],
        execute: (context, args) => {
          // R2-01：消费 requireParentSession 的调用方会话 id——resume 前校验
          // 任务归属（跨会话 403，零调度零写入）。
          const sessionId = requireParentSession(context);
          return jsonString(deps.service.resume(
            deps.store,
            requireString(args, 'taskId', 1, 128),
            requireString(args, 'message', 1, 20_000),
            { callerSessionId: sessionId },
          ));
        },
      },
      {
        spec: TASK_CANCEL_SPEC,
        runKinds: ['discuss', 'work'],
        execute: async (context, args) => {
          // R2-01：同上——跨会话取消/读取结果一律 403。
          const sessionId = requireParentSession(context);
          return jsonString(await deps.service.cancel(
            deps.store,
            requireString(args, 'taskId', 1, 128),
            { callerSessionId: sessionId },
          ));
        },
      },
    ],
  };
}
