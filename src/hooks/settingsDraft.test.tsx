// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock('../api/client', () => ({ getConfig: api.get, saveConfig: api.save, APIError: class extends Error {} }));
import { SettingsDraftProvider, useSettingsDraft, useSettingsForm } from './settingsDraft';
import { useConfig } from './useConfig';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const config = { knowledgeBaseRoot: 'old', pollIntervalMinutes: 30, watchedRoots: [],
  enableNotifications: false, llm: { providers: [] }, agent: { runtime: { backend: 'pi', nodePath: 'old-node' }, model: { source: 'app-llm', thinkingLevel: 'off' }, workspaces: [] },
  standardKb: { outputRoot: 'old-output', buildBatchWordBudget: 40000 } };
function Panel() {
  const { config: current, updateConfig } = useConfig(); const context = useSettingsDraft()!;
  const [text, setText] = useState('old-output'); const [invalid, setInvalid] = useState(false);
  useSettingsForm('form', () => {
    if (invalid) throw new Error('预算无效');
    if (!current?.standardKb || text === current.standardKb.outputRoot) return null;
    return { standardKb: { ...current.standardKb, outputRoot: text } };
  });
  return <>
    <button onClick={() => setText('new-output')}>修改表单</button>
    <button onClick={() => setInvalid(!invalid)}>切换错误</button>
    <button onClick={() => void updateConfig({ enableNotifications: true })}>修改开关</button>
    <button onClick={() => context.stageForm('form')}>离开子页</button>
    <button onClick={() => void context.refresh()}>刷新</button>
    <button onClick={() => void context.save()}>保存</button>
    <span data-testid="local">{text}</span><span data-testid="draft">{String(current?.enableNotifications)}</span>
    <span data-testid="dirty">{String(context.dirty)}</span><span role="alert">{context.saveError}</span>
  </>;
}
function NestedForms() {
  const { config: current } = useConfig(); const draft = useSettingsDraft()!;
  useSettingsForm('provider', () => current?.agent ? { agent: { ...current.agent, model: { ...current.agent.model, providerId: 'provider-1' } } } : null);
  useSettingsForm('runtime', () => current?.agent ? { agent: { ...current.agent, runtime: { ...current.agent.runtime, nodePath: 'node-new' } } } : null);
  return <button onClick={() => void draft.save()}>保存</button>;
}
const action = vi.fn();
function ActionPanel() {
  const { updateConfig } = useConfig(); const draft = useSettingsDraft()!;
  return <><button onClick={() => { void updateConfig({ enableNotifications: true }); draft.stageAction('专用设置', action); }}>修改</button>
    <button onClick={() => void draft.save()}>保存</button><span role="alert">{draft.saveError}</span></>;
}
function ProviderConflictPanel() {
  const { updateConfig } = useConfig(); const draft = useSettingsDraft()!;
  return <><button onClick={() => void updateConfig({ llm: { providers: [{ id: 'mine', name: '我的草稿', enabled: true, apiKey: '', openAiCompatBaseUrl: '', models: [] }] } })}>修改</button>
    <button onClick={() => void draft.save()}>保存</button><button onClick={() => void draft.allowConflictOverwrite()}>允许覆盖</button><span role="alert">{draft.saveError}</span></>;
}
beforeEach(() => {
  api.get.mockReset().mockResolvedValue(structuredClone(config));
  api.save.mockReset().mockResolvedValue(structuredClone(config));
  action.mockReset();
});

it('不同子页同时修改 Agent 模型和运行时不会互相覆盖', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<SettingsDraftProvider><NestedForms /></SettingsDraftProvider>));
    await act(async () => container.querySelector('button')!.click());
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ agent: expect.objectContaining({
      model: expect.objectContaining({ providerId: 'provider-1' }), runtime: expect.objectContaining({ nodePath: 'node-new' }),
    }) }));
  } finally { act(() => root.unmount()); container.remove(); }
});

it('专用操作失败时保留该操作，重试不重复提交已成功的配置', async () => {
  action.mockRejectedValueOnce(new Error('专用接口失败')).mockResolvedValueOnce(undefined);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const click = async (text: string) => act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === text)!.click());
  try {
    await act(async () => root.render(<SettingsDraftProvider><ActionPanel /></SettingsDraftProvider>));
    await click('修改'); await click('保存');
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('其他配置可能已保存');
    await click('保存');
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); container.remove(); }
});

it('其他窗口修改提供商列表时拒绝覆盖并保留草稿', async () => {
  const latest = { ...structuredClone(config), llm: { providers: [{ id: 'external' }] } };
  api.get.mockResolvedValueOnce(structuredClone(config)).mockResolvedValue(latest);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const click = async (text: string) => act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === text)!.click());
  try {
    await act(async () => root.render(<SettingsDraftProvider><ProviderConflictPanel /></SettingsDraftProvider>));
    await click('修改'); await click('保存');
    expect(api.save).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('模型提供商已被其他操作更改');
    await click('允许覆盖'); await click('保存');
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ llm: expect.objectContaining({ providers: [expect.objectContaining({ id: 'mine' })] }) }));
  } finally { act(() => root.unmount()); container.remove(); }
});

it('草稿跨子页和刷新保留，保存时一次提交表单与开关', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const click = async (text: string) => act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === text)!.click());
  try {
    await act(async () => root.render(<SettingsDraftProvider><Panel /></SettingsDraftProvider>));
    await click('修改表单'); await click('修改开关'); await click('离开子页'); await click('刷新');
    expect(container.querySelector('[data-testid="local"]')?.textContent).toBe('new-output');
    expect(container.querySelector('[data-testid="draft"]')?.textContent).toBe('true');
    expect(api.save).not.toHaveBeenCalled();
    await click('保存');
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ enableNotifications: true, standardKb: expect.objectContaining({ outputRoot: 'new-output' }) }));
  } finally { act(() => root.unmount()); container.remove(); }
});

it('无效表单阻止提交，修正后仍可保存所有草稿', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const click = async (text: string) => act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === text)!.click());
  try {
    await act(async () => root.render(<SettingsDraftProvider><Panel /></SettingsDraftProvider>));
    await click('修改开关'); await click('切换错误'); await click('保存');
    expect(api.save).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('预算无效');
    expect(container.querySelector('[data-testid="draft"]')?.textContent).toBe('true');
    await click('切换错误'); await click('保存');
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ enableNotifications: true }));
  } finally { act(() => root.unmount()); container.remove(); }
});
