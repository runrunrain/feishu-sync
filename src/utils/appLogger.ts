/**
 * appLogger - 应用层日志工具（T9 R2.6-AC3 决策4 配套）
 *
 * Toast 仅展示用户可读摘要；完整错误（含堆栈、上下文）通过本工具
 * 写入应用日志文件，供 LogDrawer 排错查阅。
 *
 * 后端有 GET /api/logs（已存在 LogViewer 使用），但为了不引入后端
 * 改动（本 Task 仅改 src/ 前端），这里采用「双写」策略：
 *   1) console.* —— 开发态可读，且部分 console 输出可被 Electron
 *      主进程日志收集；
 *   2) 内存环形缓冲 —— Toast/LogDrawer 可读，应用重启清空（满足
 *      决策4「写入应用日志」的最小可行实现）。
 *
 * 完整磁盘持久化交由 P5 接后端日志 API 时统一处理（已标记 TODO），
 * 不在 P4-1 范围。
 */

export interface LogEntry {
  /** ISO timestamp. */
  ts: string;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  /** Optional structured detail (stack, request, etc.). */
  detail?: unknown;
}

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];
const listeners = new Set<(entries: LogEntry[]) => void>();

function emit() {
  const snapshot = buffer.slice();
  for (const l of listeners) {
    try {
      l(snapshot);
    } catch {
      // listener errors must not break logging
    }
  }
}

function push(entry: LogEntry) {
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
  emit();
}

export const appLogger = {
  info(scope: string, message: string, detail?: unknown) {
    console.info(`[${scope}] ${message}`, detail ?? '');
    push({ ts: new Date().toISOString(), level: 'info', scope, message, detail });
  },
  warn(scope: string, message: string, detail?: unknown) {
    console.warn(`[${scope}] ${message}`, detail ?? '');
    push({ ts: new Date().toISOString(), level: 'warn', scope, message, detail });
  },
  error(scope: string, message: string, detail?: unknown) {
    console.error(`[${scope}] ${message}`, detail ?? '');
    push({ ts: new Date().toISOString(), level: 'error', scope, message, detail });
  },

  /** Subscribe to log updates; returns an unsubscribe fn. */
  subscribe(listener: (entries: LogEntry[]) => void): () => void {
    listeners.add(listener);
    listener(buffer.slice());
    return () => listeners.delete(listener);
  },

  /** Read-only snapshot of the in-memory ring buffer. */
  snapshot(): LogEntry[] {
    return buffer.slice();
  },

  /** Clear the in-memory buffer (used by LogDrawer "清空"). */
  clear() {
    buffer.length = 0;
    emit();
  },
};
