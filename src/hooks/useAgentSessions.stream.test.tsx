// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ connections: [] as Array<{ onMessage: (message: { event: string; data: string }) => void }>, history: [] as unknown[] }));
vi.mock('../api/client', async (original) => ({ ...(await original<typeof import('../api/client')>()),
  listAgentSessions: vi.fn(async () => [{ id: 's1', title: 'one', state: 'idle', mode: 'discuss' }, { id: 's2', title: 'two', state: 'idle', mode: 'discuss' }]),
  getAgentSessionMessages: vi.fn(async () => fixture.history), listAgentApprovals: vi.fn(async () => []), listAgentTasks: vi.fn(async () => []),
}));
vi.mock('../utils/sseStream', () => ({ SseConnection: class {
  constructor(options: { onMessage: (message: { event: string; data: string }) => void }) { fixture.connections.push(options); }
  async start() {} stop() {}
} }));
import { useAgentSessions, reconcileMessageSnapshot, type UseAgentSessionsResult } from './useAgentSessions';
afterEach(() => { vi.useRealTimers(); fixture.connections.length = 0; fixture.history = []; });

it('flushes ordered text/tool bursts before terminal messages and cancels queued updates when switching sessions', async () => {
  vi.useFakeTimers(); const host = document.createElement('div'); const root = createRoot(host); let state: UseAgentSessionsResult;
  function Harness() { state = useAgentSessions(true); return null; }
  try {
    await act(async () => root.render(<Harness />));
    const emit = (event: string, data: unknown, connection = fixture.connections[0]) => connection.onMessage({ event, data: JSON.stringify(data) });
    await act(async () => emit('run_start', { runId: 'r' }));
    await act(async () => emit('thinking_delta', { runId: 'r', delta: '先检查结构' }));
    await act(async () => { for (let i = 0; i < 1000; i++) emit('text_delta', { runId: 'r', delta: '文' }); });
    expect(state!.draft?.text).toBe('');
    await act(async () => vi.advanceTimersByTime(50));
    expect(state!.draft?.text).toBe('文'.repeat(1000));
    expect(state!.draft?.thinking).toBe('先检查结构');
    await act(async () => {
      emit('tool', { runId: 'r', callId: 't', toolName: 'read', phase: 'start', argsSummary: 'file' });
      emit('message_end', { runId: 'r', message: { id: 'result', role: 'tool', at: 'now', tool: { callId: 't', name: 'read', resultSummary: 'done' } } });
      emit('tool', { runId: 'r', callId: 't', toolName: 'read', phase: 'end' });
      vi.advanceTimersByTime(100);
    });
    expect(state!.draft?.tools).toEqual([]); expect(state!.messages[0].tool?.resultSummary).toBe('done');
    await act(async () => { emit('text_delta', { runId: 'r', delta: 'TAIL' }); state!.selecting('s2'); });
    await act(async () => vi.advanceTimersByTime(100));
    expect(state!.activeId).toBe('s2'); expect(state!.draft).toBeNull();
    await act(async () => emit('run_start', { runId: 'r2' }, fixture.connections[1]));
    await act(async () => {
      emit('text_delta', { runId: 'r2', delta: 'final' }, fixture.connections[1]);
      emit('thinking_delta', { runId: 'r2', delta: '已确认' }, fixture.connections[1]);
      emit('message_end', { runId: 'r2', message: { id: 'final', role: 'assistant', at: 'now', text: 'final', thinking: '已确认' } }, fixture.connections[1]);
    });
    expect(state!.messages.some((message) => message.text === 'final')).toBe(true); expect(state!.draft?.text).toBe('');
    expect(state!.draft?.thinking).toBe('');
    expect(state!.messages.find((message) => message.id === 'final')?.thinking).toBe('已确认');
  } finally { act(() => root.unmount()); }
});

it('retains stable historical message references without hiding changed results', () => {
  const old = { id: 'a', role: 'assistant' as const, text: 'large response', at: 'now' };
  expect(reconcileMessageSnapshot([old], [{ ...old }])[0]).toBe(old);
  const changed = { ...old, text: 'changed' };
  expect(reconcileMessageSnapshot([old], [changed])[0]).toBe(changed);
});

it('refreshes historical thinking even when the response text is unchanged', () => {
  const previous = { id: 't', role: 'assistant' as const, at: 'now', text: 'answer', thinking: 'old' };
  const incoming = { ...previous, thinking: 'new' };
  expect(reconcileMessageSnapshot([previous], [incoming])[0]).toBe(incoming);
});
