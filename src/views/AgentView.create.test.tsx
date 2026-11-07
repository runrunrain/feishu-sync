// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
const addFiles = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useAgentSessions', () => ({ useAgentSessions: () => ({
  sessions: [], sessionsLoading: false, sessionsError: '服务不可用', activeSession: null, activeId: null,
  messages: [], messagesLoading: false, draft: null, streamErrors: [], approvals: [], tasks: [], taskNotices: [],
  writeRecords: [], sseStatus: 'closed', sending: false, createSession: create,
  selecting: vi.fn(), refreshSessions: vi.fn(), renameSession: vi.fn(), removeSession: vi.fn(),
  stop: vi.fn(), switchMode: vi.fn(), decideApproval: vi.fn(), cancelTask: vi.fn(), resumeTask: vi.fn(),
}) }));
vi.mock('../hooks/useSessionAgentStatus', () => ({ useSessionAgentStatus: () => ({ status: null, unreachable: false, recheck: vi.fn() }) }));
vi.mock('../components/common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock('../components/agent/MessageStream', () => ({ MessageStream: () => null }));
vi.mock('../components/agent/AgentComposer', async () => {
  const React = await import('react');
  return { AgentComposer: React.forwardRef((_props, ref) => { React.useImperativeHandle(ref, () => ({ addFiles })); return null; }) };
});
vi.mock('../components/agent/AgentModePanel', () => ({ AgentModePanel: () => null }));
import { AgentView } from './AgentView';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { create.mockReset().mockResolvedValue({ id: 'new-session' }); addFiles.mockReset(); });

it('文件可拖入整个会话页，显示投放提示并交给当前输入框', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const file = new File(['content'], '设计.md');
  const drag = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file], dropEffect: '' } });
    container.querySelector('[data-view="agent"]')!.dispatchEvent(event);
    return event;
  };
  try {
    await act(async () => root.render(<AgentView />));
    await act(async () => { expect(drag('dragenter').defaultPrevented).toBe(true); });
    expect(container.querySelector('[data-testid="agent-file-drop-overlay"]')).not.toBeNull();
    await act(async () => { expect(drag('drop').defaultPrevented).toBe(true); });
    expect(addFiles).toHaveBeenCalledWith([file]);
    expect(container.querySelector('[data-testid="agent-file-drop-overlay"]')).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); }
});

it('单击新建直接创建 Pi 会话', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const click = async (selector: string) => act(async () => (container.querySelector(selector) as HTMLButtonElement).click());
  try {
    await act(async () => root.render(<AgentView />));
    await click('[aria-label="新建会话"]');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenLastCalledWith('pi', undefined);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); }
});

it('创建失败在对话页显示错误，再点新建可重试', async () => {
  create.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'retry' });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const click = async (selector: string) => act(async () => (container.querySelector(selector) as HTMLButtonElement).click());
  try {
    await act(async () => root.render(<AgentView />));
    await click('[aria-label="新建会话"]');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('服务不可用');
    await click('[aria-label="新建会话"]');
    expect(create).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); }
});
