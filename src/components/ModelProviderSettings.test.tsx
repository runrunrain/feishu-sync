// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  config: {
    agent: { runtime: { backend: 'claude-code' }, model: { source: 'pi-agent-dir', thinkingLevel: 'off' } },
    llm: { providers: [{ id: 'p1', name: '提供商', enabled: true, apiKey: '***', protocol: 'anthropic-messages',
      openAiCompatBaseUrl: 'https://example.com', defaultModelId: 'm1', models: [
        { id: 'm1', name: '模型一', openAiModel: 'model-1', enabled: true },
        { id: 'm2', name: '模型二', openAiModel: 'model-2', enabled: true },
      ] }], activeProviderId: 'p1', activeModelId: 'm2', contentAdaptationEnabled: false },
  },
  save: vi.fn(),
}));
vi.mock('../api/client', () => ({
  APIError: class extends Error {},
  getConfig: async () => structuredClone(fixture.config),
  saveConfig: fixture.save,
  revealProviderApiKey: vi.fn(),
}));
vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { ModelProviderSettings } from './ModelProviderSettings';
import { ModelDefaultsSettings } from './ModelDefaultsSettings';
import { SettingsDraftProvider, useSettingsDraft } from '../hooks/settingsDraft';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Controls() {
  const draft = useSettingsDraft()!;
  return <><button onClick={() => draft.stageForm('md-provider')}>切换子页</button><button onClick={() => void draft.save()}>总保存</button>{draft.saveError && <span role="alert">{draft.saveError}</span>}</>;
}
function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
beforeEach(() => { fixture.save.mockReset().mockImplementation(async () => structuredClone(fixture.config)); });

it('跨子页保留草稿，统一保存提供商与默认设置，并用于 Agent', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<SettingsDraftProvider><Controls /><ModelProviderSettings /><ModelDefaultsSettings /></SettingsDraftProvider>));
    const input = [...container.querySelectorAll('input')].find((item) => item.value === '提供商')!;
    await act(async () => setValue(input, '新提供商'));
    const authLabel = [...container.querySelectorAll('label')].find((item) => item.textContent === 'Anthropic 认证方式')!;
    await act(async () => setValue(container.querySelector(`#${authLabel.htmlFor}`) as HTMLSelectElement, 'auth-token'));
    await act(async () => [...container.querySelectorAll('button')].find((item) => item.textContent === '切换子页')!.click());
    const label = [...container.querySelectorAll('label')].find((item) => item.textContent === '应用默认模型预设')!;
    const modelSelect = container.querySelector(`#${label.htmlFor}`) as HTMLSelectElement;
    await act(async () => setValue(modelSelect, 'm1'));
    const toggle = container.querySelector('[aria-label="同步时整理原始文档"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(fixture.save).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find((item) => item.textContent === '总保存')!.click());
    expect(fixture.save).toHaveBeenCalledTimes(1);
    expect(fixture.save).toHaveBeenCalledWith(expect.objectContaining({
      llm: expect.objectContaining({ providers: [expect.objectContaining({ name: '新提供商', anthropicAuthType: 'auth-token' })], activeModelId: 'm1', contentAdaptationEnabled: true }),
      agent: expect.objectContaining({ model: expect.objectContaining({ source: 'app-llm', providerId: 'p1', modelId: 'm2' }) }),
    }));
  } finally { act(() => root.unmount()); container.remove(); }
});

it('保存失败后保留草稿，修复网络后可重试', async () => {
  fixture.save.mockRejectedValueOnce(new Error('网络不可用'));
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<SettingsDraftProvider><Controls /><ModelProviderSettings /></SettingsDraftProvider>));
    const input = [...container.querySelectorAll('input')].find((item) => item.value === '提供商')!;
    await act(async () => setValue(input, '待保存名称'));
    await act(async () => [...container.querySelectorAll('button')].find((item) => item.textContent === '总保存')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('网络不可用');
    expect(input.value).toBe('待保存名称');
    await act(async () => [...container.querySelectorAll('button')].find((item) => item.textContent === '总保存')!.click());
    expect(fixture.save).toHaveBeenCalledTimes(2);
    expect(fixture.save.mock.calls[1][0].llm.providers[0].name).toBe('待保存名称');
  } finally { act(() => root.unmount()); container.remove(); }
});
