/** 跨页面共享就绪状态；五分钟复用，手动重检强制刷新，并发请求合并。 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getAgentStatus, recheckAgentStatus, APIError } from '../api/client';
import type { AgentStatusDto } from '../types/agent';
import { CONFIG_UPDATED_EVENT } from './useConfig';

export interface UseAgentStatusResult {
  status: AgentStatusDto | null;
  loading: boolean;
  unreachable: boolean;
  error: string | null;
  recheck: () => Promise<void>;
  rechecking: boolean;
  refresh: () => void;
}
let state = { status: null as AgentStatusDto | null, loading: true, unreachable: false, error: null as string | null, rechecking: false };
let lastRead = 0;
let pending: Promise<void> | null = null;
let configChanged = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => state;
const publish = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };
async function load(force = false, changed = false): Promise<void> {
  if (pending) { if (changed) configChanged = true; return pending; }
  const ttl = state.unreachable || state.status?.code !== 'ready' ? 30_000 : 300_000;
  if (!force && !changed && lastRead && Date.now() - lastRead < ttl) return;
  publish({ loading: !state.status, rechecking: force });
  pending = (async () => {
    try { publish({ status: await (force ? recheckAgentStatus() : getAgentStatus()), unreachable: false, error: null }); }
    catch (error) { publish({ unreachable: true, error: error instanceof APIError ? error.message : 'Agent 状态服务不可用' }); }
    finally { lastRead = Date.now(); pending = null; publish({ loading: false, rechecking: false });
      if (configChanged) { configChanged = false; queueMicrotask(() => { void load(false, true); }); }
    }
  })();
  return pending;
}
let activeConsumers = 0;
let pollTimer: number | null = null;
let configListenerInstalled = false;
const configUpdated = () => {
  lastRead = 0;
  if (activeConsumers > 0) void load(false, true);
};
function activate() {
  if (!configListenerInstalled) {
    window.addEventListener(CONFIG_UPDATED_EVENT, configUpdated);
    configListenerInstalled = true;
  }
  if (++activeConsumers === 1) {
    pollTimer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 300_000);
  }
  void load();
  return () => {
    if (--activeConsumers === 0) {
      if (pollTimer !== null) window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}
export function useAgentStatus(active = true): UseAgentStatusResult {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { if (active) return activate(); }, [active]);
  const recheck = useCallback(() => load(true), []);
  const refresh = useCallback(() => { void load(false, true); }, []);
  return { ...current, recheck, refresh };
}
