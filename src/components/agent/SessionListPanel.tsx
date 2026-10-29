/**
 * SessionListPanel —— 会话列表（AgentView 左栏，§11.3）
 *
 * 新建（仅 discuss；Work 经模式切换进入）、重命名（行内铅笔 → Modal 输入）、
 * 删除（Modal 确认）。状态点：idle/starting/streaming/error；Work 会话带
 * 锤子徽标。当前会话高亮（seal 侧条）。
 */

import { useEffect, useRef, useState } from 'react';
import {
  Hammer,
  MessageCircle,
  Pencil,
  Plus,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { formatRelativeTime } from '../../utils/agentReadiness';
import type { AgentSessionDto } from '../../types/agent';

interface SessionListPanelProps {
  sessions: AgentSessionDto[];
  loading: boolean;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => Promise<AgentSessionDto | null>;
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}

const STATE_DOT: Record<string, string> = {
  idle: 'bg-ink-faint/50',
  starting: 'bg-jade animate-pulse',
  streaming: 'bg-seal animate-pulse-seal',
  error: 'bg-seal-2',
};

export function SessionListPanel({
  sessions,
  loading,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: SessionListPanelProps) {
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<AgentSessionDto | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleting, setDeleting] = useState<AgentSessionDto | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      setRenameValue(renaming.title);
      // Modal 打开后聚焦并全选。
      window.setTimeout(() => renameInputRef.current?.select(), 30);
    }
  }, [renaming]);

  const submitRename = async () => {
    if (!renaming) return;
    const title = renameValue.trim();
    if (!title || title.length > 80) return;
    setRenameBusy(true);
    const ok = await onRename(renaming.id, title);
    setRenameBusy(false);
    if (ok) setRenaming(null);
  };

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    await onCreate();
    setCreating(false);
  };

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="agent-session-list">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-line/60 shrink-0">
        <span className="text-sm font-kai font-medium text-ink">会话</span>
        <Button size="sm" variant="ghost" onClick={() => void handleCreate()} loading={creating} aria-label="新建会话">
          <Plus className="w-4 h-4" />
          新建
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto scrollbar-thin py-1.5">
        {loading && sessions.length === 0 ? (
          <div className="px-3 space-y-2 py-2" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 rounded-md bg-paper-2 animate-pulse" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <SquarePen className="w-6 h-6 mx-auto text-ink-faint mb-2" />
            <p className="text-xs text-ink-faint leading-relaxed">
              还没有会话。
              <br />
              新建一个，开始与 Agent 讨论设计。
            </p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => void handleCreate()} loading={creating}>
              新建会话
            </Button>
          </div>
        ) : (
          sessions.map((s) => {
            const active = s.id === activeId;
            return (
              <div
                key={s.id}
                className={`group relative mx-1.5 my-0.5 rounded-md transition-colors ${
                  active ? 'bg-[rgba(158,43,37,0.07)]' : 'hover:bg-paper'
                }`}
              >
                {active ? <span className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full bg-seal" /> : null}
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  className="w-full text-left px-2.5 py-2 pl-3.5"
                  aria-current={active ? 'true' : undefined}
                >
                  <div className="flex items-center gap-1.5">
                    {s.mode === 'work' ? (
                      <Hammer className="w-3.5 h-3.5 shrink-0 text-[#92580c]" />
                    ) : (
                      <MessageCircle className="w-3.5 h-3.5 shrink-0 text-jade" />
                    )}
                    <span className={`truncate text-xs ${active ? 'text-ink font-medium' : 'text-ink-soft'}`}>
                      {s.title}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 pl-5">
                    <span className="text-[10px] text-ink-faint">{s.backend === 'claude-code' ? 'Claude Code' : 'Pi'}</span>
                    <span className={`w-1.5 h-1.5 rounded-full ${STATE_DOT[s.state] ?? STATE_DOT.idle}`} />
                    <span className="text-[10px] text-ink-faint">
                      {s.state === 'streaming'
                        ? '生成中'
                        : s.state === 'starting'
                          ? '启动中'
                          : s.state === 'error'
                            ? '出错'
                            : formatRelativeTime(s.updatedAt)}
                    </span>
                    {s.mode === 'work' ? (
                      <span className="text-[10px] text-[#92580c] border border-[rgba(180,83,9,0.3)] rounded-sm px-1">
                        Work
                      </span>
                    ) : null}
                  </div>
                </button>
                <div className="absolute right-1.5 top-1.5 hidden group-hover:flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => setRenaming(s)}
                    className="p-1 rounded text-ink-faint hover:text-ink hover:bg-card-bg"
                    aria-label={`重命名 ${s.title}`}
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleting(s)}
                    className="p-1 rounded text-ink-faint hover:text-seal-2 hover:bg-card-bg"
                    aria-label={`删除 ${s.title}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 重命名弹窗 */}
      <Modal open={renaming !== null} title="重命名会话" onClose={() => setRenaming(null)}>
        <div className="space-y-3">
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitRename();
            }}
            maxLength={80}
            className="w-full h-9 px-3 rounded-md border border-line bg-card-bg text-sm text-ink focus:outline-none focus:border-seal/50"
            placeholder="会话标题（1..80 字符）"
            aria-label="会话标题"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setRenaming(null)} disabled={renameBusy}>
              取消
            </Button>
            <Button size="sm" variant="primary" onClick={submitRename} loading={renameBusy} disabled={!renameValue.trim()}>
              保存
            </Button>
          </div>
        </div>
      </Modal>

      {/* 删除确认 */}
      <Modal open={deleting !== null} title="删除会话" onClose={() => setDeleting(null)}>
        <p className="text-sm text-ink-soft leading-relaxed">
          确认删除会话「{deleting?.title}」？其消息历史将被归档，不可在界面中恢复。
          {deleting?.mode === 'work' ? '绑定的 Workspace 不受影响。' : ''}
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <Button size="sm" variant="secondary" onClick={() => setDeleting(null)} disabled={deleteBusy}>
            取消
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={deleteBusy}
            onClick={async () => {
              if (!deleting) return;
              setDeleteBusy(true);
              const ok = await onDelete(deleting.id);
              setDeleteBusy(false);
              if (ok) setDeleting(null);
            }}
          >
            删除
          </Button>
        </div>
      </Modal>
    </div>
  );
}
