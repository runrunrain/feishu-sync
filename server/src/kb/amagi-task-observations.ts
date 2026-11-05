/** Native task observations affect progress only; they never grant write authority. */
import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeBinding } from '../agent/build-runtime/contracts.js';

interface TaskIdentity { nativeTaskId: string; role: string }
const STATES = new Set(['queued', 'running', 'done', 'failed', 'error', 'cancelled', 'interrupted', 'blocked']);
const TERMINAL = new Set(['done', 'failed', 'error', 'cancelled', 'interrupted']);
export function dispatchedTaskState(result: unknown): string | null {
  const details = (result as { details?: { execution?: unknown } } | null)?.details;
  return typeof details?.execution === 'string' && STATES.has(details.execution) ? details.execution : null;
}
export function taskCompletionObservation(message: unknown, actors: TaskIdentity[]): { nativeTaskId: string; status: string } | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as { role?: string; customType?: string; content?: unknown; text?: string; details?: { taskId?: unknown } };
  if (msg.role !== 'user' && !(msg.role === 'custom' && msg.customType === 'amagi:task-completion')) return null;
  const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content)
    ? msg.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : msg.text ?? '';
  // Only the native header is a status assertion. Quoted notices inside reports are not.
  const match = /^\[task_(?:submit|resume) 完成 ([a-z-]+)\/([0-9a-f]{8})\]\s*(?:状态:\s*|终态\s+)([\w-]+)/i.exec(text);
  if (!match || !STATES.has(match[3]) || ['running', 'queued'].includes(match[3])) return null;
  const id = msg.role === 'custom' ? msg.details?.taskId : undefined;
  if (msg.role === 'custom' && typeof id !== 'string') return null;
  const matches = actors.filter((actor) => actor.role === match[1] && actor.nativeTaskId.toLowerCase().startsWith(match[2].toLowerCase())
    && (id === undefined || actor.nativeTaskId === id));
  return matches.length === 1 ? { nativeTaskId: matches[0].nativeTaskId, status: match[3] } : null;
}

interface ObservedActor extends TaskIdentity { execState: string | null; lastEventAt: string; runtimeEpoch?: number }
const restored = new Map<string, Array<{ message: unknown; at: string }>>();
/** Recover notices missed by older hosts once per launch/session, without editing native history. */
export function restoreTaskCompletionObservations(binding: RuntimeBinding | null, actors: ObservedActor[]): void {
  if (!binding?.sessionDir || !binding.leaderSessionId || /[/\\]/.test(binding.leaderSessionId)) return;
  const key = `${binding.sessionDir}\0${binding.leaderSessionId}\0${binding.launchId}`;
  let messages = restored.get(key);
  if (!messages) {
    messages = [];
    try {
      const matches = fs.readdirSync(binding.sessionDir).filter((name) => name.endsWith(`_${binding.leaderSessionId}.jsonl`));
      if (matches.length !== 1) return;
      const file = path.join(binding.sessionDir, matches[0]);
      if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(binding.sessionDir) || fs.statSync(file).size > 32 * 1024 * 1024) return;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'custom_message' && entry.customType === 'amagi:task-completion') {
            messages.push({ message: { ...entry, role: 'custom' }, at: entry.timestamp });
          } else if (entry.type === 'message' && entry.message?.role === 'user') messages.push({ message: entry.message, at: entry.timestamp });
        } catch { /* Incomplete append or an unrelated malformed entry is not a completion. */ }
      }
    } catch { return; }
    restored.set(key, messages);
    while (restored.size > 4) restored.delete(restored.keys().next().value!);
  }
  for (const { message, at } of messages) {
    const observation = taskCompletionObservation(message, actors);
    const actor = observation ? actors.find((row) => row.nativeTaskId === observation.nativeTaskId) : undefined;
    if (!actor || TERMINAL.has(actor.execState ?? '') || actor.runtimeEpoch != null && binding.runtimeEpoch != null && actor.runtimeEpoch !== binding.runtimeEpoch) continue;
    actor.execState = observation!.status;
    if (typeof at === 'string' && Number.isFinite(Date.parse(at)) && at > actor.lastEventAt) actor.lastEventAt = at;
  }
}
