/**
 * TaskPanel 组件测试（S7）—— renderToStaticMarkup 锚定：
 * 各状态徽标 / 角色标签 / 进度行 / 取消与作答入口 / 编排停用时任务区隐藏。
 * 点击交互（展开、作答提交、取消）由受控 props 与禁用态锚定，
 * 浏览器实测见 S7 报告（与 ApprovalCard 同口径）。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  isTaskActive,
  TaskCardBody,
  TaskCard,
  TaskMessagesView,
  TaskPanel,
  taskRoleLabel,
} from './TaskPanel';
import type { AgentMessageDto, AgentSessionDto, AgentTaskDto } from '../../types/agent';

function makeTask(overrides: Partial<AgentTaskDto> = {}): AgentTaskDto {
  return {
    id: 'task_1',
    sessionId: 's_1',
    role: 'kb-analyst',
    title: '梳理源库结构',
    status: 'running',
    queuePosition: null,
    rounds: 2,
    outputDir: null,
    questions: null,
    result: null,
    resultTruncated: false,
    error: null,
    createdAt: '2026-10-27T10:00:00Z',
    startedAt: '2026-10-27T10:00:01Z',
    finishedAt: null,
    ...overrides,
  };
}

function makeSession(): AgentSessionDto {
  return {
    id: 's_1',
    title: '编排会话',
    mode: 'discuss',
    workspace: null,
    state: 'idle',
    lastError: null,
    createdAt: '2026-10-27T09:00:00Z',
    updatedAt: '2026-10-27T10:00:00Z',
  };
}

const noop = vi.fn();
const basePanel = {
  session: makeSession(),
  tasks: [] as AgentTaskDto[],
  taskBusyId: null,
  onCancelTask: noop,
  onResumeTask: noop,
  orchestrationEnabled: true,
  onToggleOrchestration: noop,
};

const cardBase = {
  onToggleExpand: noop,
  onCancel: noop,
  onResume: noop,
  messages: null,
  messagesLoading: false,
  onLoadMessages: noop,
};

describe('TaskPanel（编排开关与任务区显隐）', () => {
  it('编排停用：任务列表不渲染，仅保留启用入口与提示', () => {
    const html = renderToStaticMarkup(<TaskPanel {...basePanel} orchestrationEnabled={false} />);
    expect(html).not.toContain('data-testid="agent-task-list"');
    expect(html).not.toContain('data-testid="agent-task-card"');
    expect(html).toContain('data-testid="agent-task-disabled-hint"');
    expect(html).toMatch(/data-testid="orchestration-toggle"/);
    expect(html).toContain('已停用');
  });

  it('编排加载中（null）：整块不渲染（避免开关闪烁）', () => {
    const html = renderToStaticMarkup(<TaskPanel {...basePanel} orchestrationEnabled={null} />);
    expect(html).toBe('');
  });

  it('编排启用 + 无任务：空状态提示；开关在场', () => {
    const html = renderToStaticMarkup(<TaskPanel {...basePanel} />);
    expect(html).toContain('data-testid="agent-task-list"');
    expect(html).toContain('data-testid="agent-task-empty"');
    expect(html).toMatch(/data-testid="orchestration-toggle"/);
  });

  it('编排开关错误在面板内呈现', () => {
    const html = renderToStaticMarkup(
      <TaskPanel {...basePanel} orchestrationError="plugin_revision_conflict" />,
    );
    expect(html).toContain('data-testid="agent-task-panel-error"');
    expect(html).toContain('plugin_revision_conflict');
  });
});

describe('任务列表渲染（各状态）', () => {
  it('六种状态徽标、角色标签、标题与进度行齐备；取消按钮仅非终态可见', () => {
    const statuses = ['queued', 'running', 'done', 'blocked', 'failed', 'interrupted'] as const;
    const tasks = statuses.map((status, i) =>
      makeTask({
        id: `task_${status}`,
        status,
        role: i === 1 ? 'kb-converter' : i === 2 ? 'kb-reviewer' : 'kb-analyst',
        title: `任务 ${status}`,
        queuePosition: status === 'queued' ? i + 1 : null,
        rounds: i + 1,
        outputDir: status === 'running' ? 'out/plan' : null,
      }),
    );
    const html = renderToStaticMarkup(<TaskPanel {...basePanel} tasks={tasks} />);
    for (const status of statuses) {
      expect(html).toContain(`data-task-status="${status}"`);
    }
    expect(html).toContain('排队 #1');
    expect(html).toContain('3 轮');
    expect(html).toContain('out/plan');
    expect(html).toContain('分析员');
    expect(html).toContain('转换员');
    expect(html).toContain('审校员');
    // queued/running/blocked 可取消；终态不出现取消按钮。
    expect((html.match(/data-testid="agent-task-cancel"/g) ?? []).length).toBe(3);
  });

  it('未知角色回退显示原 id', () => {
    expect(taskRoleLabel('custom-role')).toBe('custom-role');
    const html = renderToStaticMarkup(
      <TaskPanel {...basePanel} tasks={[makeTask({ role: 'custom-role' })]} />,
    );
    expect(html).toContain('custom-role');
  });

  it('isTaskActive：queued/running/blocked 非终态', () => {
    expect(isTaskActive('queued')).toBe(true);
    expect(isTaskActive('running')).toBe(true);
    expect(isTaskActive('blocked')).toBe(true);
    expect(isTaskActive('done')).toBe(false);
    expect(isTaskActive('failed')).toBe(false);
    expect(isTaskActive('cancelled')).toBe(false);
    expect(isTaskActive('interrupted')).toBe(false);
  });
});

const bodyBase = {
  onAnswerChange: noop,
  onSubmitAnswer: noop,
  messages: null,
  messagesLoading: false,
  onLoadMessages: noop,
};

describe('作答（BLOCKED 任务）', () => {
  const blocked = makeTask({
    status: 'blocked',
    questions: '原始库里 _draft 目录是否纳入分析范围？',
    rounds: 1,
  });

  it('展开态呈现提问、作答输入与提交按钮；空作答禁用提交（TaskCard 默认内部空草稿）', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...cardBase} task={blocked} expanded busy={false} />,
    );
    expect(html).toContain('data-testid="agent-task-questions"');
    expect(html).toContain('_draft 目录是否纳入分析范围？');
    expect(html).toMatch(/data-testid="agent-task-answer-input"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="agent-task-answer-submit"/);
  });

  it('有作答内容时提交可点；提交中防双击', () => {
    const html = renderToStaticMarkup(
      <TaskCardBody {...bodyBase} task={blocked} answer="纳入，见配置" busy={false} />,
    );
    expect(html).toMatch(/<button[^>]*data-testid="agent-task-answer-submit"[^>]*>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="agent-task-answer-submit"/);

    const busyHtml = renderToStaticMarkup(
      <TaskCardBody {...bodyBase} task={blocked} answer="纳入" busy />,
    );
    expect(busyHtml).toMatch(/<button[^>]*disabled=""[^>]*data-testid="agent-task-answer-submit"/);
    expect(busyHtml).toContain('正在提交');
  });

  it('提交中取消按钮同步禁用', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...cardBase} task={makeTask({ status: 'running' })} expanded={false} busy />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="agent-task-cancel"/);
  });
});

describe('结果与错误呈现', () => {
  it('done 任务展开呈现结果；截断标记可见', () => {
    const html = renderToStaticMarkup(
      <TaskCard
        {...cardBase}
        task={makeTask({
          status: 'done',
          result: '结构结论：共 12 个域',
          resultTruncated: true,
          finishedAt: '2026-10-27T10:05:00Z',
        })}
        expanded
        busy={false}
      />,
    );
    expect(html).toContain('data-testid="agent-task-result"');
    expect(html).toContain('结构结论：共 12 个域');
    expect(html).toContain('已截断');
  });

  it('failed 任务展开呈现错误码与信息', () => {
    const html = renderToStaticMarkup(
      <TaskCard
        {...cardBase}
        task={makeTask({
          status: 'failed',
          error: { code: 'task_contract_missing', message: '两轮缺少 DONE 标记' },
        })}
        expanded
        busy={false}
      />,
    );
    expect(html).toContain('data-testid="agent-task-error"');
    expect(html).toContain('task_contract_missing');
    expect(html).toContain('两轮缺少 DONE 标记');
  });

  it('展开态提供执行记录入口；已加载时呈现记录列表', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...cardBase} task={makeTask({ status: 'done', result: 'ok' })} expanded busy={false} />,
    );
    expect(html).toMatch(/data-testid="agent-task-messages-toggle"/);
    expect(html).toContain('查看执行记录');

    const loaded = renderToStaticMarkup(
      <TaskCard
        {...cardBase}
        task={makeTask({ status: 'done', result: 'ok' })}
        expanded
        busy={false}
        messages={[]}
      />,
    );
    expect(loaded).toContain('刷新执行记录');
  });
});

describe('TaskMessagesView（子任务消息只读视图）', () => {
  const messages: AgentMessageDto[] = [
    { id: 'm1', role: 'user', at: '2026-10-27T10:00:00Z', text: '梳理源库目录结构' },
    {
      id: 'm2',
      role: 'assistant',
      at: '2026-10-27T10:01:00Z',
      text: '正在检索…',
      toolCalls: [{ id: 'c1', name: 'kb_search', argsSummary: '"结构"' }],
    },
    {
      id: 'm3',
      role: 'tool',
      at: '2026-10-27T10:01:10Z',
      tool: { callId: 'c1', name: 'kb_search', isError: false, resultSummary: '命中 5 篇' },
    },
  ];

  it('渲染任务/子Agent/工具行', () => {
    const html = renderToStaticMarkup(<TaskMessagesView messages={messages} />);
    expect(html).toContain('data-testid="agent-task-messages"');
    expect(html).toContain('梳理源库目录结构');
    expect(html).toContain('命中 5 篇');
    expect(html).toContain('kb_search');
    expect(html.match(/data-role="tool"/g)?.length).toBe(1);
  });

  it('空记录呈现占位', () => {
    const html = renderToStaticMarkup(<TaskMessagesView messages={[]} />);
    expect(html).toContain('data-testid="agent-task-messages-empty"');
  });
});
