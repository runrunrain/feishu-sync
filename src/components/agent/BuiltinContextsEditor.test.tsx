// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ update: vi.fn(), create: vi.fn(), get: vi.fn() }));
vi.mock('../../api/client', () => ({
  APIError: class extends Error {},
  getConfig: async () => ({ llm: { providers: [] } }),
  saveConfig: vi.fn(),
  getAgentPlugins: mocks.get,
  updateAgentPlugin: mocks.update,
  createAgentPlugin: mocks.create,
  deleteAgentPlugin: vi.fn(), resetAgentPlugin: vi.fn(),
}));
vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { BuiltinContextsEditor } from './BuiltinContextsEditor';
import { SettingsDraftProvider, useSettingsDraft } from '../../hooks/settingsDraft';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plugin = (id: string, name: string) => ({ id, name, kind: 'context', builtin: true, description: '', enabled: true, scopes: ['discuss'], content: `原文${id}` });
const snapshot = (revision: string) => ({ revision, plugins: [plugin('a', '配置 A'), plugin('b', '配置 B')] });
function Controls() { const draft = useSettingsDraft()!; return <><button onClick={() => void draft.save()}>总保存</button><span role="alert">{draft.saveError}</span></>; }
function edit(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(snapshot('rev0'));
  mocks.update.mockReset().mockResolvedValueOnce(snapshot('rev1')).mockRejectedValueOnce(new Error('网络错误')).mockResolvedValueOnce(snapshot('rev2'));
  mocks.create.mockReset();
});

it('切换上下文项保留草稿，部分保存失败后只重试尚未保存的项', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const click = async (label: string) => act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!.click());
  try {
    await act(async () => root.render(<SettingsDraftProvider><Controls /><BuiltinContextsEditor /></SettingsDraftProvider>));
    await act(async () => edit(container.querySelector('textarea')!, '修改 A'));
    await click('配置 B');
    await act(async () => edit(container.querySelector('textarea')!, '修改 B'));
    await click('配置 A');
    expect(container.querySelector('textarea')!.value).toBe('修改 A');
    expect(mocks.update).not.toHaveBeenCalled();
    await click('总保存');
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('网络错误');
    await click('总保存');
    expect(mocks.update).toHaveBeenCalledTimes(3);
    expect(mocks.update.mock.calls[2][0]).toBe('b');
    expect(mocks.update.mock.calls[2][1]).toBe('rev1');
  } finally { act(() => root.unmount()); container.remove(); }
});
