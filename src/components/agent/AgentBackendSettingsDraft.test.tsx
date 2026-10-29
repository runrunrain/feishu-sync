// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), test: vi.fn() }));
vi.mock('../../api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/client')>(),
  getConfig: api.get,
  saveConfig: api.save,
  getAgentVisionStatus: async () => null,
  testClaudeConnection: api.test,
}));
vi.mock('../../hooks/useAgentStatus', () => ({ useAgentStatus: () => ({ status: null, loading: false, unreachable: false, rechecking: false, recheck: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { SettingsDraftProvider, useSettingsDraft } from '../../hooks/settingsDraft';
import { AgentRuntimeSettingsCard } from './AgentSettingsCard';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Save() { const draft = useSettingsDraft()!; return <button onClick={() => void draft.save()}>总保存</button>; }
it('基础能力基座的选择先进入统一草稿，只在总保存后提交', async () => {
  const config = { llm: { providers: [] }, agent: { runtime: { backend: 'claude-code' },
    model: { source: 'app-llm', thinkingLevel: 'off', contextWindow: 200000, maxTokens: 8192 },
    maxConcurrentProcesses: 3, idleTimeoutMinutes: 10, workspaces: [] } };
  api.get.mockReset().mockResolvedValue(structuredClone(config));
  api.save.mockReset().mockImplementation(async (patch) => ({ ...config, agent: patch.agent }));
  api.test.mockReset().mockResolvedValue({ ok: true, providerName: '应用提供商', model: '应用模型', latencyMs: 1000 });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const click = async (label: string) => act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)!.click());
  try {
    await act(async () => root.render(<SettingsDraftProvider><Save /><AgentRuntimeSettingsCard /></SettingsDraftProvider>));
    await click('Pi 配置');
    expect((container.querySelector('[aria-label="应用基础能力的 Agent 基座"]') as HTMLSelectElement).value).toBe('claude-code');
    expect(container.textContent).toContain('本地 Agent 配置（Pi）');
    const backendSelect = container.querySelector('[aria-label="应用基础能力的 Agent 基座"]') as HTMLSelectElement;
    await act(async () => { backendSelect.value = 'pi'; backendSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(api.save).not.toHaveBeenCalled();
    const testButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '测试 Claude Code 连接')!;
    expect(testButton.disabled).toBe(true);
    await click('总保存');
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ agent: expect.objectContaining({ runtime: expect.objectContaining({ backend: 'pi' }) }) }));
    await click('测试 Claude Code 连接');
    expect(api.test).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('连接成功 · 应用提供商 / 应用模型');
  } finally { act(() => root.unmount()); container.remove(); }
});
