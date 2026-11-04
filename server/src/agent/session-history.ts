import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { AgentMessageDto } from '../types/agent-knowledge.js';

interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    stopReason?: string;
    model?: string;
    timestamp?: number;
  };
}

export function toToolMessageDto(message: NonNullable<SessionEntry['message']>, id: string, at = new Date().toISOString()): AgentMessageDto {
  let summary = '';
  if (Array.isArray(message.content)) for (const block of message.content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      summary += block.text.slice(0, 301 - summary.length);
      if (summary.length > 300) break;
    }
  }
  return { id, role: 'tool', at, tool: { callId: String(message.toolCallId ?? ''), name: String(message.toolName ?? ''),
    isError: message.isError === true, resultSummary: summary.length > 300 ? summary.slice(0, 300) + '…' : summary } };
}

interface HistoryNode { id: string; parentId: string | null; message: AgentMessageDto | null }
interface HistoryState {
  inode: number; dev: number; mtime: number; readBytes: number; tail: string; decoder: StringDecoder;
  nodes: Map<string, HistoryNode>; lastId: string | null; messages: AgentMessageDto[];
}

function project(entry: SessionEntry): HistoryNode {
  const raw = entry.type === 'message' ? entry.message : null;
  let message: AgentMessageDto | null = null;
  if (raw?.role) {
    const at = new Date(typeof raw.timestamp === 'number' ? raw.timestamp : Date.parse(entry.timestamp) || Date.now()).toISOString();
    if (raw.role === 'user') {
      const text = typeof raw.content === 'string' ? raw.content : Array.isArray(raw.content)
        ? raw.content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('') : '';
      message = { id: entry.id, role: 'user', at, text };
    } else if (raw.role === 'assistant') message = { ...toAssistantMessageDto(raw, entry.id), at };
    else if (raw.role === 'toolResult') message = toToolMessageDto(raw, entry.id, at);
    else if (raw.role === 'system') message = { id: entry.id, role: 'notice', at, text: '系统消息（工具装载/提示变化）' };
  }
  return { id: entry.id, parentId: entry.parentId, message };
}

/** Append-only Pi history cache: async chunk reads, compact DTO nodes, bounded session count, branch-aware. */
export class SessionHistoryCache {
  private readonly states = new Map<string, HistoryState>();
  private readonly pending = new Map<string, Promise<AgentMessageDto[]>>();
  read(file: string): Promise<AgentMessageDto[]> {
    // A concurrent caller may arrive after the native agent appended another message.
    // Await the earlier snapshot, then check the current size rather than returning stale history.
    const previous = this.pending.get(file); if (previous) return previous.then(() => this.read(file));
    const task = this.load(file).finally(() => this.pending.delete(file)); this.pending.set(file, task); return task;
  }
  private async load(file: string): Promise<AgentMessageDto[]> {
    const stat = await fs.promises.stat(file);
    let state = this.states.get(file);
    if (!state || state.inode !== stat.ino || state.dev !== stat.dev || stat.size < state.readBytes
      || stat.size === state.readBytes && stat.mtimeMs !== state.mtime) {
      state = { inode: stat.ino, dev: stat.dev, mtime: stat.mtimeMs, readBytes: 0, tail: '', decoder: new StringDecoder('utf8'),
        nodes: new Map(), lastId: null, messages: [] };
    } else if (stat.size === state.readBytes && stat.mtimeMs === state.mtime) {
      this.states.delete(file); this.states.set(file, state); return state.messages;
    }
    const current = state;
    const addLine = (line: string) => {
      try {
        const entry = JSON.parse(line) as SessionEntry;
        if (entry.type !== 'session' && typeof entry.id === 'string') {
          current.nodes.set(entry.id, project(entry)); current.lastId = entry.id;
        }
      } catch { /* Incomplete/broken JSONL entries do not hide earlier valid history. */ }
    };
    const handle = await fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      while (current.readBytes < stat.size) {
        const read = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - current.readBytes), current.readBytes);
        if (!read.bytesRead) break;
        current.readBytes += read.bytesRead;
        const lines = (current.tail + current.decoder.write(buffer.subarray(0, read.bytesRead))).split('\n');
        current.tail = lines.pop() ?? '';
        for (let index = 0; index < lines.length; index++) {
          addLine(lines[index]);
          if (index > 0 && index % 128 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      if (current.tail) addLine(current.tail);
    } finally { await handle.close(); }
    const branch: AgentMessageDto[] = []; const visited = new Set<string>();
    let node = current.lastId ? current.nodes.get(current.lastId) : undefined;
    while (node && !visited.has(node.id)) {
      visited.add(node.id); if (node.message) branch.push(node.message);
      node = node.parentId ? current.nodes.get(node.parentId) : undefined;
    }
    current.messages = branch.reverse(); current.mtime = stat.mtimeMs;
    this.states.delete(file); this.states.set(file, current);
    while (this.states.size > 8) this.states.delete(this.states.keys().next().value!);
    return current.messages;
  }
}

/**
 * 解析 JSONL：首行 header 跳过；树回溯索引【全部】带 id/parentId 的
 * 节点（F3-R11）。若只索引 message，compaction/model_change 等夹在
 * 消息链中间时 parentId 链断在非消息节点，更早的分支被截断丢失；
 * 回溯起点取文件顺序最后一个节点（当前叶子，可能是 compaction 等
 * 非消息节点），分支输出阶段才过滤为消息。
 */
export function parseSessionJsonl(content: string): AgentMessageDto[] {
  const indexed: SessionEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as SessionEntry;
      if (parsed.type === 'session') continue; // header
      if (parsed.id) {
        indexed.push(parsed);
      }
    } catch {
      /* 跳过损坏行 */
    }
  }
  if (indexed.length === 0) return [];

  // 树回溯：从文件顺序最后一个节点沿 parentId 回溯当前分支
  const byId = new Map(indexed.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  let cursor: SessionEntry | undefined = indexed[indexed.length - 1];
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    branch.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }

  const result: AgentMessageDto[] = [];
  for (const entry of branch.reverse()) {
    if (entry.type !== 'message') continue; // 非消息节点只参与树结构，不进消息流
    const message = entry.message;
    if (!message?.role) continue;
    const at = new Date(typeof message.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp) || Date.now()).toISOString();
    if (message.role === 'user') {
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: string }).text ?? '') : '')).join('')
          : '';
      result.push({ id: entry.id, role: 'user', at, text });
    } else if (message.role === 'assistant') {
      const dto = toAssistantMessageDto(message, entry.id);
      result.push({ ...dto, at });
    } else if (message.role === 'toolResult') {
      result.push(toToolMessageDto(message, entry.id, at));
    } else if (message.role === 'system') {
      result.push({ id: entry.id, role: 'notice', at, text: '系统消息（工具装载/提示变化）' });
    }
    // 未知 role 跳过
  }
  return result;
}

export function toAssistantMessageDto(message: unknown, id: string): AgentMessageDto {
  const msg = (message && typeof message === 'object' ? message : {}) as {
    content?: unknown;
    stopReason?: string;
    model?: string;
    usage?: unknown;
  };
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: AgentMessageDto['toolCalls'] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') {
      textParts.push(typed.text);
    } else if (typed.type === 'thinking' && typeof typed.thinking === 'string') {
      thinkingParts.push(typed.thinking);
    } else if (typed.type === 'toolCall') {
      toolCalls.push({
        id: String(typed.id ?? ''),
        name: String(typed.name ?? ''),
        argsSummary: JSON.stringify(typed.arguments ?? {}).slice(0, 200),
      });
    }
  }
  const error = msg.stopReason === 'error'
    ? { code: 'model_request_failed', message: textParts.join('').slice(0, 300) || '模型返回 error' }
    : undefined;
  return {
    // RPC Message 没有持久 entry id；live id 仅用于本轮UI，run_end后由JSONL权威历史替换。
    id,
    role: 'assistant',
    at: new Date().toISOString(),
    ...(textParts.length > 0 ? { text: textParts.join('') } : {}),
    ...(thinkingParts.length > 0 ? { thinking: thinkingParts.join('') } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(error ? { error } : {}),
    ...(msg.model ? { model: msg.model } : {}),
  };
}

