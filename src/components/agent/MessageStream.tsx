/**
 * MessageStream —— Agent 消息流（AgentView 中栏，§11.3）
 *
 * 渲染：user 气泡 / assistant 文本（流式草稿 + 权威消息）/ tool 折叠行
 * （进行中 spinner、失败红、完成勾）/ notice 居中弱化 / 错误行
 * （code + message，绝不伪装成助手回复）。
 * 自动滚底：接近底部时新内容贴底；用户上翻阅读时不打扰。
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Ban, Check, ChevronDown, ListTodo, Loader2, Wrench } from 'lucide-react';
import type { RunDraft } from '../../hooks/useAgentSessions';
import type { AgentApprovalDto, AgentMessageDto, AgentTaskNotice } from '../../types/agent';
import { MarkdownView } from '../preview/MarkdownView';
import { ApprovalCard } from './ApprovalCard';
import { ChatAttachmentCards } from './ChatAttachmentCards';
const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  return <MarkdownView content={content} remoteImages="confirm" />;
});
const HISTORY_PAGE = 80;

interface MessageStreamProps {
  workMode?: boolean;
  sessionId?: string;
  messages: AgentMessageDto[];
  draft: RunDraft | null;
  streamErrors: Array<{ id: string; code: string; message: string }>;
  loading: boolean;
  emptyHint?: React.ReactNode;
  /** 会话内待裁决的批准请求（S10；空时无卡片）。 */
  approvals?: AgentApprovalDto[];
  /** 用户裁决回调（批准/拒绝按钮）。 */
  onApprovalDecision?: (id: string, decision: 'approve' | 'reject') => void;
  /** 正在提交裁决的批准 id（按钮防双击）。 */
  approvalBusyId?: string | null;
  /** 任务态变化提示行（S7；由 task_update SSE 推导，居中弱化呈现）。 */
  taskNotices?: AgentTaskNotice[];
}

export function MessageStream({ workMode = false, sessionId, messages, draft, streamErrors, loading, emptyHint, approvals, onApprovalDecision, approvalBusyId, taskNotices }: MessageStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [historyWindow, setHistoryWindow] = useState({ sessionId, count: HISTORY_PAGE });
  const visibleCount = historyWindow.sessionId === sessionId ? historyWindow.count : HISTORY_PAGE;
  const visibleMessages = messages.slice(-visibleCount);
  const previousHeight = useRef<number | null>(null);
  const previousSession = useRef(sessionId);
  const toolDisplay = useMemo(() => {
    const latest = new Map<string, { messageId: string; index: number; args: string }>();
    const hidden = new Map<string, Set<number>>(); const args = new Map<string, string>();
    const hide = (owner: { messageId: string; index: number }) => {
      const indices = hidden.get(owner.messageId) ?? new Set<number>(); indices.add(owner.index); hidden.set(owner.messageId, indices);
    };
    for (const message of messages) {
      message.toolCalls?.forEach((tool, index) => latest.set(tool.id, { messageId: message.id, index, args: tool.argsSummary }));
      if (message.tool) {
        const owner = latest.get(message.tool.callId);
        if (owner) { hide(owner); args.set(message.id, owner.args); }
      }
    }
    for (const tool of draft?.tools ?? []) { const owner = latest.get(tool.callId); if (owner) hide(owner); }
    return { hidden, args };
  }, [messages, draft?.tools]);

  useEffect(() => {
    if (previousSession.current !== sessionId) {
      stickToBottom.current = true; previousHeight.current = null; previousSession.current = sessionId;
    }
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [sessionId]);

  const contentKey = `${messages.length}|${draft?.text.length ?? 0}|${draft?.thinking?.length ?? 0}|${draft?.tools.length ?? 0}|${streamErrors.length}|${approvals?.length ?? 0}|${taskNotices?.length ?? 0}`;
  useEffect(() => {
    if (previousHeight.current !== null && scrollRef.current) {
      scrollRef.current.scrollTop += scrollRef.current.scrollHeight - previousHeight.current;
      previousHeight.current = null;
      return;
    }
    if (stickToBottom.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [contentKey, visibleCount, sessionId]);

  const hasContent = messages.length > 0 || draft !== null || streamErrors.length > 0 || (approvals?.length ?? 0) > 0 || (taskNotices?.length ?? 0) > 0;

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 min-w-0 overflow-auto scrollbar-thin" data-testid="agent-message-stream">
      <div className="agent-message-column w-full min-w-0 max-w-[1360px] mx-auto px-3 py-4 space-y-3 sm:px-6 lg:px-8">
        {loading && messages.length === 0 && !draft ? (
          <div className="space-y-3 py-4" aria-busy="true">
            <div className="h-10 w-3/5 rounded-md bg-paper-2 animate-pulse" />
            <div className="h-16 w-4/5 rounded-md bg-paper-2 animate-pulse" />
          </div>
        ) : !hasContent ? (
          <div className="py-12 text-center">{emptyHint}</div>
        ) : (
          <>
            {messages.length > visibleCount ? <button className="block mx-auto text-xs text-ink-faint hover:text-seal py-2" onClick={() => {
              previousHeight.current = scrollRef.current?.scrollHeight ?? null;
              setHistoryWindow({ sessionId, count: visibleCount + HISTORY_PAGE });
            }}>加载更早的消息（{messages.length - visibleCount}）</button> : null}
            {visibleMessages.map((m) => {
              const toolVisibility = m.toolCalls?.map((_tool, index) => toolDisplay.hidden.get(m.id)?.has(index) ? '0' : '1').join('') ?? '';
              // Merged tool invocations must not leave empty rows between the prose and result card.
              if (workMode && m.role === 'assistant' && !m.text && !m.thinking && !m.error && !m.model && !toolVisibility.includes('1')) return null;
              return <div className="agent-message-item" data-message-role={m.role} key={m.id} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 80px' }}><MessageRow workMode={workMode} message={m} sessionId={sessionId}
                toolArgs={toolDisplay.args.get(m.id)} toolVisibility={toolVisibility} /></div>;
            })}
          </>
        )}

        {/* 流式草稿：tool 行 + 正在生成的文本 */}
        {draft ? (
          <div className="space-y-2 animate-fade-in" data-testid="agent-live-draft">
            {workMode && draft.thinking ? <ThinkingRow content={draft.thinking} streaming={!draft.text} /> : null}
            {draft.tools.map((t) => (
              <ToolRow
                workMode={workMode}
                key={t.callId}
                name={t.name}
                summary={t.phase === 'end' ? t.resultSummary ?? '' : t.argsSummary}
                args={t.argsSummary}
                running={t.phase === 'start'}
                isError={t.isError === true}
              />
            ))}
            {draft.text ? (
              <div className="agent-reply agent-markdown agent-markdown-streaming px-4 py-3 rounded-md border border-jade/25 bg-card-bg" aria-busy="true">
                <ChatMarkdown content={draft.text} />
              </div>
            ) : draft.tools.length === 0 && !draft.thinking ? (
              <div className="px-4 py-3 rounded-md border border-line bg-paper/60 text-xs text-ink-faint inline-flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-seal animate-pulse-seal" />
                Agent 正在思考…
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 任务态变化提示行（S7）：task_update 推导的居中弱化行 */}
        {taskNotices && taskNotices.length > 0 ? (
          <div className="space-y-1.5" data-testid="task-notice-list">
            {taskNotices.map((n) => (
              <div key={n.id} className="text-center" data-role="task-notice">
                <span className="inline-block px-3 py-1 rounded-full text-[11px] text-ink-faint bg-paper-2 border border-line/60">
                  {n.text}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {/* 会话内批准卡片（S10）：app_command 挂起等待用户裁决 */}
        {approvals && approvals.length > 0 && onApprovalDecision ? (
          <div className="space-y-2" data-testid="approval-list">
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onDecide={onApprovalDecision}
                busy={approvalBusyId === approval.id}
              />
            ))}
          </div>
        ) : null}

        {/* 运行级错误行（非助手回复） */}
        {streamErrors.map((e) => (
          <div
            key={e.id}
            className="flex items-start gap-2 px-4 py-2.5 rounded-md border border-seal-2/30 bg-[rgba(192,57,43,0.05)]"
            role="alert"
          >
            {e.code === 'aborted' ? (
              <Ban className="w-4 h-4 mt-0.5 shrink-0 text-ink-faint" />
            ) : (
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-seal-2" />
            )}
            <div className="min-w-0">
              <p className="text-xs text-seal-2 font-medium">{e.code}</p>
              <p className="text-xs text-ink-soft leading-relaxed break-words">{e.message}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const ThinkingRow = memo(function ThinkingRow({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return <details className="agent-work-thinking" data-streaming={streaming}>
    <summary><span className="agent-work-thinking-label">◇ {streaming ? '思考中' : '思考'}</span><span className="agent-work-thinking-excerpt">{content}</span><ChevronDown className="h-3 w-3 shrink-0" /></summary>
    <div className="agent-work-thinking-body">{content}</div>
  </details>;
});

const MessageRow = memo(function MessageRow({ workMode, message, sessionId, toolVisibility, toolArgs }: { workMode: boolean; message: AgentMessageDto; sessionId?: string; toolVisibility: string; toolArgs?: string }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end" data-role="user">
        <div className="agent-user-message max-w-[85%] px-4 py-2.5 rounded-md rounded-tr-sm bg-paper-2 border border-line">
          {sessionId && message.attachments?.length ? <ChatAttachmentCards sessionId={sessionId} attachments={message.attachments} /> : null}
          {message.text ? <p className="text-sm text-ink leading-relaxed whitespace-pre-wrap break-words">{message.text}</p> : null}
        </div>
      </div>
    );
  }
  if (message.role === 'assistant') {
    return (
      <div className="flex items-start gap-2.5" data-role="assistant">
        <div className="agent-avatar w-6 h-6 shrink-0 rounded-full bg-jade/15 border border-jade/30 flex items-center justify-center mt-0.5">
          <Wrench className="w-3 h-3 text-jade" />
        </div>
        <div className="min-w-0 flex-1">
          {workMode && message.thinking ? <ThinkingRow content={message.thinking} /> : null}
          {message.toolCalls && message.toolCalls.length > 0 ? (
            <div className="mb-1.5 space-y-1">
              {message.toolCalls.filter((_tc, index) => toolVisibility[index] !== '0').map((tc) => (
                <ToolRow workMode={workMode} key={tc.id} name={tc.name} summary={tc.argsSummary} args={tc.argsSummary} running={false} invocation />
              ))}
            </div>
          ) : null}
          {message.text ? (
            <div className="agent-reply agent-markdown px-4 py-3 rounded-md rounded-tl-sm border border-line bg-card-bg">
              <ChatMarkdown content={message.text} />
            </div>
          ) : null}
          {message.error ? (
            <div className="mt-1.5 px-4 py-2 rounded-md border border-seal-2/30 bg-[rgba(192,57,43,0.05)]" role="alert">
              <p className="text-xs text-seal-2 font-medium">{message.error.code}</p>
              <p className="text-xs text-ink-soft">{message.error.message}</p>
            </div>
          ) : null}
          {message.model ? (
            <p className="mt-1 text-[10px] text-ink-faint font-mono">{message.model}</p>
          ) : null}
        </div>
      </div>
    );
  }
  if (message.role === 'tool') {
    const t = message.tool;
    if (!t) return null;
    return (
      <div className="pl-9" data-role="tool">
        <ToolRow workMode={workMode} name={t.name} summary={t.resultSummary} args={toolArgs} running={false} isError={t.isError} />
      </div>
    );
  }
  // notice
  return (
    <div className="text-center" data-role="notice">
      <span className="inline-block px-3 py-1 rounded-full text-[11px] text-ink-faint bg-paper-2">
        {message.text}
      </span>
    </div>
  );
});

const ToolRow = memo(function ToolRow({
  workMode,
  name,
  summary,
  args,
  invocation,
  running,
  isError,
}: {
  workMode?: boolean;
  name: string;
  summary: string;
  args?: string;
  invocation?: boolean;
  running: boolean;
  isError?: boolean;
}) {
  // task_* 工具（S7 编排）用列表图标区分普通工具；行形态沿用 ToolRow。
  const TaskIcon = name.startsWith('task_') ? ListTodo : Wrench;
  const [resultOpen, setResultOpen] = useState(false);
  if (workMode) {
    const status = running ? '执行中' : isError ? '失败' : invocation ? '已调用' : '完成';
    const family = /^(read|search|find|grep|ls)/i.test(name) ? 'read' : /^(bash|exec|shell)/i.test(name) ? 'bash' : /^(edit|write|apply)/i.test(name) ? 'edit' : 'other';
    let target = args || name;
    let argsLine = args;
    try {
      const parsed = JSON.parse(args || '') as Record<string, unknown>;
      argsLine = Object.entries(parsed).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join('  ');
      const candidate = parsed.command ?? parsed.path ?? parsed.file_path ?? parsed.filePath ?? parsed.pattern ?? parsed.query;
      if (typeof candidate === 'string') target = candidate;
    } catch { /* Summaries may already be plain text or truncated JSON. */ }
    const hasResult = !running && !invocation;
    return <article className="agent-work-tool" data-tool={name} data-tool-family={family}
      data-tool-phase={running ? 'start' : isError ? 'error' : invocation ? 'called' : 'end'} data-result-open={resultOpen}>
      <button type="button" className="agent-work-tool-head" aria-label={`${name}：${status}，${resultOpen ? '收起' : '展开'}结果`}
        aria-expanded={resultOpen} disabled={!hasResult} onClick={() => setResultOpen((open) => !open)}>
        <span className="agent-work-tool-name">{name}</span>
        <span className="agent-work-tool-target" title={target}>{target}</span>
        <span className="agent-work-tool-status">
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : isError ? <AlertCircle className="h-3 w-3" /> : invocation ? <Wrench className="h-3 w-3" /> : <Check className="h-3 w-3" />}
          {status}
        </span>
        <ChevronDown className="agent-work-tool-chevron h-3 w-3 shrink-0" />
      </button>
      {args ? <details className="agent-work-tool-args">
        <summary title={args}><span>{argsLine}</span></summary>
        <pre>{args}</pre>
      </details> : null}
      {hasResult ? <>
        <button type="button" className="agent-work-tool-result-toggle" aria-expanded={resultOpen} onClick={() => setResultOpen((open) => !open)}>
          <ChevronDown className="agent-work-tool-chevron h-3 w-3 shrink-0" />
          {resultOpen ? '收起结果' : '结果已折叠'}
        </button>
        {resultOpen ? <div className="agent-work-tool-result"><pre>{summary || '工具执行完成，无输出。'}</pre></div> : null}
      </> : <p className="agent-work-tool-wait" role="status">{running ? '正在执行，等待结果…' : '已调用，等待结果…'}</p>}
    </article>;
  }
  return (
    <details
      className={`max-w-full px-3 py-1.5 rounded-md border text-[11px] font-mono ${
        isError
          ? 'border-seal-2/30 bg-[rgba(192,57,43,0.05)] text-seal-2'
          : running
            ? 'border-jade/30 bg-jade/[0.06] text-ink-soft'
            : 'border-line/70 bg-paper/50 text-ink-faint'
      }`}
      data-tool={name}
      data-tool-phase={running ? 'start' : isError ? 'error' : 'end'}
    >
      <summary className="flex items-start gap-2 cursor-pointer list-none">
      {running ? (
        <Loader2 className="w-3 h-3 mt-0.5 shrink-0 animate-spin text-jade" />
      ) : isError ? (
        <AlertCircle className="w-3 h-3 mt-0.5 shrink-0 text-seal-2" />
      ) : (
        <Check className="w-3 h-3 mt-0.5 shrink-0 text-jade" />
      )}
      <TaskIcon className="w-3 h-3 mt-0.5 shrink-0 opacity-60" />
      <span className="font-medium">{name}</span>
      <span className="shrink-0">{running ? '执行中' : isError ? '失败' : invocation ? '已调用' : '完成'}</span>
      <span className="truncate" title={summary}>
        {summary}
      </span>
      </summary>
      <div className="mt-2 space-y-1 text-ink-soft whitespace-pre-wrap break-all">
        {args ? <p>参数：{args}</p> : null}
        {!running && summary && summary !== args ? <p>结果：{summary}</p> : null}
        {!args && summary ? <p>结果：{summary}</p> : null}
      </div>
    </details>
  );
});
