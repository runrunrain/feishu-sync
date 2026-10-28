/**
 * AgentView —— Agent 对话主区（F2，设计 §11.3）
 *
 * 三栏：会话列表 │ 消息流 + 输入 │ 模式与权限（可折叠）。
 * - Work 会话：顶部常驻风险条（amber）：可在 Workspace 内写文件、无命令
 *   执行、原始库/标准库只读；不把 Workspace 称为沙箱（§7.5）。
 * - SSE 连接状态指示：已连接 / 连接中断，正在重连（自动重试 + resync）。
 * - 未就绪：输入禁用 + 原因 + [重新检测]/[前往设置]（composer 内）。
 * 隐藏页面安全：本视图不注册任何 window 级键盘监听；active=false 时
 * hook 内部暂停轮询与订阅。
 */

import { useEffect, useState } from 'react';
import {
  Hammer,
  PanelRightClose,
  PanelRightOpen,
  PlugZap,
  RefreshCw,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { SessionListPanel } from '../components/agent/SessionListPanel';
import { MessageStream } from '../components/agent/MessageStream';
import { AgentComposer } from '../components/agent/AgentComposer';
import { AgentModePanel } from '../components/agent/AgentModePanel';
import { TaskPanel } from '../components/agent/TaskPanel';
import { useToast } from '../components/common/Toast';
import { useSessionAgentStatus } from '../hooks/useSessionAgentStatus';
import { useAgentSessions } from '../hooks/useAgentSessions';
import { useAgentOrchestration } from '../hooks/useAgentOrchestration';
import { describeReadinessCode as describeReadiness } from '../utils/agentReadiness';

interface AgentViewProps {
  active?: boolean;
  onJumpToSettings?: () => void;
}

export function AgentView({ active = true, onJumpToSettings }: AgentViewProps) {
  const toast = useToast();
  const sessions = useAgentSessions(active);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 1280);
  useEffect(() => { const resize = () => { if (window.innerWidth < 1280) setPanelOpen(false); }; resize(); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);

  const session = sessions.activeSession;
  const agent = useSessionAgentStatus(session, active);
  const orchestration = useAgentOrchestration(active);
  const readiness = agent.status ? describeReadiness(agent.status.code, agent.status) : null;
  const isWork = session?.mode === 'work';
  const running = session?.state === 'streaming' || session?.state === 'starting';

  const handleSend = async (text: string, delivery?: 'steer' | 'followUp') => {
    const ok = await sessions.send(text, delivery);
    if (!ok) {
      // 具体错误已写入 streamErrors；此处轻提示。
      toast.push({ type: 'warning', message: '发送失败，详见消息流中的错误行' });
    }
    return ok;
  };

  return (
    <div
      className={`relative h-full min-h-0 min-w-0 grid grid-cols-1 gap-3 lg:grid-cols-[200px_minmax(0,1fr)] ${panelOpen ? 'xl:grid-cols-[200px_minmax(0,1fr)_280px]' : ''}`}
      data-view="agent"
    >
      {/* 左：会话列表 */}
      <div className="hidden lg:block min-h-0 rounded-md border border-line bg-card-bg shadow-sm overflow-hidden">
        <SessionListPanel
          sessions={sessions.sessions}
          loading={sessions.sessionsLoading}
          activeId={sessions.activeId}
          onSelect={sessions.selecting}
          onCreate={sessions.createSession}
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

          {isWork ? (
            <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-[rgba(180,83,9,0.35)] text-[#92580c] bg-[rgba(180,83,9,0.06)]">
              <Hammer className="w-3 h-3" /> Work
            </span>
          ) : null}

          <div className="flex items-center gap-1 lg:hidden">
            <select aria-label="选择会话" className="max-w-[90px] rounded border border-line bg-card-bg px-1 py-1 text-[11px] text-ink-soft" value={sessions.activeId ?? ''} onChange={(e) => sessions.selecting(e.target.value)}>
              <option value="" disabled>选择会话</option>{sessions.sessions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select><button className="px-1 text-xs text-seal" onClick={() => void sessions.createSession()} aria-label="新建会话">新建</button>
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

          <button
            type="button"
            onClick={() => setPanelOpen((v) => !v)}
            className="shrink-0 p-1 rounded text-ink-faint hover:text-ink hover:bg-paper transition-colors"
            aria-label={panelOpen ? '收起模式面板' : '展开模式面板'}
            title={panelOpen ? '收起模式与权限面板' : '展开模式与权限面板'}
          >
            {panelOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
          </button>
        </header>

        {/* Work 常驻风险条 */}
        {isWork ? (
          <div
            className="shrink-0 flex items-start gap-2 px-4 py-2 border-b border-[rgba(180,83,9,0.3)] bg-[rgba(180,83,9,0.06)]"
            data-testid="work-risk-banner"
            role="note"
          >
            <PlugZap className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#92580c]" />
            <p className="text-[11px] leading-snug text-[#92580c]">
              Work 模式：应用自带工具可在
              <span className="font-mono mx-1">{session?.workspace?.path ?? '已授权目录'}</span>
              内创建、修改文件；不能执行命令；原始库与标准库不可写。目录授权即接受此范围的操作。
            </p>
          </div>
        ) : null}

        {(agent.status?.externalPlugins ?? 0) > 0 ? <p role="note" className="px-4 py-2 text-xs text-seal border-b border-line">已启用第三方Pi插件；其代码以当前用户权限运行，可访问文件与网络，能力范围由插件本身决定。</p> : null}

        <MessageStream
          messages={sessions.messages}
          draft={sessions.draft}
          streamErrors={sessions.streamErrors}
          loading={sessions.messagesLoading}
          approvals={sessions.approvals}
          onApprovalDecision={(id, decision) => { void sessions.decideApproval(id, decision); }}
          approvalBusyId={sessions.approvalBusyId}
          taskNotices={sessions.taskNotices}
          emptyHint={
            <div className="py-8">
              <p className="text-sm text-ink-soft">开始一段新的讨论</p>
              <p className="mt-1.5 text-xs text-ink-faint leading-relaxed max-w-sm mx-auto">
                应用自带工具可检索并阅读标准库与原始库。 Discuss 模式只读；需要让它写文件时，
                通过右侧面板显式切换到 Work 模式并授权目录。
              </p>
            </div>
          }
        />

        <AgentComposer
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

      {/* 右：任务区（S7）+ 模式与权限（可折叠） */}
      {panelOpen ? (
        <div className="absolute z-40 top-0 bottom-0 right-0 w-[min(280px,90%)] xl:static xl:w-auto min-h-0 flex flex-col gap-3">
          <button className="absolute top-2 right-2 z-10 text-xs text-seal xl:hidden" aria-label="关闭模式面板" onClick={() => setPanelOpen(false)}>关闭</button>
          <TaskPanel
            session={session}
            tasks={sessions.tasks}
            taskBusyId={sessions.taskBusyId}
            onCancelTask={(id) => { void sessions.cancelTask(id); }}
            onResumeTask={(id, message) => { void sessions.resumeTask(id, message); }}
            orchestrationEnabled={orchestration.enabled}
            orchestrationBusy={orchestration.busy}
            orchestrationError={orchestration.error}
            onToggleOrchestration={(enabled) => { void orchestration.toggle(enabled); }}
          />
          <div className="flex-1 min-h-0 rounded-md border border-line bg-card-bg shadow-sm overflow-hidden">
            <AgentModePanel
              session={session}
              busy={running}
              onSwitchMode={sessions.switchMode}
              writeRecords={sessions.writeRecords}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
