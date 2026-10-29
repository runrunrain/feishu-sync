// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const updateConfig = vi.hoisted(() => vi.fn(async (_updates: unknown) => ({})));
const config = vi.hoisted(() => ({
  agent: { runtime: { backend: 'claude-code' }, model: { source: 'pi-agent-dir', thinkingLevel: 'off' } },
  llm: { providers: [{ id: 'p1', name: '提供商', enabled: true, apiKey: '***', protocol: 'anthropic-messages',
    openAiCompatBaseUrl: 'https://example.com', defaultModelId: 'm1', models: [
      { id: 'm1', name: '模型一', openAiModel: 'model-1', enabled: true },
      { id: 'm2', name: '模型二', openAiModel: 'model-2', enabled: true },
    ] }], activeProviderId: 'p1', activeModelId: 'm2' },
}));
vi.mock('../hooks/useConfig', () => ({ useConfig: () => ({ saving: false, updateConfig, config }) }));
vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));

import { ModelProviderSettings } from './ModelProviderSettings';
import { ModelDefaultsSettings } from './ModelDefaultsSettings';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('保存时将当前提供商和选定模型用于 Agent，且只展示一个保存按钮', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ModelProviderSettings />));
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.filter((button) => button.textContent?.includes('保存'))).toHaveLength(1);
    expect(container.textContent).not.toContain('应用默认提供商');
    await act(async () => buttons.find((button) => button.textContent?.includes('保存提供商配置'))!.click());
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({ agent: expect.objectContaining({ model: expect.objectContaining({ source: 'app-llm', providerId: 'p1', modelId: 'm2' }) }) }));
    expect(updateConfig.mock.calls.at(-1)?.[0]).toHaveProperty('llm', { providers: config.llm.providers });
  } finally { act(() => root.unmount()); container.remove(); }
});

it('默认设置单独保存模型和整理开关，不覆盖提供商配置', async () => {
  updateConfig.mockClear();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ModelDefaultsSettings />));
    expect(container.textContent).toContain('应用默认提供商');
    const modelSelect = container.querySelectorAll('select')[1];
    await act(async () => { modelSelect.value = 'm1'; modelSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => (container.querySelector('[role="switch"]') as HTMLButtonElement).click());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('保存默认设置'))!.click());
    expect(updateConfig).toHaveBeenCalledWith({ llm: { activeProviderId: 'p1', activeModelId: 'm1', contentAdaptationEnabled: true } });
  } finally { act(() => root.unmount()); container.remove(); }
});
