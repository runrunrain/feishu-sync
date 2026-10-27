/** 用受控React effect生命周期验证共享请求，不依赖DOM或远程模型。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
const lifecycle = vi.hoisted(() => ({ cleanups: [] as (() => void)[] }));
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | undefined) => { const cleanup = effect(); if (cleanup) lifecycle.cleanups.push(cleanup); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock('./useConfig', () => ({ CONFIG_UPDATED_EVENT: 'config-updated' }));
vi.mock('../api/client', () => ({ getAgentStatus: vi.fn(), recheckAgentStatus: vi.fn(), APIError: class extends Error {} }));
afterEach(() => { lifecycle.cleanups.splice(0).reverse().forEach((cleanup) => cleanup()); vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules(); vi.clearAllMocks(); });
async function setup() {
  vi.useFakeTimers(); const events = new EventTarget();
  vi.stubGlobal('window', { setInterval, clearInterval, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  const api = await import('../api/client'); const hook = await import('./useAgentStatus');
  const ready = { code: 'ready', checkedAt: 'fixture-time' } as Awaited<ReturnType<typeof api.getAgentStatus>>;
  vi.mocked(api.getAgentStatus).mockResolvedValue(ready); vi.mocked(api.recheckAgentStatus).mockResolvedValue(ready);
  return { ...hook, api, events, ready };
}
describe('跨页面共享Pi就绪状态', () => {
  it('多个消费者和页面切换复用结果，仅有一个轮询器；重检绕过缓存', async () => {
    const { useAgentStatus, api, events } = await setup();
    useAgentStatus(); useAgentStatus(); await Promise.resolve(); await Promise.resolve();
    expect(api.getAgentStatus).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
    useAgentStatus(); expect(api.getAgentStatus).toHaveBeenCalledOnce();
    events.dispatchEvent(new Event('config-updated')); await Promise.resolve(); await Promise.resolve();
    expect(api.getAgentStatus).toHaveBeenCalledTimes(2);
    const result = useAgentStatus(); await result.recheck(); expect(api.recheckAgentStatus).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(299_999); expect(api.getAgentStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(api.getAgentStatus).toHaveBeenCalledTimes(3);
  });
  it('离开Agent页面后保存配置，回来时立即刷新而非复用旧状态', async () => {
    const { useAgentStatus, api, events } = await setup();
    useAgentStatus(); await Promise.resolve(); await Promise.resolve();
    lifecycle.cleanups.splice(0).forEach((cleanup) => cleanup());
    expect(vi.getTimerCount()).toBe(0);
    events.dispatchEvent(new Event('config-updated')); expect(api.getAgentStatus).toHaveBeenCalledOnce();
    useAgentStatus(); await Promise.resolve(); await Promise.resolve(); expect(api.getAgentStatus).toHaveBeenCalledTimes(2);
  });
  it('检测中修改配置会排队刷新，避免丢掉新配置', async () => {
    const { useAgentStatus, api, events, ready } = await setup();
    let resolve!: (value: typeof ready) => void;
    vi.mocked(api.getAgentStatus).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    useAgentStatus(); events.dispatchEvent(new Event('config-updated')); expect(api.getAgentStatus).toHaveBeenCalledOnce();
    resolve(ready); await vi.advanceTimersByTimeAsync(0); expect(api.getAgentStatus).toHaveBeenCalledTimes(2);
  });
});
