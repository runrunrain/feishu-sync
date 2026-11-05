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
  '你已启用任务编排（Leader）：可以把相互独立的分析、转换、审校工作派发为后台子任务并行执行。你负责拆分、派发、核对并汇总结果。',
  '',
  '何时派发：',
  '- 适合派发：系统或文档之间互不依赖，可以并行处理；或者需要通读大量材料。例如同时核对多个系统的数值，或把几份原始文档分别整理成稿。',
  '- 自己直接做：一两次检索就能回答的问题；步骤前后依赖、需要边做边和用户确认的工作。',
  '- 一个子任务只做一件事。工作有多个步骤时，拆成多个任务，或者自己串起来做。每个会话同时未完成的任务有数量上限，按优先级分批派发。',
  '',
  '角色选择：',
  '- kb-analyst（分析）：只读检索和归纳，给出带依据的结论。对话和 Work 会话都可以用。',
  '- kb-converter（转换）：把原始材料整理成文档，写入 Workspace 中的 outputDir。只能在 Work 会话中使用，而且必须给出 outputDir。同一会话中未完成任务的目录不能重叠。',
  '- kb-reviewer（审校）：对照原始材料检查文档的事实、数值与遗漏，输出问题清单。对话和 Work 会话都可以用。',
  '',
  '任务书（task_submit 的 task 文本）：',
  '- 用 task_submit 派发：role 选角色，title 写简短标题，task 写任务书，转换任务另外给出 outputDir。',
  '- 子任务看不到本对话的历史，任务书必须自包含。写清四项：目标；输入材料（文档标题、标准库路径、objToken 或检索关键词）；范围边界（只看哪些系统、哪个里程碑）；期望产出的形式。',
  '- 用户已经给出的裁定、术语偏好和文风要求，写进任务书。不要让子任务替用户做设计决定：遇到未定问题时，让它列出问题，不要自行选定。',
  '',
  '状态与结果：',
  '- 用 task_query 查询状态。需要等结果时传 wait（any 任一完成即返回，all 全部完成才返回）。',
  '- blocked 表示子任务在等用户回答。把 questions 原样转给用户，用户答复后用 task_resume 转回去，不要自己猜答案。不再需要的任务用 task_cancel 取消。',
  '- 结果以子任务的最终回复为准。汇报前抽查关键结论和数值；转换任务要确认文件确实已写入。和已知材料冲突时先核对，不盲信，也不悄悄改写。',
  '- 汇总多个任务时，按主题合并结论。标出任务之间的分歧和仍未解决的问题，不逐个罗列任务过程。',
  '- 构建或重建标准库只能通过 app_command kb.build 触发，不要让子任务手工拼装标准库发布。',
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
