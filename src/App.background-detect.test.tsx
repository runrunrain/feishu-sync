// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { onDiffChanged } from './utils/syncEvents';

vi.mock('./components/common/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: any) => children }));
vi.mock('./components/common/Toast', () => ({ ToastProvider: ({ children }: any) => children }));
vi.mock('./hooks/useSync', () => ({ SyncProvider: ({ children }: any) => children }));
vi.mock('./hooks/useDesktopUpdate', () => ({ useDesktopUpdateBadge: () => ({ availableVersion: null }) }));
vi.mock('./components/TopBar', () => ({ TopBar: () => null }));
vi.mock('./views/Dashboard', () => ({ Dashboard: () => null }));
vi.mock('./views/SyncView', () => ({ SyncView: () => null }));
vi.mock('./views/SettingsView', () => ({ SettingsView: () => null }));
vi.mock('./views/KnowledgeView', () => ({ KnowledgeView: () => null }));
vi.mock('./views/AgentView', () => ({ AgentView: () => null }));

import App from './App';

it('桌面后台检测完成时广播刷新，卸载时取消订阅', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let checked: (() => void) | undefined;
  const unsubscribe = vi.fn();
  vi.stubGlobal('desktop', { changeNotification: { onChecked: (callback: () => void) => { checked = callback; return unsubscribe; } } });
  const changed = vi.fn(); const stop = onDiffChanged(changed);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<App />));
    expect(checked).toBeDefined();
    act(() => checked!());
    expect(changed).toHaveBeenCalledWith('background-detect');
    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally { stop(); container.remove(); vi.unstubAllGlobals(); }
});
