/**
 * useAgentSessions —— Agent 会话列表 + 活跃会话消息流（F2 核心 hook）
 *
 * 职责：
 *   - 会话 CRUD（新建/重命名/删除/切换/模式切换）
 *   - 活跃会话权威消息加载（GET messages）
 *   - 会话 SSE 订阅（§9.3）：text_delta 流式、tool 事件、message_end 落地、
 *     run_end 收尾重拉、resync 全量重拉、断线自动重连（Last-Event-ID 续传）
 *
 * 竞态安全（任务书「切会话不串流」）：所有 SSE 事件回调与当前活跃会话
 * ref 比对，事件只作用于订阅发起时的会话；切换会话先 stop() 旧连接并
 * 丢弃迟到回调。乐观消息（本地 user 行）在权威 message_end / run_end
 * 重拉时合并，不重复。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  abortAgentSession,
  cancelAgentTask,
  createAgentSession,
  decideAgentApproval,
  deleteAgentSession,
  getAgentSessionMessages,
  getAgentSession,
  getSseAuth,
  listAgentApprovals,
  listAgentSessions,
  listAgentTasks,
  renameAgentSession,
  resumeAgentTask,
  sendAgentMessage,
  switchAgentSessionMode,
  APIError,
} from '../api/client';
import type {
  AgentBackend,
  AgentApprovalDto,
  AgentMessageDto,
  AgentSessionDto,
  AgentTaskDto,
  AgentTaskNotice,
} from '../types/agent';
import { SseConnection, type SseStatus } from '../utils/sseStream';

/** 流式中的工具行（SSE tool 事件即时态；message_end 后由权威消息接管）。 */
export interface LiveToolEvent {
  callId: string;
  name: string;
  argsSummary: string;
  phase: 'start' | 'end';
  resultSummary?: string;
  isError?: boolean;
}

/** 当前 run 的流式草稿（runId 维度；message_end/run_end 时落地）。 */
export interface RunDraft {
  runId: string;
  text: string;
  tools: LiveToolEvent[];
}

/** Work 写入记录（右侧权限面板；由历史 tool 消息 + 实时事件推导）。 */
export interface WriteRecord {
  at: string;
  tool: string;
  path: string;
  ok: boolean;
  detail: string;
}

/** 会话内待裁决的批准请求（S10：app_command 挂起流）。 */
export function isAgentApprovalDto(value: unknown): value is AgentApprovalDto {
  if (!value || typeof value !== 'object') return false;
  const approval = value as Partial<AgentApprovalDto>;
  return typeof approval.id === 'string' && approval.id.length > 0
    && typeof approval.sessionId === 'string'
    && typeof approval.command === 'string'
    && typeof approval.expiresAt === 'string';
}

// ---------------------------------------------------------------------------
// 任务编排（S7，设计 kb-agent-upgrade §5.4）：task_update SSE 合并语义。
// 纯函数导出供单测（与 mergeMessageIntoList 同模式）。
// ---------------------------------------------------------------------------

/** task_update 负载判别（畸形事件丢弃，不污染任务列表）。 */
export function isAgentTaskDto(value: unknown): value is AgentTaskDto {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<AgentTaskDto>;
  return typeof task.id === 'string' && task.id.length > 0
    && typeof task.sessionId === 'string'
    && typeof task.title === 'string'
    && ['queued', 'running', 'done', 'blocked', 'failed', 'cancelled', 'interrupted']
      .includes(String(task.status));
}

/**
 * 任务 DTO 合入列表：同 id 原位替换，其余追加（服务端按 created_at 升序返回，
 * 迟到的新任务追加在尾保持邻近语义；不重排既有项，避免展开态跳动）。不修改入参。
 */
export function mergeTaskIntoList(prev: AgentTaskDto[], task: AgentTaskDto): AgentTaskDto[] {
  const idx = prev.findIndex((t) => t.id === task.id);
  if (idx === -1) return [...prev, task];
  const copy = [...prev];
  copy[idx] = task;
  return copy;
}

/**
 * 任务态迁移 → 消息流提示文案；无变化或 queued/running 中间态返回 null
 * （子任务过程细节不入消息流，只在任务区呈现）。导出供单测。
 */
export function describeTaskNotice(task: AgentTaskDto, prev: AgentTaskDto | undefined): string | null {
  if (prev?.status === task.status) return null;
  switch (task.status) {
    case 'blocked':
      return `任务「${task.title}」等待作答`;
    case 'done':
      return `任务「${task.title}」已完成`;
    case 'failed':
      return `任务「${task.title}」失败（${task.error?.code ?? 'unknown'}）`;
    case 'cancelled':
      return `任务「${task.title}」已取消`;
    case 'interrupted':
      return `任务「${task.title}」已中断（应用重启）`;
    default:
      return null;
  }
}

export interface UseAgentSessionsResult {
  sessions: AgentSessionDto[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  activeSession: AgentSessionDto | null;
  activeId: string | null;
  messages: AgentMessageDto[];
  messagesLoading: boolean;
  draft: RunDraft | null;
  /** 本地错误行（发送失败 / run 失败且无消息承载时展示）。 */
  streamErrors: Array<{ id: string; code: string; message: string }>;
  /** 会话内待裁决批准（S10）。 */
  approvals: AgentApprovalDto[];
  /** 正在提交裁决的批准 id。 */
  approvalBusyId: string | null;
  /** 用户裁决（批准/拒绝）。 */
  decideApproval: (id: string, decision: 'approve' | 'reject') => Promise<boolean>;
  /** 当前会话的编排子任务（S7；task_update SSE 实时刷新）。 */
  tasks: AgentTaskDto[];
  /** 任务态变化的提示行（MessageStream 渲染）。 */
  taskNotices: AgentTaskNotice[];
  /** 正在提交取消/作答的任务 id（防双击）。 */
  taskBusyId: string | null;
  /** 取消任务（非终态）。 */
  cancelTask: (id: string) => Promise<boolean>;
  /** 对 blocked 任务提交作答（→ queued）。 */
  resumeTask: (id: string, message: string) => Promise<boolean>;
  sseStatus: SseStatus;
  sending: boolean;
  selecting: (id: string | null) => void;
  refreshSessions: () => void;
  createSession: (backend?: AgentBackend) => Promise<AgentSessionDto | null>;
  renameSession: (id: string, title: string) => Promise<boolean>;
  removeSession: (id: string) => Promise<boolean>;
  send: (text: string, delivery?: 'steer' | 'followUp') => Promise<boolean>;
  stop: () => Promise<void>;
  switchMode: (
    body: { mode: 'discuss' } | { mode: 'work'; workspaceId: string; confirm: 'WORK' },
  ) => Promise<boolean>;
  writeRecords: WriteRecord[];
}

const WRITE_TOOLS = ['ws_write', 'ws_edit', 'ws_mkdir'];

/** 从消息（历史）提取 Work 写入记录。 */
export function extractWriteRecords(messages: AgentMessageDto[]): WriteRecord[] {
  const records: WriteRecord[] = [];
  for (const m of messages) {
    if (m.role !== 'tool' || !m.tool) continue;
    if (!WRITE_TOOLS.includes(m.tool.name)) continue;
    records.push({
      at: m.at,
      tool: m.tool.name,
      path: extractPath(m.tool.resultSummary) || m.tool.resultSummary.slice(0, 120),
      ok: !m.tool.isError,
      detail: m.tool.resultSummary.slice(0, 160),
    });
  }
  return records.reverse(); // 最近在前
}

/**
 * 权威消息合入列表（message_end 事件）：
 * - 命中同 id → 原位替换；
 * - user 消息 → 移除同文本的乐观本地行（避免重复）；
 * - 其余 → 追加。
 * 纯函数，便于单测（SSE 事件合并语义）。 */
export function isAgentMessageDto(value: unknown): value is AgentMessageDto {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<AgentMessageDto>;
  return typeof message.id === 'string' && message.id.length > 0
    && typeof message.at === 'string' && message.at.length > 0
    && ['user', 'assistant', 'tool', 'notice'].includes(String(message.role));
}

export function mergeMessageIntoList(
  prev: AgentMessageDto[],
  message: AgentMessageDto,
  optimisticPrefix: string,
): AgentMessageDto[] {
  let next = prev.filter(
    (m) =>
      !(
        m.id.startsWith(optimisticPrefix) &&
        m.role === 'user' &&
        message.role === 'user' &&
        m.text === message.text
      ),
  );
  const idx = next.findIndex((m) => m.id === message.id);
  if (idx >= 0) {
    const copy = [...next];
    copy[idx] = message;
    next = copy;
  } else {
    next = [...next, message];
  }
  return next;
}

/** argsSummary/resultSummary 内提取首个路径样 token（server 生成，含路径）。导出供单测。 */
export function extractPath(summary: string): string {
  // 前导允许空白/引号/全角冒号等包围字符，兼容「路径：/x」与 "path": "/x" 摘要风格。
  const m = new RegExp("(?:^|[\\s'\"「：:（(])(\\/[^\\s'\"」（）)]{2,}|[A-Za-z]:\\\\[^\\s'\"」（）)]{2,})").exec(summary);
  return m ? m[1] : '';
}

export function useAgentSessions(active: boolean): UseAgentSessionsResult {
  const [sessions, setSessions] = useState<AgentSessionDto[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessageDto[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [draft, setDraft] = useState<RunDraft | null>(null);
  const [streamErrors, setStreamErrors] = useState<Array<{ id: string; code: string; message: string }>>([]);
  const [approvals, setApprovals] = useState<AgentApprovalDto[]>([]);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<AgentTaskDto[]>([]);
  const [taskNotices, setTaskNotices] = useState<AgentTaskNotice[]>([]);
  const [taskBusyId, setTaskBusyId] = useState<string | null>(null);
  const [sseStatus, setSseStatus] = useState<SseStatus>('closed');
  const [sending, setSending] = useState(false);
  const [sessionNonce, setSessionNonce] = useState(0);

  const activeIdRef = useRef<string | null>(null);
  const connectionRef = useRef<SseConnection | null>(null);
  /** 任务列表镜像：SSE 回调内读取前值推导提示行，避免在 setState 更新器里做副作用。 */
  const tasksRef = useRef<AgentTaskDto[]>([]);
  /** 乐观 user 消息的本地 id 前缀（权威数据落地时合并）。 */
  const optimisticPrefix = 'local-';

  const patchSession = useCallback((next: AgentSessionDto) => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === next.id);
      if (idx === -1) return [next, ...prev];
      const copy = [...prev];
      copy[idx] = next;
      return copy;
    });
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const list = await listAgentSessions();
      setSessions(list);
      setSessionsError(null);
      return list;
    } catch (err) {
      setSessionsError(err instanceof APIError ? err.message : '会话列表加载失败');
      return [];
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  // 首次加载会话列表；保留已选会话，否则默认选最近一个。
  useEffect(() => {
    if (!active) return;
    void loadSessions().then((list) => {
      setActiveId((cur) => {
        if (cur && list.some((s) => s.id === cur)) return cur;
        return list[0]?.id ?? null;
      });
    });
  }, [active, sessionNonce, loadSessions]);

  const refetchMessages = useCallback(async (sessionId: string) => {
    try {
      const list = await getAgentSessionMessages(sessionId);
      if (activeIdRef.current !== sessionId) return;
      setMessages(list);
    } catch {
      // 权威拉取失败：保留现有内容，SSE/重试会再给机会。
    }
  }, []);

  // 活跃会话切换：断开旧 SSE → 拉取权威消息 → 建立新 SSE。
  useEffect(() => {
    if (!active) return;
    activeIdRef.current = activeId;
    // 旧连接停掉并清空旧会话残留状态（防串流）。
    connectionRef.current?.stop();
    connectionRef.current = null;
    setDraft(null);
    setStreamErrors([]);
    setApprovals([]);
    setApprovalBusyId(null);
    setTasks([]);
    tasksRef.current = [];
    setTaskNotices([]);
    setTaskBusyId(null);
    setSseStatus('closed');

    if (!activeId) {
      setMessages([]);
      return;
    }

    let disposed = false;
    const sessionId = activeId;
    setMessagesLoading(true);
    void getAgentSessionMessages(sessionId)
      .then((list) => {
        if (!disposed && activeIdRef.current === sessionId) setMessages(list);
      })
      .catch(() => {
        // 首拉失败：如实呈现空 + 让 SSE resync/重连兜底。
        if (!disposed && activeIdRef.current === sessionId) setMessages([]);
      })
      .finally(() => {
        if (!disposed && activeIdRef.current === sessionId) setMessagesLoading(false);
      });

    // 恢复挂起中的批准请求（SSE 断线期间的 approval_request 不丢卡片）。
    void listAgentApprovals(sessionId)
      .then((list) => {
        if (!disposed && activeIdRef.current === sessionId) setApprovals(list);
      })
      .catch(() => {
        /* 列表拉取失败：SSE approval_request 事件仍会补上 */
      });

    // 编排任务列表（S7）：切换会话恢复已有任务；后续由 task_update 增量刷新。
    void listAgentTasks(sessionId)
      .then((list) => {
        if (!disposed && activeIdRef.current === sessionId) {
          tasksRef.current = list;
          setTasks(list);
        }
      })
      .catch(() => {
        /* 拉取失败：保留空列表，SSE task_update / 手动刷新再补 */
      });

    const connection = new SseConnection({
      endpoint: `/api/agent/sessions/${encodeURIComponent(sessionId)}/events`,
      getAuth: getSseAuth,
      onStatus: (s) => {
        if (activeIdRef.current === sessionId && !disposed) setSseStatus(s);
      },
      onMessage: (m) => {
        if (disposed || activeIdRef.current !== sessionId) return;
        let payload: unknown;
        try {
          payload = JSON.parse(m.data);
        } catch {
          return; // 非 JSON 事件忽略
        }
        handleSseEvent(sessionId, m.event, payload);
      },
    });
    connectionRef.current = connection;
    void connection.start();

    return () => {
      disposed = true;
      connection.stop();
      if (connectionRef.current === connection) connectionRef.current = null;
    };
    // handleSseEvent 通过闭包引用（下方 useCallback 定义后稳定）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeId]);

  /** 任务 DTO 合入（task_update SSE / 取消与作答 API 返回共用）：更新列表 + 按迁移推导提示行。 */
  const applyTaskUpdate = useCallback((task: AgentTaskDto) => {
    const before = tasksRef.current.find((t) => t.id === task.id);
    tasksRef.current = mergeTaskIntoList(tasksRef.current, task);
    setTasks(tasksRef.current);
    const notice = describeTaskNotice(task, before);
    if (notice) {
      const noticeId = `${task.id}:${task.status}:${task.rounds}`;
      setTaskNotices((prev) =>
        prev.some((n) => n.id === noticeId) ? prev : [...prev.slice(-19), { id: noticeId, text: notice }],
      );
    }
  }, []);

  const handleSseEvent = useCallback(
    (sessionId: string, event: string, payload: any) => {
      switch (event) {
        case 'session_state': {
          if (payload && typeof payload === 'object') patchSession(payload as AgentSessionDto);
          break;
        }
        case 'run_start': {
          setDraft({ runId: String(payload?.runId ?? ''), text: '', tools: [] });
          break;
        }
        case 'text_delta': {
          const delta = typeof payload?.delta === 'string' ? payload.delta : '';
          setDraft((cur) =>
            cur && cur.runId === String(payload?.runId ?? '')
              ? { ...cur, text: cur.text + delta }
              : cur,
          );
          break;
        }
        case 'tool': {
          const callId = String(payload?.callId ?? '');
          setDraft((cur) => {
            if (!cur || cur.runId !== String(payload?.runId ?? '')) return cur;
            const tools = [...cur.tools];
            const idx = tools.findIndex((t) => t.callId === callId);
            const row: LiveToolEvent = {
              callId,
              name: String(payload?.toolName ?? ''),
              argsSummary: String(payload?.argsSummary ?? ''),
              phase: payload?.phase === 'end' ? 'end' : 'start',
              resultSummary: payload?.resultSummary != null ? String(payload.resultSummary) : undefined,
              isError: payload?.isError === true,
            };
            if (idx === -1) tools.push(row);
            else tools[idx] = row;
            return { ...cur, tools };
          });
          break;
        }
        case 'message_end': {
          const message = payload?.message;
          if (!isAgentMessageDto(message)) {
            setStreamErrors((prev) => [...prev, {
              id: `invalid-message-${prev.length}`, code: 'invalid_message_event',
              message: '收到不完整的消息事件，请重连以获取已保存的会话记录。',
            }]);
            break;
          }
          setMessages((prev) => mergeMessageIntoList(prev, message, optimisticPrefix));
          if (message.role === 'assistant') {
            // 一个run可以有多轮工具调用；message_end只结束当前消息，不能丢掉后续流的run锚点。
            setDraft((cur) => (cur && cur.runId === String(payload?.runId ?? '') ? { ...cur, text: '' } : cur));
          }
          break;
        }
        case 'approval_request': {
          // S10：app_command 挂起产生的批准请求（负载即 DTO）。
          if (isAgentApprovalDto(payload)) {
            setApprovals((prev) => (prev.some((item) => item.id === payload.id) ? prev : [...prev, payload]));
          }
          break;
        }
        case 'approval_resolved': {
          const resolvedId = String(payload?.id ?? '');
          if (resolvedId) {
            setApprovals((prev) => prev.filter((item) => item.id !== resolvedId));
          }
          break;
        }
        case 'task_update': {
          // S7：负载即 AgentTaskDto；畸形事件丢弃。提示行按状态迁移推导，
          // 去重锚 id:status:rounds（blocked→作答→再 blocked 会因 rounds 变化重新提示）。
          if (isAgentTaskDto(payload)) applyTaskUpdate(payload);
          break;
        }
        case 'run_end': {
          const outcome = payload?.outcome;
          const runId = String(payload?.runId ?? '');
          if (outcome === 'failed' && payload?.error) {
            setStreamErrors((prev) => [
              ...prev,
              {
                id: `err-${runId}-${prev.length}`,
                code: String(payload.error.code ?? 'run_failed'),
                message: String(payload.error.message ?? '运行失败'),
              },
            ]);
          }
          if (outcome === 'aborted') {
            setStreamErrors((prev) => [
              ...prev,
              { id: `abort-${runId}-${prev.length}`, code: 'aborted', message: '本次生成已被停止' },
            ]);
          }
          setDraft((cur) => (cur && cur.runId === runId ? null : cur));
          // 收尾以权威数据对齐一次（用户消息/助手消息最终态）。
          void refetchMessages(sessionId);
          break;
        }
        case 'resync': {
          void refetchMessages(sessionId);
          break;
        }
        default:
          break;
      }
    },
    [patchSession, refetchMessages, applyTaskUpdate],
  );

  const decideApproval = useCallback(async (id: string, decision: 'approve' | 'reject'): Promise<boolean> => {
    const sessionId = activeIdRef.current;
    if (!sessionId) return false;
    setApprovalBusyId(id);
    try {
      await decideAgentApproval(sessionId, id, decision);
      // 成功即移除卡片（SSE approval_resolved 到达时同样幂等）。
      setApprovals((prev) => prev.filter((item) => item.id !== id));
      return true;
    } catch (err) {
      const apiErr = err instanceof APIError ? err : null;
      setStreamErrors((prev) => [
        ...prev,
        {
          id: `approval-${id}-${prev.length}`,
          code: apiErr ? String(apiErr.response?.error ?? 'approval_failed') : 'approval_failed',
          message: apiErr?.message ?? '裁决提交失败，请重试。',
        },
      ]);
      return false;
    } finally {
      setApprovalBusyId(null);
    }
  }, []);

  /** 取消任务（S7）：非终态；成功后以返回 DTO 即时刷新（SSE task_update 幂等兜底）。 */
  const cancelTask = useCallback(async (id: string): Promise<boolean> => {
    setTaskBusyId(id);
    try {
      const dto = await cancelAgentTask(id);
      applyTaskUpdate(dto);
      return true;
    } catch (err) {
      const apiErr = err instanceof APIError ? err : null;
      setStreamErrors((prev) => [
        ...prev,
        {
          id: `task-cancel-${id}-${prev.length}`,
          code: apiErr ? String(apiErr.response?.error ?? 'task_cancel_failed') : 'task_cancel_failed',
          message: apiErr?.message ?? '取消任务失败，请重试。',
        },
      ]);
      return false;
    } finally {
      setTaskBusyId(null);
    }
  }, [applyTaskUpdate]);

  /** 对 blocked 任务提交作答（S7）：→ queued；失败时任务仍 blocked，表单保留可重试。 */
  const resumeTask = useCallback(async (id: string, message: string): Promise<boolean> => {
    setTaskBusyId(id);
    try {
      const dto = await resumeAgentTask(id, message);
      applyTaskUpdate(dto);
      return true;
    } catch (err) {
      const apiErr = err instanceof APIError ? err : null;
      setStreamErrors((prev) => [
        ...prev,
        {
          id: `task-resume-${id}-${prev.length}`,
          code: apiErr ? String(apiErr.response?.error ?? 'task_resume_failed') : 'task_resume_failed',
          message: apiErr?.message ?? '作答提交失败，请重试。',
        },
      ]);
      return false;
    } finally {
      setTaskBusyId(null);
    }
  }, [applyTaskUpdate]);

  const selecting = useCallback((id: string | null) => {
    setActiveId(id);
  }, []);

  const refreshSessions = useCallback(() => setSessionNonce((n) => n + 1), []);

  const createSession = useCallback(async (backend?: AgentBackend) => {
    try {
      const created = await createAgentSession(undefined, backend);
      setSessions((prev) => [created, ...prev]);
      setActiveId(created.id);
      setMessages([]);
      return created;
    } catch (err) {
      setSessionsError(err instanceof APIError ? err.message : '新建会话失败');
      return null;
    }
  }, []);

  const renameSession = useCallback(async (id: string, title: string) => {
    try {
      const updated = await renameAgentSession(id, title);
      patchSession(updated);
      return true;
    } catch (err) {
      setSessionsError(err instanceof APIError ? err.message : '重命名失败');
      return false;
    }
  }, [patchSession]);

  const removeSession = useCallback(async (id: string) => {
    try {
      await deleteAgentSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setActiveId((cur) => {
        if (cur !== id) return cur;
        return null; // 由列表 effect 的下一次加载选择缺省
      });
      // 删除当前会话后立即重拉列表以选中最近会话。
      void loadSessions().then((list) => {
        setActiveId((cur) => (cur && list.some((s) => s.id === cur) ? cur : list[0]?.id ?? null));
      });
      return true;
    } catch (err) {
      setSessionsError(err instanceof APIError ? err.message : '删除会话失败');
      return false;
    }
  }, [loadSessions]);

  const send = useCallback(
    async (text: string, delivery?: 'steer' | 'followUp') => {
      if (!activeIdRef.current) return false;
      const sessionId = activeIdRef.current;
      setSending(true);
      // 乐观 user 行：SSE message_end 权威数据到达时按 id/文本合并。
      const optimistic: AgentMessageDto = {
        id: `${optimisticPrefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        at: new Date().toISOString(),
        text,
      };
      setMessages((prev) => [...prev, optimistic]);
      try {
        await sendAgentMessage(sessionId, { text, ...(delivery ? { delivery } : {}) });
        return true;
      } catch (err) {
        // 失败：撤回乐观行，错误由调用方 toast + streamErrors 呈现。
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        const apiErr = err instanceof APIError ? err : null;
        setStreamErrors((prev) => [
          ...prev,
          {
            id: `${optimistic.id}-err`,
            code: apiErr ? String(apiErr.response?.error ?? 'send_failed') : 'send_failed',
            message: apiErr?.message ?? '消息发送失败',
          },
        ]);
        return false;
      } finally {
        setSending(false);
      }
    },
    [],
  );

  const stop = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    try {
      await abortAgentSession(id);
      // 这是停止请求的快照，不是完成证明。迟到的streaming ACK不能覆盖较新的SSE idle。
      // 运行状态只随session_state变化，不在此伪造idle。
    } catch (err) {
      setStreamErrors((prev) => [...prev, {
        id: `abort-failed-${prev.length}`, code: 'abort_failed',
        message: err instanceof Error ? err.message : '停止请求失败，当前生成可能仍在继续。',
      }]);
    }
  }, []);

  const switchMode = useCallback(
    async (body: { mode: 'discuss' } | { mode: 'work'; workspaceId: string; confirm: 'WORK' }) => {
      const id = activeIdRef.current;
      if (!id) return false;
      try {
        const updated = await switchAgentSessionMode(id, body);
        patchSession(updated);
        // 模式切换 = 工具集变化（进程重启），历史可能新增 system 消息。
        void refetchMessages(id);
        return true;
      } catch (err) {
        setSessionsError(err instanceof APIError ? err.message : '模式切换失败');
        return false;
      }
    },
    [patchSession, refetchMessages],
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  // 会话详情兜底：列表事件之外的静态刷新（如进入页面时 state 未随事件更新）。
  useEffect(() => {
    if (!active || !activeId) return;
    let disposed = false;
    void getAgentSession(activeId)
      .then((dto) => {
        if (!disposed) patchSession(dto);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
    // 仅在会话切换时拉取一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeId]);

  const writeRecords = useMemo(() => {
    const fromHistory = extractWriteRecords(messages);
    // 实时 tool 事件中已 end 的写入（draft 内）补充在最近端。
    const fromDraft: WriteRecord[] = (draft?.tools ?? [])
      .filter((t) => t.phase === 'end' && WRITE_TOOLS.includes(t.name))
      .map((t) => ({
        at: new Date().toISOString(),
        tool: t.name,
        path: extractPath(t.argsSummary) || t.argsSummary.slice(0, 120),
        ok: !t.isError,
        detail: (t.resultSummary ?? '').slice(0, 160),
      }));
    return [...fromDraft, ...fromHistory];
  }, [messages, draft]);

  return {
    sessions,
    sessionsLoading,
    sessionsError,
    activeSession,
    activeId,
    messages,
    messagesLoading,
    draft,
    streamErrors,
    approvals,
    approvalBusyId,
    decideApproval,
    tasks,
    taskNotices,
    taskBusyId,
    cancelTask,
    resumeTask,
    sseStatus,
    sending,
    selecting,
    refreshSessions,
    createSession,
    renameSession,
    removeSession,
    send,
    stop,
    switchMode,
    writeRecords,
  };
}
