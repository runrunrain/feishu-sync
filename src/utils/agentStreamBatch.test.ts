import { expect, it } from 'vitest';
import { applyDraftUpdates, type DraftUpdate } from './agentStreamBatch';

it('coalesces a large event burst without losing text or tool argument/result pairs', () => {
  const updates: DraftUpdate[] = Array.from({ length: 2000 }, (_, index) => ({ event: 'text_delta', payload: { runId: 'r', delta: String(index % 10) } }));
  updates.splice(100, 0, { event: 'tool', payload: { runId: 'r', callId: 'a', toolName: 'raw_read', argsSummary: 'source', phase: 'start' } });
  updates.push({ event: 'tool', payload: { runId: 'r', callId: 'a', phase: 'end', resultSummary: 'done' } });
  updates.push({ event: 'text_delta', payload: { runId: 'old', delta: 'STALE' } });
  const result = applyDraftUpdates({ runId: 'r', text: '', tools: [] }, updates)!;
  expect(result.text).toBe('0123456789'.repeat(200));
  expect(result.tools).toEqual([{ callId: 'a', name: 'raw_read', argsSummary: 'source', phase: 'end', resultSummary: 'done', isError: false }]);
});

it('preserves unchanged draft and tool references, and never creates a draft from stale events', () => {
  const tool = { callId: 'done', name: 'raw_read', argsSummary: '', phase: 'end' as const };
  const draft = { runId: 'r', text: 'first', tools: [tool] };
  expect(applyDraftUpdates(draft, [{ event: 'text_delta', payload: { runId: 'old', delta: 'bad' } }])).toBe(draft);
  expect(applyDraftUpdates(draft, [{ event: 'text_delta', payload: { runId: 'r', delta: ' second' } }])?.tools).toBe(draft.tools);
  expect(applyDraftUpdates(null, [{ event: 'text_delta', payload: { runId: 'r', delta: 'bad' } }])).toBeNull();
});
