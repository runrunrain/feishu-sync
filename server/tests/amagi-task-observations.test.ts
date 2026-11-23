import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchedTaskState, projectLeaderTasks, restoreTaskCompletionObservations, taskCompletionObservation } from '../src/kb/amagi-task-observations.js';
import { BuildRuntimeHost } from '../src/kb/build-runtime-host.js';
import { BuildActorStore } from '../src/kb/build-actors.js';
import type { RuntimeBinding } from '../src/agent/build-runtime/contracts.js';
import type { LeaderActorRecord } from '../src/types/agent-knowledge.js';
const id = 'f212c7b6-a2d5-4427-a59d-a7a37461fe1f';
const actors = [{ nativeTaskId: id, role: 'luban' }];
const message = (state = 'done') => ({ role: 'custom', customType: 'amagi:task-completion', content: `[task_submit 完成 luban/f212c7b6] 状态: ${state}｜任务结果`, details: { taskId: id } });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it.each(['done', 'error', 'blocked', 'cancelled', 'interrupted'])('reads native custom string completion %s', (state) => {
  expect(taskCompletionObservation(message(state), actors)).toEqual({ nativeTaskId: id, status: state });
});
it('supports legacy text blocks and native terminal fallback headers', () => {
  expect(taskCompletionObservation({ role: 'user', content: [{ type: 'text', text: '[task_resume 完成 luban/f212c7b6] 状态: done' }] }, actors)?.status).toBe('done');
  expect(taskCompletionObservation({ ...message(), content: '[task_resume 完成 luban/f212c7b6] 终态 error（收尾异常）' }, actors)?.status).toBe('error');
  expect(dispatchedTaskState({ details: { execution: 'queued' } })).toBe('queued');
  expect(dispatchedTaskState({ details: { execution: 'invented' } })).toBeNull();
});
it('rejects mismatched task identity, unrelated custom messages, quoted body and assistant text', () => {
  for (const msg of [
    { ...message(), details: { taskId: 'other' } }, { ...message(), details: {} },
    { ...message(), customType: 'other' }, { ...message(), role: 'assistant' },
    { ...message(), content: '报告引用：\n' + message().content },
    { ...message(), content: message().content.replace('luban/', 'diting/') },
  ]) expect(taskCompletionObservation(msg, actors)).toBeNull();
});
it('restores missed persisted observations without reactivating revoked authority or changing native files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-observations-')); roots.push(root);
  const file = path.join(root, 'date_session-1.jsonl');
  const row = { type: 'custom_message', customType: 'amagi:task-completion', content: message().content, details: message().details, timestamp: '2026-11-04T14:00:00Z' };
  fs.writeFileSync(file, JSON.stringify(row) + '\n' + '{partial'); const before = fs.readFileSync(file);
  const task = { ...actors[0], execState: 'running', status: 'revoked', runtimeEpoch: 1, lastEventAt: '2026-11-04T13:00:00Z' };
  const binding = { sessionDir: root, leaderSessionId: 'session-1', launchId: 'launch', runtimeEpoch: 1 } as RuntimeBinding;
  restoreTaskCompletionObservations(binding, [task]);
  expect(task).toMatchObject({ execState: 'done', status: 'revoked', lastEventAt: row.timestamp });
  expect(fs.readFileSync(file)).toEqual(before);
  const otherEpoch = { ...task, execState: 'running', runtimeEpoch: 2 };
  restoreTaskCompletionObservations(binding, [otherEpoch]); expect(otherEpoch.execState).toBe('running');
});

it('projects a rate-limited task from its runtime archive even if the completion omitted the error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-rate-limit-'));
  roots.push(root);
  const artifacts = path.join(root, 'amagi', 'artifacts', id);
  fs.mkdirSync(artifacts, { recursive: true });
  const file = path.join(artifacts, 'metadata.json');
  const binding = { agentDir: root, runtimeEpoch: 1 } as RuntimeBinding;
  const actor: LeaderActorRecord = {
    ...actors[0], generation: 1, runtimeEpoch: 1, status: 'revoked',
    execState: 'error', parentTaskId: null, lastEventAt: '2026-11-04T14:00:00Z',
  };
  const writeMetadata = (taskId: string, category: string) => {
    fs.writeFileSync(file, JSON.stringify({
      taskId,
      providerDiagnostic: { latest: { category, model: { id: 'gemini-3.8-flash' } } },
    }));
  };

  expect(projectLeaderTasks(binding, [actor])[0].rateLimitedModel).toBeUndefined();
  writeMetadata(id, 'rate-limit');
  expect(projectLeaderTasks(binding, [actor])[0]).toMatchObject({
    execState: 'error', status: 'revoked', rateLimitedModel: 'gemini-3.8-flash',
  });
  expect(projectLeaderTasks(binding, [{ ...actor, execState: 'done' }])[0].rateLimitedModel).toBeUndefined();
  expect(projectLeaderTasks(binding, [{ ...actor, runtimeEpoch: 2 }])[0].rateLimitedModel).toBeUndefined();
  writeMetadata('another-task', 'rate-limit');
  expect(projectLeaderTasks(binding, [actor])[0].rateLimitedModel).toBeUndefined();
  writeMetadata(id, 'authentication');
  expect(projectLeaderTasks(binding, [actor])[0].rateLimitedModel).toBeUndefined();
});

it('real host conversion forwards queued dispatch and custom completion into supervisor events', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-host-observations-')); roots.push(root);
  const actorStore = new BuildActorStore({ buildId: 'b_test', stagingRoot: root, generation: 1 });
  const queue: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const session = { generation: 1, actorStore, queue };
  const host = new BuildRuntimeHost({} as ConstructorParameters<typeof BuildRuntimeHost>[0]) as unknown as {
    convertLeaderRecord: (session: unknown, event: unknown) => void;
  };
  const send = (type: string, payload: unknown) => host.convertLeaderRecord(session, { eventId: type, type, payload });
  send('tool_execution_start', { toolCallId: 'dispatch', toolName: 'task_submit', args: { agent: 'luban' } });
  send('tool_execution_end', { toolCallId: 'dispatch', toolName: 'task_submit', result: { details: { taskId: id, execution: 'queued' } } });
  expect(queue[0]).toMatchObject({ type: 'task_created', payload: { nativeTaskId: id, execState: 'queued' } });
  send('message_end', { message: message() });
  expect(queue[1]).toMatchObject({ type: 'task_state', payload: { nativeTaskId: id, status: 'done' } });
  expect(actorStore.requireConfirmedActor(id).status).toBe('confirmed');
});
