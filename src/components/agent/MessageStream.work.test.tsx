// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MessageStream } from './MessageStream';
import type { RunDraft } from '../../hooks/useAgentSessions';
import type { AgentMessageDto } from '../../types/agent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });

it('keeps arguments visible, folds results by default and removes merged invocation gaps', async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  const messages: AgentMessageDto[] = [
    { id: 'a', role: 'assistant', at: '', toolCalls: [{ id: 'call', name: 'bash', argsSummary: '{"command":"git status","cwd":"/project"}' }] },
    { id: 't', role: 'tool', at: '', tool: { callId: 'call', name: 'bash', isError: false, resultSummary: 'working tree clean' } },
  ];
  try {
    await act(async () => root.render(<MessageStream workMode messages={messages} draft={null} streamErrors={[]} loading={false} />));
    expect(host.querySelectorAll('.agent-message-item')).toHaveLength(1);
    expect(host.querySelector('.agent-work-tool-target')?.textContent).toBe('git status');
    expect(host.querySelector('.agent-work-tool-args summary')?.textContent).toContain('/project');
    expect(host.querySelector('.agent-work-tool-result')).toBeNull();
    await act(async () => (host.querySelector('.agent-work-tool-result-toggle') as HTMLButtonElement).click());
    expect(host.querySelector('.agent-work-tool-result')?.textContent).toBe('working tree clean');
    expect(host.querySelector('.agent-work-tool-head')?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => (host.querySelector('.agent-work-tool-head') as HTMLButtonElement).click());
    expect(host.querySelector('.agent-work-tool-result')).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

it('distinguishes running, failed and successful empty results without showing arguments as output', async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  const render = (tool: RunDraft['tools'][number]) => root.render(<MessageStream workMode messages={[]} draft={{ runId: 'r', text: '', tools: [tool] }} streamErrors={[]} loading={false} />);
  try {
    await act(async () => render({ callId: 'c', name: 'bash', argsSummary: 'npm run build', phase: 'start' }));
    expect((host.querySelector('.agent-work-tool-head') as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('.agent-work-tool-status')?.textContent).toBe('执行中');
    await act(async () => render({ callId: 'c', name: 'bash', argsSummary: 'npm run build', phase: 'end', isError: true, resultSummary: 'command failed' }));
    expect(host.querySelector('.agent-work-tool-status')?.textContent).toBe('失败');
    await act(async () => (host.querySelector('.agent-work-tool-head') as HTMLButtonElement).click());
    expect(host.querySelector('.agent-work-tool-result')?.textContent).toBe('command failed');
    await act(async () => render({ callId: 'c', name: 'bash', argsSummary: 'npm run build', phase: 'end', resultSummary: '' }));
    expect(host.querySelector('.agent-work-tool-result')?.textContent).toBe('工具执行完成，无输出。');
  } finally { await act(async () => root.unmount()); }
});

it('renders native thinking as a collapsed row without merging it into the response', async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<MessageStream workMode messages={[{ id: 'thought', role: 'assistant', at: 'now', thinking: '检查目录\n确认规则', text: '可以开始。' }]} draft={{ runId: 'r', text: '', thinking: '继续验证', tools: [] }} loading={false} streamErrors={[]} />));
    const thoughts = host.querySelectorAll('.agent-work-thinking');
    expect(thoughts).toHaveLength(2);
    expect(thoughts[0].hasAttribute('open')).toBe(false);
    expect(thoughts[0].querySelector('.agent-work-thinking-body')?.textContent).toBe('检查目录\n确认规则');
    expect(thoughts[1].textContent).toContain('思考中');
    expect(host.querySelector('.agent-reply')?.textContent).not.toContain('检查目录');
  } finally { await act(async () => root.unmount()); }
});

it('offers one fork entry per finished turn, anchored on persisted messages only', async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  const onFork = vi.fn();
  const messages: AgentMessageDto[] = [
    { id: 'u1', role: 'user', at: '', text: '第一问' },
    { id: 'a1', role: 'assistant', at: '', text: '第一答' },
    { id: 't1', role: 'tool', at: '', tool: { callId: 'c', name: 'bash', isError: false, resultSummary: 'ok' } },
    { id: 'u2', role: 'user', at: '', text: '第二问' },
    { id: 'a2', role: 'assistant', at: '', text: '第二答' },
    { id: 'live_run_x', role: 'assistant', at: '', text: '尚未落盘' },
  ];
  try {
    await act(async () => root.render(<MessageStream workMode messages={messages} draft={null} streamErrors={[]} loading={false} onFork={onFork} />));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="agent-turn-fork"] button')];
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0].click());
    expect(onFork).toHaveBeenLastCalledWith('t1');
    await act(async () => buttons[1].click());
    expect(onFork).toHaveBeenLastCalledWith('a2'); // live_ 占位消息不能作锚点
    // 进行中的末轮（有草稿）不提供入口；不传 onFork 时完全不渲染
    await act(async () => root.render(<MessageStream workMode messages={messages} draft={{ runId: 'r', text: 'x', tools: [] }} streamErrors={[]} loading={false} onFork={onFork} />));
    expect(host.querySelectorAll('[data-testid="agent-turn-fork"]')).toHaveLength(1);
    await act(async () => root.render(<MessageStream workMode messages={messages} draft={null} streamErrors={[]} loading={false} />));
    expect(host.querySelectorAll('[data-testid="agent-turn-fork"]')).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});
