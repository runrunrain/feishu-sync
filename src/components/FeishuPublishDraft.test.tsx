// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../api/client', () => ({
  APIError: class extends Error {},
  getConfig: async () => ({ llm: { providers: [] }, feishuPublish: { enabled: false, target: null }, feishuWrite: { enabled: false } }),
  saveConfig: api.save,
}));
vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { SettingsDraftProvider, useSettingsDraft } from '../hooks/settingsDraft';
import { FeishuPublishSettingsCard } from './FeishuPublishSettingsCard';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function Controls() { const draft = useSettingsDraft()!; return <><button onClick={() => void draft.save()}>总保存</button><span role="alert">{draft.saveError}</span></>; }
beforeEach(() => api.save.mockReset().mockResolvedValue({ llm: { providers: [] }, feishuPublish: { enabled: false, target: null } }));

it('发布根先保存在草稿，统一提交时交给服务端校验', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<SettingsDraftProvider><Controls /><FeishuPublishSettingsCard /></SettingsDraftProvider>));
    const input = container.querySelector('#publish-target-url') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://tenant.feishu.cn/wiki/ABCDEF123456'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(api.save).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === '总保存')!.click());
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ feishuPublish: expect.objectContaining({ target: expect.objectContaining({ kind: 'wiki_node', token: 'ABCDEF123456' }) }) }));
  } finally { act(() => root.unmount()); container.remove(); }
});
