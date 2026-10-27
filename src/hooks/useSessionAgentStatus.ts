import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgentStatus, requestSessionAgentStatus } from '../api/client';
import { CONFIG_UPDATED_EVENT } from './useConfig';
import type { AgentSessionDto, AgentStatusDto } from '../types/agent';
/** Session overrides have their own readiness; a ready global model must not mask a broken session selection. */
export function useSessionAgentStatus(session: AgentSessionDto | null, active: boolean) {
  const id = session?.id; const model = JSON.stringify(session?.model ? { source: session.model.source, providerId: session.model.providerId, modelId: session.model.modelId, piModel: session.model.piModel } : null);
  const [status, setStatus] = useState<AgentStatusDto | null>(null);
  const [loading, setLoading] = useState(true); const [unreachable, setUnreachable] = useState(false); const [rechecking, setRechecking] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async (force = false) => {
    const version = ++generation.current; setLoading(true); setRechecking(force);
    try { const result = id ? await requestSessionAgentStatus(id, force) : await getAgentStatus(); if (version === generation.current) { setStatus(result); setUnreachable(false); } }
    catch { if (version === generation.current) setUnreachable(true); }
    finally { if (version === generation.current) { setLoading(false); setRechecking(false); } }
  }, [id]);
  useEffect(() => {
    if (!active) return;
    setStatus(null); void load(); const refresh = () => { void load(); };
    window.addEventListener(CONFIG_UPDATED_EVENT, refresh);
    return () => { generation.current++; window.removeEventListener(CONFIG_UPDATED_EVENT, refresh); };
  }, [active, model, load]);
  return { status, loading, unreachable, rechecking, recheck: () => load(true) };
}
