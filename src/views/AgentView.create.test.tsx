// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useAgentSessions', () => ({ useAgentSessions: () => ({
  sessions: [], sessionsLoading: false, sessionsError: '服务不可用', activeSession: null, activeId: null,
  messages: [], messagesLoading: false, draft: null, streamErrors: [], approvals: [], tasks: [], taskNotices: [],
  writeRecords: [], sseStatus: 'closed', sending: false, createSession: create,
  selecting: vi.fn(), refreshSessions: vi.fn(), renameSession: vi.fn(), removeSession: vi.fn(),
  stop: vi.fn(), switchMode: vi.fn(), decideApproval: vi.fn(), cancelTask: vi.fn(), resumeTask: vi.fn(),
}) }));
vi.mock('../hooks/useSessionAgentStatus', () => ({ useSessionAgentStatus: () => ({ status: null, unreachable: false, recheck: vi.fn() }) }));
vi.mock('../hooks/useAgentOrchestration', () => ({ useAgentOrchestration: () => ({ enabled: false, busy: false, toggle: vi.fn() }) }));
vi.mock('../components/common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock('../components/agent/MessageStream', () => ({ MessageStream: () => null }));
vi.mock('../components/agent/AgentComposer', () => ({ AgentComposer: () => null }));
vi.mock('../components/agent/AgentModePanel', () => ({ AgentModePanel: () => null }));
vi.mock('../components/agent/TaskPanel', () => ({ TaskPanel: () => null }));
import { AgentView } from './AgentView';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { create.mockReset().mockResolvedValue({ id: 'new-session' }); });

it('新建时可分别选择 Pi 或 Claude Code，选择会传给会话创建', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const click = async (selector: string) => act(async () => (container.querySelector(selector) as HTMLButtonElement).click());
  try {
    await act(async () => root.render(<AgentView />));
    await click('[aria-label="新建会话"]');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('应用能力的基座在设置中单独配置');
    await click('[aria-label="新建 Pi 会话"]');
    expect(create).toHaveBeenLastCalledWith('pi');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await click('[aria-label="新建会话"]');
    await click('[aria-label="新建 Claude Code 会话"]');
    expect(create).toHaveBeenLastCalledWith('claude-code');
  } finally { act(() => root.unmount()); container.remove(); }
});

it('创建失败时保留选择弹窗并允许重试', async () => {
  create.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'retry' });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const click = async (selector: string) => act(async () => (container.querySelector(selector) as HTMLButtonElement).click());
  try {
    await act(async () => root.render(<AgentView />));
    await click('[aria-label="新建会话"]');
    await click('[aria-label="新建 Claude Code 会话"]');
    expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('服务不可用');
    await click('[aria-label="新建 Claude Code 会话"]');
    expect(create).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); }
});
