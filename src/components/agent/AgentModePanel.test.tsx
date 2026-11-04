// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentSessionDto } from '../../types/agent';
const { list, switchMode } = vi.hoisted(() => ({ list: vi.fn(), switchMode: vi.fn() }));
vi.mock('../../api/client', () => ({ listAgentWorkspaces: list, addAgentWorkspace: vi.fn(), deleteAgentWorkspace: vi.fn(), APIError: class extends Error {} }));
vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { AgentModePanel } from './AgentModePanel';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { list.mockReset().mockResolvedValue([]); switchMode.mockReset().mockResolvedValue(true); });

it('Pi Work can start in the home directory without creating a workspace', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const session = { id: 's', backend: 'pi', mode: 'discuss', state: 'idle', workspace: null } as AgentSessionDto;
  try {
    await act(async () => root.render(<AgentModePanel session={session} busy={false} onSwitchMode={switchMode} writeRecords={[]} />));
    await act(async () => (container.querySelector('[aria-label="切换会话模式"]') as HTMLButtonElement).click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('可跨目录操作');
    expect(dialog.textContent).toContain('用户主目录（默认）');
    const enable = [...dialog.querySelectorAll('button')].find((button) => button.textContent === '启用 Work')!;
    expect(enable.disabled).toBe(false);
    await act(async () => enable.click());
    expect(switchMode).toHaveBeenCalledWith({ mode: 'work', confirm: 'WORK' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); }
});

it('Work can switch back to Chat and disables mode changes during an active run', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const session = { id: 's', backend: 'pi', mode: 'work', state: 'idle', workspace: null } as AgentSessionDto;
  try {
    await act(async () => root.render(<AgentModePanel session={session} busy={false} onSwitchMode={switchMode} writeRecords={[]} />));
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    expect(switchMode).toHaveBeenCalledWith({ mode: 'discuss' });
    await act(async () => root.render(<AgentModePanel session={session} busy onSwitchMode={switchMode} writeRecords={[]} />));
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  } finally { act(() => root.unmount()); container.remove(); }
});
