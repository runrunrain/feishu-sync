// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import type { McpInstallStatus } from '../types/kb-mcp-install';

const api = vi.hoisted(() => ({ info: vi.fn(), status: vi.fn(), install: vi.fn(), remove: vi.fn() }));
vi.mock('../api/client', () => ({ getKbMcpInfo: api.info, getKbMcpInstallStatus: api.status, installKbMcp: api.install, removeKbMcp: api.remove }));
vi.mock('../utils/clipboard', () => ({ writeClipboardText: vi.fn() }));
import { KbMcpLocalSettingsCard } from './KbMcpLocalSettingsCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const targets: McpInstallStatus[] = [
  { target: 'agents', path: '/home/user/.agents/.mcp.json', state: 'not_installed' },
  { target: 'claude', path: '/home/user/.claude.json', state: 'not_installed' },
];
beforeEach(() => {
  vi.clearAllMocks();
  api.info.mockResolvedValue({ available: true, command: 'app', args: [], env: {}, snippet: '{}', alternative: { command: 'node', args: [], note: '' } });
  api.status.mockResolvedValue({ targets });
  api.install.mockImplementation(async (target: string) => ({ ...targets.find((item) => item.target === target), state: 'installed' }));
  api.remove.mockImplementation(async (target: string) => ({ ...targets.find((item) => item.target === target), state: 'not_installed' }));
});

it('在知识库共享的本机安装卡中选择 Claude 并安装、清理', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text))!;
  try {
    await act(async () => root.render(<KbMcpLocalSettingsCard />));
    expect(container.textContent).toContain('/home/user/.agents/.mcp.json');
    const select = container.querySelector<HTMLSelectElement>('[aria-label="MCP 安装目标"]')!;
    await act(async () => { select.value = 'claude'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.textContent).toContain('/home/user/.claude.json');
    await act(async () => button('一键安装').click());
    expect(api.install).toHaveBeenCalledWith('claude');
    expect(container.textContent).toContain('安装完成');
    expect(container.textContent).toContain('已安装');
    await act(async () => button('清理').click());
    expect(api.remove).toHaveBeenCalledWith('claude');
    expect(container.textContent).toContain('已清理');
  } finally { act(() => root.unmount()); container.remove(); }
});

it('已有未管理的同名配置时禁用安装与清理并说明原因', async () => {
  api.status.mockResolvedValue({ targets: [{ ...targets[0], state: 'conflict', message: '已有同名配置，应用不会覆盖或清理。' }, targets[1]] });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<KbMcpLocalSettingsCard />));
    expect(container.textContent).toContain('已有同名配置');
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.find((item) => item.textContent === '一键安装')?.disabled).toBe(true);
    expect(buttons.find((item) => item.textContent === '清理')?.disabled).toBe(true);
    expect(api.install).not.toHaveBeenCalled(); expect(api.remove).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); container.remove(); }
});
