import { ConversationModelPicker } from './ConversationModelPicker';
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

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { CornerDownLeft, FileText, ListPlus, Loader2, Plus, RefreshCw, Send, Settings2, Square, X } from 'lucide-react';
import { Button } from '../common/Button';
import type { AgentAttachmentDto, AgentSessionDto, AgentStatusDto } from '../../types/agent';
import type { ReadinessCopy } from '../../utils/agentReadiness';
import { removeAgentAttachment, setSessionApprovalMode, uploadAgentAttachment } from '../../api/client';

export interface AgentComposerHandle { addFiles: (files: File[]) => void }
interface DraftAttachment {
  clientId: string;
  file: File;
  previewUrl?: string;
  status: 'uploading' | 'ready' | 'error';
  attachment?: AgentAttachmentDto;
  error?: string;
}
interface ComposerDraft { text: string; files: DraftAttachment[] }

interface AgentComposerProps {
  session: AgentSessionDto | null;
  agentStatus: AgentStatusDto | null;
  agentUnreachable: boolean;
  readiness: ReadinessCopy | null;
  busy: boolean;
  sending: boolean;
  onSend: (text: string, delivery?: 'steer' | 'followUp', attachments?: AgentAttachmentDto[]) => Promise<boolean>;
  onStop: () => void;
  onRecheck: () => void;
  rechecking: boolean;
  onJumpSettings?: () => void;
  onModelChanged: () => void;
}

const MAX_TEXT = 20000;

export const AgentComposer = forwardRef<AgentComposerHandle, AgentComposerProps>(function AgentComposer({
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
  onModelChanged,
}: AgentComposerProps, ref) {
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const draftsRef = useRef(drafts);
  const uploadsRef = useRef(new Map<string, AbortController>());
  const previewUrls = useRef(new Set<string>());
  const [attachmentError, setAttachmentError] = useState('');
  const sessionId = session?.id ?? '';
  const draft = drafts[sessionId] ?? { text: '', files: [] };
  const text = draft.text;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [approvalSaving, setApprovalSaving] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const notReady = agentUnreachable || !agentStatus || agentStatus.code !== 'ready';
  const disabled = !session || notReady;
  const running = busy || session?.state === 'streaming' || session?.state === 'starting';
  const canSend = (text.trim().length > 0 || draft.files.length > 0) && draft.files.every((file) => file.status === 'ready')
    && text.length <= MAX_TEXT && !disabled && !sending;
  const updateDraft = useCallback((id: string, update: (draft: ComposerDraft) => ComposerDraft) => {
    const next = { ...draftsRef.current, [id]: update(draftsRef.current[id] ?? { text: '', files: [] }) };
    draftsRef.current = next;
    setDrafts(next);
  }, []);
  const releasePreview = (item: DraftAttachment) => {
    if (item.previewUrl) { URL.revokeObjectURL(item.previewUrl); previewUrls.current.delete(item.previewUrl); }
  };
  useEffect(() => () => {
    for (const controller of uploadsRef.current.values()) controller.abort();
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
  }, []);
  useEffect(() => { setAttachmentError(''); }, [sessionId]);

  const upload = useCallback(async (id: string, item: DraftAttachment) => {
    const controller = new AbortController();
    uploadsRef.current.set(item.clientId, controller);
    try {
      const attachment = await uploadAgentAttachment(id, item.file, controller.signal);
      if (controller.signal.aborted || !draftsRef.current[id]?.files.some((file) => file.clientId === item.clientId)) {
        void removeAgentAttachment(id, attachment.id).catch(() => {});
        return;
      }
      updateDraft(id, (current) => ({ ...current, files: current.files.map((file) => file.clientId === item.clientId ? { ...file, status: 'ready', attachment, error: undefined } : file) }));
    } catch (error) {
      if (controller.signal.aborted) return;
      updateDraft(id, (current) => ({ ...current, files: current.files.map((file) => file.clientId === item.clientId
        ? { ...file, status: 'error', error: error instanceof Error ? error.message : '上传失败' } : file) }));
    } finally { uploadsRef.current.delete(item.clientId); }
  }, [updateDraft]);

  const addFiles = useCallback((files: File[]) => {
    if (!files.length) return;
    if (disabled || sending) { setAttachmentError(!sessionId ? '请先选择或新建会话' : '当前暂时无法添加附件'); return; }
    setAttachmentError('');
    const current = draftsRef.current[sessionId] ?? { text: '', files: [] };
    const accepted: DraftAttachment[] = [];
    let totalBytes = current.files.reduce((sum, item) => sum + item.file.size, 0);
    for (const file of files) {
      if (current.files.length + accepted.length >= 10) { setAttachmentError('每条消息最多添加 10 个附件'); break; }
      if (!file.size || file.size > 20 * 1024 * 1024 || (file.type.startsWith('image/') && file.size > 5 * 1024 * 1024)) {
        setAttachmentError(`${file.name}：文件不能为空；图片上限 5 MB，其他文件上限 20 MB`); continue;
      }
      if (totalBytes + file.size > 20 * 1024 * 1024) { setAttachmentError('每条消息的附件总大小不能超过 20 MB'); continue; }
      totalBytes += file.size;
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      if (previewUrl) previewUrls.current.add(previewUrl);
      accepted.push({ clientId: crypto.randomUUID(), file, previewUrl, status: 'uploading' });
    }
    updateDraft(sessionId, (current) => ({ ...current, files: [...current.files, ...accepted] }));
    for (const item of accepted) void upload(sessionId, item);
  }, [disabled, sending, sessionId, updateDraft, upload]);
  useImperativeHandle(ref, () => ({ addFiles }), [addFiles]);

  const removeFile = (item: DraftAttachment) => {
    uploadsRef.current.get(item.clientId)?.abort();
    releasePreview(item);
    updateDraft(sessionId, (current) => ({ ...current, files: current.files.filter((file) => file.clientId !== item.clientId) }));
    if (item.attachment) void removeAgentAttachment(sessionId, item.attachment.id).catch(() => {});
  };

  // 自适应高度（2–8 行）。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 56), 220)}px`;
  }, [text]);

  const doSend = async (delivery?: 'steer' | 'followUp') => {
    if (!canSend) return;
    const payload = text.trim();
    const sendingSessionId = sessionId;
    const sentFiles = draft.files;
    const ok = await onSend(payload, running ? delivery : undefined, sentFiles.map((file) => file.attachment!));
    if (ok) {
      for (const item of sentFiles) releasePreview(item);
      updateDraft(sendingSessionId, (current) => ({ text: current.text === text ? '' : current.text,
        files: current.files.filter((file) => !sentFiles.some((sent) => sent.clientId === file.clientId)) }));
    }
  };

  return (
    <div className="min-w-0 shrink-0 border-t border-line bg-card-bg/70 px-3 py-3 sm:px-6 lg:px-8" data-testid="agent-composer">
      <div className="w-full min-w-0 max-w-3xl mx-auto">
        {disabled ? (
          <div
            className="mb-2 flex flex-wrap items-start gap-2 px-3 py-2 rounded-md border border-[rgba(180,83,9,0.3)] bg-[rgba(180,83,9,0.05)]"
            data-testid="agent-notready"
            role="note"
          >
            <Settings2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#92580c]" />
            <div className="min-w-0 flex-1 basis-[220px]">
              <p className="text-xs font-medium text-[#92580c]">
                {!session ? '尚未选择会话' : agentUnreachable ? 'Agent 服务不可用' : !agentStatus ? '正在检查模型…' : readiness?.reason ?? 'Agent 未就绪'}
              </p>
              {readiness?.action ? <p className="text-[11px] text-ink-soft mt-0.5 leading-snug">{readiness.action}</p> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 pl-5 sm:pl-0">
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
          </div>
        ) : null}

        <div className="rounded-xl border border-line bg-card-bg p-2 focus-within:border-seal/50">
          <input ref={fileInputRef} type="file" multiple className="hidden" aria-label="选择图片或文件"
            onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
          {draft.files.length ? <div className="flex gap-2 overflow-x-auto scrollbar-thin px-1 pb-2" aria-label="待发送附件">
            {draft.files.map((item) => <div key={item.clientId} className={`relative w-44 shrink-0 rounded-lg border p-2 ${item.status === 'error' ? 'border-seal-2/40 bg-seal-2/5' : 'border-line bg-paper'}`} data-attachment-state={item.status}>
              <button type="button" disabled={sending} onClick={() => removeFile(item)} aria-label={`移除附件 ${item.file.name}`} className="absolute right-1 top-1 rounded p-1 bg-card-bg/90 text-ink-faint hover:text-seal-2"><X className="h-3.5 w-3.5" /></button>
              {item.previewUrl ? <img src={item.previewUrl} alt={item.file.name} className="h-20 w-full object-contain rounded mb-1" /> : <FileText className="h-7 w-7 text-seal mb-1" />}
              <p className="truncate pr-5 text-xs text-ink" title={item.file.name}>{item.file.name}</p>
              <p className="mt-0.5 text-[10px] text-ink-faint">{Math.max(1, Math.round(item.file.size / 1024))} KB · {item.status === 'uploading' ? '上传与解析中' : item.status === 'ready' ? '已就绪' : '上传失败'}</p>
              {item.status === 'uploading' ? <Loader2 className="mt-1 h-3.5 w-3.5 animate-spin text-seal" /> : null}
              {item.error ? <p className="mt-1 text-[10px] text-seal-2 break-words" role="alert">{item.error}</p> : null}
              {item.attachment?.note ? <p className="mt-1 text-[10px] text-ink-faint leading-snug">{item.attachment.note}</p> : null}
              {item.status === 'error' ? <button type="button" className="mt-1 text-xs text-seal flex items-center gap-1" onClick={() => {
                updateDraft(sessionId, (current) => ({ ...current, files: current.files.map((file) => file.clientId === item.clientId ? { ...file, status: 'uploading', error: undefined } : file) }));
                void upload(sessionId, item);
              }}><RefreshCw className="h-3 w-3" />重试</button> : null}
            </div>)}
          </div> : null}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => updateDraft(sessionId, (current) => ({ ...current, text: e.target.value }))}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) { event.preventDefault(); addFiles(files); }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!running) void doSend();
              }
            }}
            disabled={disabled || sending}
            maxLength={MAX_TEXT}
            rows={2}
            placeholder={
              disabled
                ? '输入不可用'
                : running
                  ? session?.backend === 'claude-code' ? 'Claude Code 正在生成，请等待本轮结束…' : 'Agent 正在生成——可插话或排队下一条…'
                  : '描述你的设计问题，Enter 发送，Shift+Enter 换行'
            }
            className="block w-full resize-none border-0 bg-transparent px-2 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-seal/50 disabled:bg-paper-2 disabled:text-ink-faint scrollbar-thin"
            aria-label="消息输入"
            data-testid="agent-composer-input"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" aria-label="添加图片或文件" title="添加图片或文件，也可以拖拽或粘贴图片" disabled={disabled || sending}
                className="rounded-full p-1.5 text-ink-soft hover:bg-paper disabled:opacity-40" onClick={() => fileInputRef.current?.click()}><Plus className="h-4 w-4" /></button>
              <ConversationModelPicker session={session} busy={running || sending} onChanged={onModelChanged} />
              {session?.mode === 'work' && <select aria-label="Work 审批方式" value={session.approvalMode ?? 'ask'} disabled={running || sending || approvalSaving}
                className="rounded border border-line bg-card-bg px-2 py-1 text-xs text-ink-soft"
                onChange={(event) => {
                  const mode = event.target.value as 'ask' | 'auto'; setApprovalError(''); setApprovalSaving(true);
                  void setSessionApprovalMode(session.id, mode).then(() => onModelChanged()).catch((error) => setApprovalError(error instanceof Error ? error.message : '审批方式切换失败')).finally(() => setApprovalSaving(false));
                }}>
                <option value="ask">逐次审批</option><option value="auto">免审批</option>
              </select>}
            </div>
          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            {running ? (
              <>
                {session?.backend !== 'claude-code' && <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void doSend('steer')}
                  disabled={!canSend}
                  title="作为插话注入当前正在进行的运行"
                >
                  <CornerDownLeft className="w-3.5 h-3.5" />
                  插话
                </Button>}
                {session?.backend !== 'claude-code' && <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void doSend('followUp')}
                  disabled={!canSend}
                  title="排队到当前运行结束后执行"
                >
                  <ListPlus className="w-3.5 h-3.5" />
                  排队
                </Button>}
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
        </div>
        {approvalError && <p role="alert" className="mt-1 text-xs text-seal-2">{approvalError}</p>}
        {attachmentError && <p role="alert" className="mt-1 text-xs text-seal-2">{attachmentError}</p>}
        {text.length > MAX_TEXT * 0.8 ? <p className="mt-1 text-[10px] text-ink-faint">{text.length}/{MAX_TEXT} 字符</p> : null}
      </div>
    </div>
  );
});
