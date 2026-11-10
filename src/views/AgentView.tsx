/**
 * AgentView —— Agent 对话主区（F2，设计 §11.3）
 *
 * 三栏：会话列表 │ 消息流 + 输入 │ 模式与权限（可折叠）。
 * - Pi Work uses native tools and an optional starting directory.
 * - SSE 连接状态指示：已连接 / 连接中断，正在重连（自动重试 + resync）。
 * - 未就绪：输入禁用 + 原因 + [重新检测]/[前往设置]（composer 内）。
 * 隐藏页面安全：本视图不注册任何 window 级键盘监听；active=false 时
 * hook 内部暂停轮询与订阅。
 */

import { useEffect, useRef, useState } from 'react';
import {
  RefreshCw,
  Wifi,
  WifiOff,
  Upload,
} from 'lucide-react';
import { SessionListPanel } from '../components/agent/SessionListPanel';
import { MessageStream } from '../components/agent/MessageStream';
import { AgentComposer, type AgentComposerHandle } from '../components/agent/AgentComposer';
import { AgentModePanel } from '../components/agent/AgentModePanel';
import { useToast } from '../components/common/Toast';
import { Button } from '../components/common/Button';
import { Modal } from '../components/common/Modal';
import { useSessionAgentStatus } from '../hooks/useSessionAgentStatus';
import { useAgentSessions } from '../hooks/useAgentSessions';
import { describeReadinessCode as describeReadiness } from '../utils/agentReadiness';
import type { AgentAttachmentDto, AgentWorkspaceConfig } from '../types/agent';
import { addAgentWorkspace, listAgentWorkspaces } from '../api/client';

interface AgentViewProps {
  active?: boolean;
  onJumpToSettings?: () => void;
}

export function AgentView({ active = true, onJumpToSettings }: AgentViewProps) {
  const toast = useToast();
  const sessions = useAgentSessions(active);
  const [creatingSession, setCreatingSession] = useState(false);
  const createLock = useRef(false);
  const [workspaces, setWorkspaces] = useState<AgentWorkspaceConfig[]>([]);
  const [createWorkspace, setCreateWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const composerRef = useRef<AgentComposerHandle>(null);
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  useEffect(() => { if (active) void listAgentWorkspaces().then(setWorkspaces).catch(() => {}); }, [active]);
  useEffect(() => { dragDepth.current = 0; setDraggingFiles(false); }, [active, sessions.activeId]);

  const session = sessions.activeSession;
  const agent = useSessionAgentStatus(session, active);
  const readiness = agent.status ? describeReadiness(agent.status.code, agent.status) : null;
  const isWork = session?.mode === 'work';
  const running = session?.state === 'streaming' || session?.state === 'starting';

  const createPiSession = async (workspaceId?: string) => {
    if (createLock.current) return;
    createLock.current = true; setCreatingSession(true);
    try {
      await sessions.createSession('pi', workspaceId);
    } finally { createLock.current = false; setCreatingSession(false); }
  };

  const handleSend = async (text: string, delivery?: 'steer' | 'followUp', attachments?: AgentAttachmentDto[]) => {
    const ok = await sessions.send(text, delivery, attachments);
    if (!ok) {
      // 具体错误已写入 streamErrors；此处轻提示。
      toast.push({ type: 'warning', message: '发送失败，详见消息流中的错误行' });
    }
    return ok;
  };

  return (
    <div
      className="relative h-full min-h-0 min-w-0 grid grid-cols-1 gap-3 lg:grid-cols-[200px_minmax(0,1fr)]"
      data-view="agent"
      data-session-mode={isWork ? 'work' : 'discuss'}
      onDragEnter={(event) => {
        if (!active || !Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault(); dragDepth.current++; setDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (!active || !Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!draggingFiles) return;
        event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDraggingFiles(false);
      }}
      onDrop={(event) => {
        if (!active || !Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDraggingFiles(false);
        composerRef.current?.addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {/* 左：会话列表 */}
      <div className="hidden lg:block min-h-0 rounded-md border border-line bg-card-bg shadow-sm overflow-hidden">
        <SessionListPanel
          sessions={sessions.sessions}
          loading={sessions.sessionsLoading}
          activeId={sessions.activeId}
          onSelect={sessions.selecting}
          onCreate={createPiSession}
          creating={creatingSession}
          workspaces={workspaces}
          workspaceMode={isWork}
          onAddWorkspace={() => { setWorkspaceError(''); setCreateWorkspace(true); }}
          onRename={sessions.renameSession}
          onDelete={sessions.removeSession}
        />
      </div>

      {/* 中：消息流 + 输入 */}
      <div className="min-h-0 rounded-md border border-line bg-card-bg shadow-sm flex flex-col overflow-hidden">
        {/* 会话头：标题 + 模式 + 连接状态 */}
        <header className="shrink-0 px-4 py-2.5 border-b border-line/60 flex items-center gap-1.5 sm:gap-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-kai font-medium text-ink truncate">
              {session?.title ?? '未选择会话'}
            </h2>
            {sessions.sessionsError ? (
              <p className="text-[11px] text-seal-2 truncate" role="alert">
                {sessions.sessionsError}
                <button type="button" className="ml-2 text-jade hover:text-seal underline" onClick={sessions.refreshSessions}>
                  重试
                </button>
              </p>
            ) : null}
          </div>

          <AgentModePanel session={session} busy={running} onSwitchMode={sessions.switchMode} writeRecords={sessions.writeRecords} onWorkspacesChanged={() => { void listAgentWorkspaces().then(setWorkspaces).catch(() => {}); sessions.refreshSessions(); }} />

          <div className="flex items-center gap-1 lg:hidden">
            <select aria-label="选择会话" className="max-w-[90px] rounded border border-line bg-card-bg px-1 py-1 text-[11px] text-ink-soft" value={sessions.activeId ?? ''} onChange={(e) => sessions.selecting(e.target.value)}>
              <option value="" disabled>选择会话</option>{sessions.sessions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select><button type="button" className="px-1 text-xs text-seal disabled:opacity-50" disabled={creatingSession} onClick={() => void createPiSession()} aria-label="新建会话">新建</button>
          </div>
          {/* SSE 连接指示 */}
          {session ? (
            sessions.sseStatus === 'open' ? (
              <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-jade" title="事件流已连接">
                <Wifi className="w-3.5 h-3.5" /> 已连接
              </span>
            ) : sessions.sseStatus === 'reconnecting' || sessions.sseStatus === 'connecting' ? (
              <span
                className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[11px] text-[#92580c] bg-[rgba(180,83,9,0.08)] border border-[rgba(180,83,9,0.3)]"
                title="连接中断，正在自动重连（保留已接收内容）"
                data-testid="sse-reconnecting"
              >
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /><span className="sm:hidden">重连中</span><span className="hidden sm:inline">连接中断，正在重连</span>
              </span>
            ) : sessions.sseStatus === 'closed' ? (
              <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-ink-faint" title="事件流未连接">
                <WifiOff className="w-3.5 h-3.5" /> 未连接
              </span>
            ) : null
          ) : null}

        </header>

        <MessageStream
          workMode={isWork}
          sessionId={session?.id}
          messages={sessions.messages}
          draft={sessions.draft}
          streamErrors={sessions.streamErrors}
          onDismissStreamError={sessions.dismissStreamError}
          loading={sessions.messagesLoading}
          approvals={sessions.approvals}
          onApprovalDecision={(id, decision) => { void sessions.decideApproval(id, decision); }}
          approvalBusyId={sessions.approvalBusyId}
          taskNotices={sessions.taskNotices}
          emptyHint={
            <div className="py-8">
              <p className="text-sm text-ink-soft">开始一段新的讨论</p>
              <p className="mt-1.5 text-xs text-ink-faint leading-relaxed max-w-sm mx-auto">
                Chat 支持知识讨论。切换到 Work，可使用 Pi 完成文件处理、命令执行等工作。
              </p>
            </div>
          }
        />

        <AgentComposer
          ref={composerRef}
          session={session}
          agentStatus={agent.status}
          agentUnreachable={agent.unreachable}
          readiness={readiness}
          busy={running}
          sending={sessions.sending}
          onSend={handleSend}
          onStop={() => void sessions.stop()}
          onRecheck={() => void agent.recheck()}
          rechecking={agent.rechecking}
          onJumpSettings={onJumpToSettings}
          onModelChanged={sessions.refreshSessions}
        />
      </div>

      {draggingFiles ? <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-seal bg-card-bg/95" data-testid="agent-file-drop-overlay">
        <div className="text-center space-y-2"><Upload className="h-9 w-9 text-seal mx-auto" /><p className="text-ink font-medium">松开以添加图片或文件</p><p className="text-xs text-ink-faint">文件会添加到当前会话的输入框</p></div>
      </div> : null}

      <Modal open={createWorkspace} title="新建工作区" onClose={workspaceBusy ? undefined : () => setCreateWorkspace(false)}>
        <div className="space-y-3">
          <input aria-label="工作区名称" placeholder="工作区名称" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} className="w-full rounded border border-line bg-card-bg px-3 py-2 text-sm" />
          <div className="flex gap-2"><input aria-label="工作区目录" placeholder="目录绝对路径" value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)} className="min-w-0 flex-1 rounded border border-line bg-card-bg px-3 py-2 text-sm" /><Button size="sm" variant="secondary" onClick={() => { void window.desktop?.selectDirectory?.().then((path) => { if (path) setWorkspacePath(path); }); }}>选择目录</Button></div>
          {workspaceError && <p role="alert" className="text-xs text-seal-2">{workspaceError}</p>}
          <div className="flex justify-end"><Button size="sm" loading={workspaceBusy} disabled={!workspaceName.trim() || !workspacePath.trim()} onClick={() => { setWorkspaceBusy(true); setWorkspaceError(''); void addAgentWorkspace({ name: workspaceName.trim(), path: workspacePath.trim() }).then((workspace) => { setWorkspaces((items) => [...items, workspace]); setWorkspaceName(''); setWorkspacePath(''); setCreateWorkspace(false); }).catch((error) => setWorkspaceError(error instanceof Error ? error.message : '创建失败')).finally(() => setWorkspaceBusy(false)); }}>创建</Button></div>
        </div>
      </Modal>
    </div>
  );
}
