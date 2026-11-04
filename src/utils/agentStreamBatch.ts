import type { RunDraft, LiveToolEvent } from '../hooks/useAgentSessions';

export type DraftUpdate = { event: 'text_delta' | 'thinking_delta' | 'tool'; payload: {
  runId?: unknown; delta?: unknown; callId?: unknown; toolName?: unknown; argsSummary?: unknown;
  phase?: unknown; resultSummary?: unknown; isError?: unknown;
} };

/** Apply a burst once: concatenate text once and retain unchanged tool object identities. */
export function applyDraftUpdates(current: RunDraft | null, updates: DraftUpdate[]): RunDraft | null {
  if (!current) return current;
  const deltas: string[] = []; const thoughts: string[] = []; let tools: LiveToolEvent[] | null = null;
  const indices = new Map(current.tools.map((tool, index) => [tool.callId, index]));
  for (const { event, payload } of updates) {
    if (current.runId !== String(payload.runId ?? '')) continue;
    if (event === 'thinking_delta') {
      if (typeof payload.delta === 'string' && payload.delta) thoughts.push(payload.delta);
      continue;
    }
    if (event === 'text_delta') {
      if (typeof payload.delta === 'string' && payload.delta) deltas.push(payload.delta);
      continue;
    }
    const callId = String(payload.callId ?? ''); if (!callId) continue;
    tools ??= [...current.tools]; const index = indices.get(callId);
    const previous = index === undefined ? undefined : tools[index];
    const tool: LiveToolEvent = { callId, name: String(payload.toolName ?? '') || previous?.name || '',
      argsSummary: String(payload.argsSummary ?? '') || previous?.argsSummary || '',
      phase: payload.phase === 'end' ? 'end' : 'start',
      resultSummary: payload.resultSummary != null ? String(payload.resultSummary) : previous?.resultSummary,
      isError: payload.isError === true };
    if (index === undefined) { indices.set(callId, tools.length); tools.push(tool); } else tools[index] = tool;
  }
  return tools || deltas.length || thoughts.length ? { ...current, ...(thoughts.length ? { thinking: (current.thinking ?? '') + thoughts.join('') } : {}), text: deltas.length ? current.text + deltas.join('') : current.text, tools: tools ?? current.tools } : current;
}
