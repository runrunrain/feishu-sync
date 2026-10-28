/**
 * TaskPanel —— 对话页右栏「任务」区（S7，设计 kb-agent-upgrade §5.4）
 *
 * 编排开关（AppPluginStore orchestration 条目，默认停用）+ 当前会话的
 * agent_tasks 列表：状态徽标 / 角色标签 / 标题 / 进度（轮次、排队序）、
 * 任务详情（结果、错误、BLOCKED 提问与作答表单）、子任务消息查看
 * （GET /tasks/:id/messages，懒加载）、取消按钮。
 * 编排停用时不渲染任务区，仅保留启用入口（验收：任务列表不出现）。
 *
 * 组件保持受控（状态与动作经 props 注入），消息拉取为面板内局部状态；
 * 静态渲染测试锚定 testid，交互实测见 S7 报告浏览器验证。
 */

import { useCallback, useState } from 'react';
import {
  Ban,
  ChevronDown,
  ChevronRight,
  ListTodo,
  Loader2,
  MessageSquareText,
  Send,
} from 'lucide-react';
import { StatusBadge } from '../common/StatusBadge';
import { getAgentTaskMessages } from '../../api/client';
import type {
  AgentMessageDto,
  AgentSessionDto,
  AgentTaskDto,
  AgentTaskStatus,
} from '../../types/agent';

/** 状态徽标文案（server 状态机 §5.3；blocked 非终态、可作答）。 */
export const TASK_STATUS_LABEL: Record<AgentTaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  done: '已完成',
  blocked: '待作答',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

/** StatusBadge 语义映射（成功/警示/错误/中性）。 */
export const TASK_STATUS_BADGE: Record<AgentTaskStatus, 'success' | 'warning' | 'error' | 'neutral' | 'loading'> = {
  queued: 'neutral',
  running: 'loading',
  done: 'success',
  blocked: 'warning',
  failed: 'error',
  cancelled: 'neutral',
  interrupted: 'neutral',
};

/** 内置角色卡 label（server/src/agent/roles/*.md frontmatter，v1 三张）。 */
export const TASK_ROLE_LABEL: Record<string, string> = {
  'kb-analyst': '分析员',
  'kb-converter': '转换员',
  'kb-reviewer': '审校员',
};

export function taskRoleLabel(role: string): string {
  return TASK_ROLE_LABEL[role] ?? role;
}

/** 非终态（可取消；blocked 同时可作答）。 */
export function isTaskActive(status: AgentTaskStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'blocked';
}

interface TaskPanelProps {
  session: AgentSessionDto | null;
  tasks: AgentTaskDto[];
  /** 正在提交取消/作答的任务 id。 */
  taskBusyId: string | null;
  onCancelTask: (id: string) => void;
  onResumeTask: (id: string, message: string) => void;
  /** 任务编排开关：null = 加载中（整块不渲染）。 */
  orchestrationEnabled: boolean | null;
  orchestrationBusy?: boolean;
  orchestrationError?: string | null;
  onToggleOrchestration: (enabled: boolean) => void;
}

export function TaskPanel({
  session,
  tasks,
  taskBusyId,
  onCancelTask,
  onResumeTask,
  orchestrationEnabled,
  orchestrationBusy = false,
  orchestrationError = null,
  onToggleOrchestration,
}: TaskPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [messagesByTask, setMessagesByTask] = useState<Record<string, AgentMessageDto[]>>({});
  const [loadingTaskId, setLoadingTaskId] = useState<string | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((cur) => (cur === id ? null : id));
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    setLoadingTaskId(id);
    setMessageError(null);
    try {
      const list = await getAgentTaskMessages(id);
      setMessagesByTask((prev) => ({ ...prev, [id]: list }));
    } catch {
      // 失败保留旧数据；可再次点击重试。
      setMessageError('执行记录加载失败，可重试。');
    } finally {
      setLoadingTaskId(null);
    }
  }, []);

  // 加载中不占位：插件配置返回前不渲染任何骨架（避免开关闪烁）。
  // 注意 hooks 已在上方全部声明（rules-of-hooks：早退必须在 hooks 之后）。
  if (orchestrationEnabled === null) return null;

  return (
    <section
      className="shrink-0 rounded-md border border-line bg-card-bg shadow-sm overflow-hidden flex flex-col max-h-[60%]"
      data-testid="agent-task-panel"
      aria-label="任务编排"
    >
      <header className="shrink-0 px-4 py-3 border-b border-line/60 flex items-center gap-1.5">
        <ListTodo className="w-3.5 h-3.5 text-jade" />
        <h3 className="text-sm font-kai font-medium text-ink flex-1">任务</h3>
        <label
          className="flex items-center gap-1.5 text-[11px] text-ink-soft cursor-pointer select-none"
          title="启用/停用任务编排（对本会话下一轮生成生效）"
        >
          <input
            type="checkbox"
            className="accent-jade"
            checked={orchestrationEnabled}
            disabled={orchestrationBusy}
            onChange={(e) => onToggleOrchestration(e.target.checked)}
            data-testid="orchestration-toggle"
          />
          编排
        </label>
      </header>

      {orchestrationEnabled ? (
        <div
          className="flex-1 min-h-0 overflow-auto scrollbar-thin p-3 space-y-2"
          data-testid="agent-task-list"
        >
          {tasks.length === 0 ? (
            <p className="text-[11px] text-ink-faint leading-relaxed" data-testid="agent-task-empty">
              {session
                ? '暂无任务。Agent 可用任务工具把子任务派给内置角色并行执行。'
                : '选择会话后查看其任务。'}
            </p>
          ) : (
            tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                expanded={expandedId === task.id}
                busy={taskBusyId === task.id}
                onToggleExpand={toggleExpand}
                onCancel={onCancelTask}
                onResume={onResumeTask}
                messages={messagesByTask[task.id] ?? null}
                messagesLoading={loadingTaskId === task.id}
                onLoadMessages={(id) => void loadMessages(id)}
              />
            ))
          )}
        </div>
      ) : (
        <p
          className="px-4 py-3 text-[11px] text-ink-faint leading-relaxed"
          data-testid="agent-task-disabled-hint"
        >
          任务编排已停用。启用后，Agent 可把子任务派给内置角色（分析/转换/审校）并行执行；
          任务状态、提问作答与取消在这里管理，也可在设置的上下文配置中调整。
        </p>
      )}

      {(orchestrationError ?? messageError) ? (
        <p
          role="alert"
          className="shrink-0 px-4 py-1.5 border-t border-line/60 text-[11px] text-seal-2"
          data-testid="agent-task-panel-error"
        >
          {orchestrationError ?? messageError}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 任务卡片
// ---------------------------------------------------------------------------

interface TaskCardProps {
  task: AgentTaskDto;
  expanded: boolean;
  /** 该任务的取消/作答提交中。 */
  busy: boolean;
  onToggleExpand: (id: string) => void;
  onCancel: (id: string) => void;
  onResume: (id: string, message: string) => void;
  messages: AgentMessageDto[] | null;
  messagesLoading: boolean;
  onLoadMessages: (id: string) => void;
}

export function TaskCard({
  task,
  expanded,
  busy,
  onToggleExpand,
  onCancel,
  onResume,
  messages,
  messagesLoading,
  onLoadMessages,
}: TaskCardProps) {
  const [answer, setAnswer] = useState('');
  const active = isTaskActive(task.status);

  const submitAnswer = () => {
    const text = answer.trim();
    if (!text || busy) return;
    onResume(task.id, text);
    // 成功时任务离开 blocked（列表刷新），表单随之卸载；失败保留草稿可重试。
  };

  return (
    <div
      className="rounded-md border border-line bg-paper/40 px-2.5 py-2"
      data-testid="agent-task-card"
      data-task-id={task.id}
      data-task-status={task.status}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <button
          type="button"
          onClick={() => onToggleExpand(task.id)}
          aria-expanded={expanded}
          aria-label={expanded ? `收起任务「${task.title}」详情` : `展开任务「${task.title}」详情`}
          className="shrink-0 p-0.5 rounded text-ink-faint hover:text-ink transition-colors"
          data-testid="agent-task-expand"
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <StatusBadge status={TASK_STATUS_BADGE[task.status]} size="sm" hideDot={task.status === 'running'}>
          {task.status === 'running' ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          {TASK_STATUS_LABEL[task.status]}
        </StatusBadge>
        <span className="shrink-0 text-[11px] text-ink-faint font-mono" data-testid="agent-task-role">
          {taskRoleLabel(task.role)}
        </span>
        <span className="flex-1 min-w-0 truncate text-xs text-ink" title={task.title} data-testid="agent-task-title">
          {task.title}
        </span>
        {active ? (
          <button
            type="button"
            onClick={() => onCancel(task.id)}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border border-line text-ink-faint hover:text-seal-2 hover:border-seal-2/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="取消该任务（终态前可取消）"
            data-testid="agent-task-cancel"
          >
            <Ban className="w-3 h-3" />
            取消
          </button>
        ) : null}
      </div>

      <div
        className="mt-1 flex items-center gap-2 text-[10px] text-ink-faint"
        data-testid="agent-task-progress"
      >
        {task.status === 'queued' && task.queuePosition != null ? (
          <span className="font-mono">排队 #{task.queuePosition}</span>
        ) : null}
        <span className="font-mono">{task.rounds} 轮</span>
        {task.outputDir ? (
          <span className="font-mono truncate min-w-0" title={task.outputDir}>
            {task.outputDir}
          </span>
        ) : null}
      </div>

      {expanded ? (
        <TaskCardBody
          task={task}
          answer={answer}
          onAnswerChange={setAnswer}
          onSubmitAnswer={submitAnswer}
          busy={busy}
          messages={messages}
          messagesLoading={messagesLoading}
          onLoadMessages={onLoadMessages}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 展开详情：错误 / BLOCKED 提问与作答 / 结果 / 执行记录
// ---------------------------------------------------------------------------

interface TaskCardBodyProps {
  task: AgentTaskDto;
  answer: string;
  onAnswerChange: (value: string) => void;
  onSubmitAnswer: () => void;
  busy: boolean;
  messages: AgentMessageDto[] | null;
  messagesLoading: boolean;
  onLoadMessages: (id: string) => void;
}

export function TaskCardBody({
  task,
  answer,
  onAnswerChange,
  onSubmitAnswer,
  busy,
  messages,
  messagesLoading,
  onLoadMessages,
}: TaskCardBodyProps) {
  return (
    <div className="mt-2 space-y-2" data-testid="agent-task-body">
      {task.error ? (
        <p
          className="px-2 py-1.5 rounded border border-seal-2/30 bg-[rgba(192,57,43,0.05)] text-[11px] text-seal-2 break-words"
          data-testid="agent-task-error"
        >
          {task.error.code}：{task.error.message}
        </p>
      ) : null}

      {task.status === 'blocked' && task.questions ? (
        <div
          className="px-2 py-1.5 rounded border border-[rgba(180,83,9,0.3)] bg-[rgba(180,83,9,0.05)]"
          data-testid="agent-task-questions"
        >
          <p className="text-[11px] font-medium text-[#92580c]">子任务提问（等待你的作答）：</p>
          <p className="mt-1 text-[11px] text-ink-soft whitespace-pre-wrap break-words">{task.questions}</p>
          <textarea
            value={answer}
            onChange={(e) => onAnswerChange(e.target.value)}
            aria-label={`作答任务「${task.title}」`}
            className="mt-2 w-full min-h-[72px] resize-y rounded border border-line bg-card-bg p-2 text-[11px] font-mono focus:outline-jade"
            placeholder="输入作答内容，提交后子任务继续执行"
            data-testid="agent-task-answer-input"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={onSubmitAnswer}
              disabled={busy || !answer.trim()}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-jade text-white hover:bg-jade/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              data-testid="agent-task-answer-submit"
            >
              <Send className="w-3 h-3" />
              提交作答
            </button>
            {busy ? <span className="text-[10px] text-ink-faint">正在提交…</span> : null}
          </div>
        </div>
      ) : null}

      {task.result != null ? (
        <details className="px-2 py-1.5 rounded border border-line bg-card-bg" data-testid="agent-task-result">
          <summary className="cursor-pointer text-[11px] text-ink-soft font-medium select-none">
            执行结果{task.resultTruncated ? '（已截断）' : ''}
          </summary>
          <pre className="mt-1.5 max-h-56 overflow-auto scrollbar-thin text-[11px] text-ink whitespace-pre-wrap break-words font-mono">
            {task.result || '（空）'}
          </pre>
        </details>
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => onLoadMessages(task.id)}
          disabled={messagesLoading}
          className="inline-flex items-center gap-1 text-[11px] text-jade hover:text-seal disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="agent-task-messages-toggle"
        >
          <MessageSquareText className="w-3 h-3" />
          {messages ? '刷新执行记录' : '查看执行记录'}
        </button>
        {messagesLoading ? (
          <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-ink-faint">
            <Loader2 className="w-3 h-3 animate-spin" />
            加载中…
          </span>
        ) : null}
        {messages ? <TaskMessagesView messages={messages} /> : null}
      </div>
    </div>
  );
}

/** 子任务消息（GET /tasks/:id/messages，同会话历史格式）的紧凑只读视图。 */
export function TaskMessagesView({ messages }: { messages: AgentMessageDto[] }) {
  if (messages.length === 0) {
    return (
      <p className="mt-1.5 text-[11px] text-ink-faint" data-testid="agent-task-messages-empty">
        暂无执行记录。
      </p>
    );
  }
  return (
    <ul className="mt-1.5 space-y-1 max-h-64 overflow-auto scrollbar-thin" data-testid="agent-task-messages">
      {messages.map((m) => (
        <li key={m.id} data-role={m.role} className="text-[11px] leading-relaxed">
          {m.role === 'user' ? (
            <p className="whitespace-pre-wrap break-words text-ink-soft">
              <span className="font-medium text-ink-faint">任务：</span>
              {m.text}
            </p>
          ) : m.role === 'assistant' ? (
            <p className="whitespace-pre-wrap break-words text-ink">
              <span className="font-medium text-ink-faint">子Agent：</span>
              {m.text}
            </p>
          ) : m.role === 'tool' && m.tool ? (
            <p className="font-mono text-ink-faint truncate" title={m.tool.resultSummary}>
              ⚙ {m.tool.name} {m.tool.resultSummary}
            </p>
          ) : (
            <p className="text-center text-ink-faint">{m.text}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
