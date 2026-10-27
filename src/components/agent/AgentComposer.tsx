/**
 * AgentComposer —— 会话输入区（AgentView 底部，§11.3）
 *
 * 状态：
 *   - 未选择会话 / Agent 未就绪（服务不可达或就绪码非 ready）→ 禁用 +
 *     原因说明 + [重新检测] / [前往设置]；
 *   - 运行中（session.state streaming/starting 或 sending）→ 发送拆为
 *     「插话 steer（立即送达当前运行）」与「排队 followUp（运行结束后执行）」
 *     两个明确动作 + [停止]；
 *   - 空输入禁用发送。Enter 发送 / Shift+Enter 换行。
 * 不把任何失败伪装成成功：发送错误由消息流错误行 + toast 呈现。
 */

import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, ListPlus, Send, Settings2, Square } from 'lucide-react';
import { Button } from '../common/Button';
import type { AgentSessionDto, AgentStatusDto } from '../../types/agent';
import type { ReadinessCopy } from '../../utils/agentReadiness';

interface AgentComposerProps {
  session: AgentSessionDto | null;
  agentStatus: AgentStatusDto | null;
  agentUnreachable: boolean;
  readiness: ReadinessCopy | null;
  busy: boolean;
  sending: boolean;
  onSend: (text: string, delivery?: 'steer' | 'followUp') => Promise<boolean>;
  onStop: () => void;
  onRecheck: () => void;
  rechecking: boolean;
  onJumpSettings?: () => void;
}

const MAX_TEXT = 20000;

export function AgentComposer({
  session,
  agentStatus,
  agentUnreachable,
  readiness,
  busy,
  sending,
  onSend,
  onStop,
  onRecheck,
  rechecking,
  onJumpSettings,
}: AgentComposerProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const notReady = agentUnreachable || (agentStatus !== null && agentStatus.code !== 'ready');
  const disabled = !session || notReady;
  const running = busy || session?.state === 'streaming' || session?.state === 'starting';
  const canSend = text.trim().length > 0 && text.length <= MAX_TEXT && !disabled && !sending;

  // 自适应高度（2–8 行）。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 56), 220)}px`;
  }, [text]);

  const doSend = async (delivery?: 'steer' | 'followUp') => {
    if (!canSend && !running) return;
    const payload = text.trim();
    if (!payload) return;
    const ok = await onSend(payload, running ? delivery : undefined);
    if (ok) setText('');
  };

  return (
    <div className="shrink-0 border-t border-line bg-card-bg/70 px-4 py-3" data-testid="agent-composer">
      <div className="max-w-3xl mx-auto">
        {disabled ? (
          <div
            className="mb-2 flex items-start gap-2 px-3 py-2 rounded-md border border-[rgba(180,83,9,0.3)] bg-[rgba(180,83,9,0.05)]"
            data-testid="agent-notready"
            role="note"
          >
            <Settings2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#92580c]" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-[#92580c]">
                {!session ? '尚未选择会话' : agentUnreachable ? 'Agent 服务不可用' : readiness?.reason ?? 'Agent 未就绪'}
              </p>
              {readiness?.action ? <p className="text-[11px] text-ink-soft mt-0.5 leading-snug">{readiness.action}</p> : null}
            </div>
            {readiness?.recheck || agentUnreachable ? (
              <Button size="sm" variant="secondary" onClick={onRecheck} loading={rechecking}>
                重新检测
              </Button>
            ) : null}
            {readiness?.jumpSettings && onJumpSettings ? (
              <Button size="sm" variant="secondary" onClick={onJumpSettings}>
                前往设置
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!running) void doSend();
              }
            }}
            disabled={disabled}
            maxLength={MAX_TEXT}
            rows={2}
            placeholder={
              disabled
                ? '输入不可用'
                : running
                  ? 'Agent 正在生成——可插话或排队下一条…'
                  : '描述你的设计问题，Enter 发送，Shift+Enter 换行'
            }
            className="flex-1 resize-none rounded-md border border-line bg-card-bg px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-seal/50 disabled:bg-paper-2 disabled:text-ink-faint scrollbar-thin"
            aria-label="消息输入"
            data-testid="agent-composer-input"
          />
          <div className="flex flex-col gap-1.5 shrink-0">
            {running ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void doSend('steer')}
                  disabled={!canSend}
                  title="作为插话注入当前正在进行的运行"
                >
                  <CornerDownLeft className="w-3.5 h-3.5" />
                  插话
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void doSend('followUp')}
                  disabled={!canSend}
                  title="排队到当前运行结束后执行"
                >
                  <ListPlus className="w-3.5 h-3.5" />
                  排队
                </Button>
                <Button size="sm" variant="ghost" onClick={onStop} className="text-seal-2 hover:bg-[rgba(192,57,43,0.06)]">
                  <Square className="w-3.5 h-3.5" />
                  停止
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="primary"
                onClick={() => void doSend()}
                disabled={!canSend}
                loading={sending}
                aria-label="发送"
              >
                <Send className="w-3.5 h-3.5" />
                发送
              </Button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-[10px] text-ink-faint">
          {text.length > MAX_TEXT * 0.8 ? `${text.length}/${MAX_TEXT} 字符 · ` : ''}
          应用自带工具：Discuss 只读；Work 仅可写绑定 Workspace，无 shell。第三方 Pi 插件按其自身能力运行。
        </p>
      </div>
    </div>
  );
}
