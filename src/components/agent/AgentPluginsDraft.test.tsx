// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ list: vi.fn(), manage: vi.fn() }));
vi.mock('../../api/client', () => ({
  APIError: class extends Error {},
  getConfig: async () => ({ llm: { providers: [] } }),
  saveConfig: vi.fn(),
  listPiPlugins: api.list,
  managePiPlugin: api.manage,
}));
vi.mock('./BuiltinContextsEditor', () => ({ BuiltinContextsEditor: () => null }));
import { AgentPluginsCard } from './AgentPluginsCard';
import { SettingsDraftProvider, useSettingsDraft } from '../../hooks/settingsDraft';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plugin = (id: string, name: string, enabled: boolean) => ({ id, name, enabled, sourceType: 'local', source: id, description: '', resources: [] });
const snapshot = (revision: string, a = true, b = true) => ({ revision, packages: [plugin('a', '插件 A', a), plugin('b', '插件 B', b)] });
function Controls() { const draft = useSettingsDraft()!; return <><button onClick={() => void draft.save()}>总保存</button><span role="alert">{draft.saveError}</span></>; }
beforeEach(() => {
  api.list.mockReset().mockResolvedValue(snapshot('rev0'));
  api.manage.mockReset().mockResolvedValueOnce(snapshot('rev1', false)).mockRejectedValueOnce(new Error('网络错误')).mockResolvedValueOnce(snapshot('rev2', false, false));
});

it('插件启停随总保存提交，部分失败时只重试尚未完成的项', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const click = async (label: string) => act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(label))!.click());
  try {
    await act(async () => root.render(<SettingsDraftProvider><Controls /><AgentPluginsCard /></SettingsDraftProvider>));
    await click('停用插件');
    await click('插件 B');
    await click('停用插件');
    expect(container.textContent).toContain('待停用');
    expect(api.manage).not.toHaveBeenCalled();
    await click('总保存');
    expect(api.manage).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('网络错误');
    await click('总保存');
    expect(api.manage).toHaveBeenCalledTimes(3);
    expect(api.manage).toHaveBeenLastCalledWith('toggle', 'rev1', { id: 'b', enabled: false });
  } finally { act(() => root.unmount()); container.remove(); }
});
