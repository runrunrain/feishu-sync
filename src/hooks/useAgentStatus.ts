/**
 * useAgentStatus —— Agent 就绪状态（F2）
 *
 * 加载 GET /api/agent/status；支持手动 recheck；低频轮询兜底（60s，
 * 仅在页面可见时），保证「切回页面发现环境已修好」而不需要手动刷新。
 * 服务端未实现（F1 并行中）时 error 如实呈现，不假装就绪。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgentStatus, recheckAgentStatus, APIError } from '../api/client';
import type { AgentStatusDto } from '../types/agent';

export interface UseAgentStatusResult {
  status: AgentStatusDto | null;
  loading: boolean;
  /** true = 接口不可达/未实现（如 F1 尚未部署）；区别于「检测到未就绪」。 */
  unreachable: boolean;
  error: string | null;
  /** 手动重新检测（不消耗模型额度，§3.2）。 */
  recheck: () => Promise<void>;
  rechecking: boolean;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 60_000;

export function useAgentStatus(active = true): UseAgentStatusResult {
  const [status, setStatus] = useState<AgentStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [nonce, setNonce] = useState(0);
  const inFlight = useRef(false);

  const load = useCallback(async (recheckMode: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (recheckMode) setRechecking(true);
    else setLoading(true);
    try {
      const data = recheckMode ? await recheckAgentStatus() : await getAgentStatus();
      setStatus(data);
      setUnreachable(false);
      setError(null);
    } catch (err) {
      // 404/网络失败 = F1 后端未部署或 server 不可达：不可与「环境未就绪」
      // 混淆，视图按「服务不可用」呈现。
      setUnreachable(true);
      setError(err instanceof APIError ? err.message : 'Agent 状态服务不可用');
    } finally {
      inFlight.current = false;
      if (recheckMode) setRechecking(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load(false);
  }, [active, nonce, load]);

  // 低频轮询：仅页面可见时（hidden 常驻挂载下不空转）。
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void load(false);
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const recheck = useCallback(async () => {
    await load(true);
  }, [load]);

  return {
    status,
    loading,
    unreachable,
    error,
    recheck,
    rechecking,
    refresh: () => setNonce((n) => n + 1),
  };
}
