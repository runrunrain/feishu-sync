/**
 * AgentModePanel —— 模式与权限面板（AgentView 右栏，§11.3）
 *
 * 当前模式徽标 + 能力说明；Work 会话展示 Workspace 信息与写入记录
 * （§7.4 已知剩余风险的可见性：用户对 Workspace 的授权即对风险的接受）。
 * 切换到 Work：Modal 选择有效 Workspace + 风险文案 + confirm:'WORK'。
 * 不把 cwd / workspace 称为「沙箱」；Work 无 shell 如实说明。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  FilePlus2,
  FolderPlus,
  Hammer,
  Loader2,
  MessageCircle,
  Pencil,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { StatusBadge } from '../common/StatusBadge';
import { useToast } from '../common/Toast';
import { addAgentWorkspace, APIError, deleteAgentWorkspace, listAgentWorkspaces } from '../../api/client';
import { formatRelativeTime } from '../../utils/agentReadiness';
import type { AgentSessionDto, AgentWorkspaceConfig } from '../../types/agent';
import type { WriteRecord } from '../../hooks/useAgentSessions';

interface AgentModePanelProps {
  session: AgentSessionDto | null;
  busy: boolean;
  onSwitchMode: (
    body: { mode: 'discuss' } | { mode: 'work'; workspaceId: string; confirm: 'WORK' },
  ) => Promise<boolean>;
  writeRecords: WriteRecord[];
}

export function AgentModePanel({ session, busy, onSwitchMode, writeRecords }: AgentModePanelProps) {
  const toast = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<AgentWorkspaceConfig[] | null>(null);
  const [wsLoading, setWsLoading] = useState(false);
  const [selectedWs, setSelectedWs] = useState<string>('');
  const [switching, setSwitching] = useState(false);
  // 新增 workspace 内联表单
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  const isWork = session?.mode === 'work';
  const running = busy || session?.state === 'streaming' || session?.state === 'starting';

  const loadWorkspaces = async () => {
    setWsLoading(true);
    try {
      const list = await listAgentWorkspaces();
      setWorkspaces(list);
      return list;
    } catch (err) {
      setWorkspaces([]);
      toast.push({
        type: 'warning',
        message: 'Workspace 列表加载失败',
        hint: err instanceof APIError ? err.message : String(err),
      });
      return [];
    } finally {
      setWsLoading(false);
    }
  };

  // 打开切换 Modal 时拉取 Workspace 列表。
  useEffect(() => {
    if (!modalOpen) return;
    void loadWorkspaces().then((list) => {
      if (list.length > 0 && !list.some((w) => w.id === selectedWs)) {
        setSelectedWs(list[0].id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen]);

  const validSelection = useMemo(
    () => workspaces?.some((w) => w.id === selectedWs) ?? false,
    [workspaces, selectedWs],
  );

  const confirmSwitchToWork = async () => {
    if (!validSelection) return;
    setSwitching(true);
    const ok = await onSwitchMode({ mode: 'work', workspaceId: selectedWs, confirm: 'WORK' });
    setSwitching(false);
    if (ok) {
      setModalOpen(false);
      toast.push({ type: 'success', message: '已切换到 Work 模式' });
    }
  };

  const switchBackToDiscuss = async () => {
    setSwitching(true);
    const ok = await onSwitchMode({ mode: 'discuss' });
    setSwitching(false);
    if (!ok) toast.push({ type: 'error', message: '切回 Discuss 失败，请重试' });
  };

  const pickDirectory = async () => {
    if (typeof window !== 'undefined' && window.desktop?.selectDirectory) {
      const dir = await window.desktop.selectDirectory();
      if (dir) setNewPath(dir);
      return;
    }
    toast.push({ type: 'info', message: '浏览器模式下请手动输入目录绝对路径' });
  };

  const submitAddWorkspace = async () => {
    const name = newName.trim();
    const dir = newPath.trim();
    if (!name || !dir) return;
    setAddBusy(true);
    try {
      const created = await addAgentWorkspace({ name, path: dir });
      setWorkspaces((prev) => [...(prev ?? []), created]);
      setSelectedWs(created.id);
      setNewName('');
      setNewPath('');
      setAdding(false);
      toast.push({ type: 'success', message: `Workspace「${created.name}」已添加` });
    } catch (err) {
      toast.push({
        type: 'error',
        message: err instanceof APIError ? err.message : '添加 Workspace 失败',
      });
    } finally {
      setAddBusy(false);
    }
  };

  const removeWorkspace = async (id: string, name: string) => {
    try {
      await deleteAgentWorkspace(id);
      setWorkspaces((prev) => (prev ?? []).filter((w) => w.id !== id));
      if (selectedWs === id) setSelectedWs('');
      toast.push({ type: 'info', message: `Workspace「${name}」已移除（绑定它的 Work 会话将切回 Discuss）` });
    } catch (err) {
      toast.push({
        type: 'error',
        message: err instanceof APIError ? err.message : '移除 Workspace 失败',
      });
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="agent-mode-panel">
      <div className="px-4 py-3 border-b border-line/60 shrink-0">
        <h3 className="text-sm font-kai font-medium text-ink flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-jade" />
          模式与权限
        </h3>
      </div>

      <div className="flex-1 min-h-0 overflow-auto scrollbar-thin p-4 space-y-4">
        {/* 当前模式 */}
        <section>
          <div className="flex items-center gap-2">
            {isWork ? (
              <StatusBadge status="warning">
                <Hammer className="w-3 h-3" /> Work 模式
              </StatusBadge>
            ) : (
              <StatusBadge status="success">
                <MessageCircle className="w-3 h-3" /> Discuss 模式
              </StatusBadge>
            )}
          </div>
          <p className="mt-2 text-[11px] text-ink-soft leading-relaxed">
            {isWork
              ? '可读标准库与原始库，并可在绑定的 Workspace 内创建、修改文件。不能执行任何命令（无 shell）。'
              : '只读：可检索和阅读标准库与原始库，不提供任何写入工具或命令执行。'}
          </p>
          {isWork && session?.workspace ? (
            <div className="mt-2.5 px-3 py-2.5 rounded-md border border-[rgba(180,83,9,0.3)] bg-[rgba(180,83,9,0.04)]">
              <p className="text-xs font-medium text-ink">{session.workspace.name}</p>
              <p className="mt-0.5 text-[11px] text-ink-faint font-mono break-all">{session.workspace.path}</p>
            </div>
          ) : null}
        </section>

        {/* Work 写入记录 */}
        {isWork ? (
          <section>
            <h4 className="text-xs font-medium text-ink mb-1.5">写入记录</h4>
            {writeRecords.length === 0 ? (
              <p className="text-[11px] text-ink-faint">本次会话暂无文件写入。</p>
            ) : (
              <ul className="space-y-1">
                {writeRecords.map((r, i) => (
                  <li
                    key={`${r.at}-${i}`}
                    className={`flex items-start gap-1.5 px-2 py-1.5 rounded border text-[11px] ${
                      r.ok ? 'border-line/60 bg-paper/40' : 'border-seal-2/30 bg-[rgba(192,57,43,0.05)]'
                    }`}
                  >
                    {r.ok ? <Check className="w-3 h-3 mt-0.5 shrink-0 text-jade" /> : <Pencil className="w-3 h-3 mt-0.5 shrink-0 text-seal-2" />}
                    <span className="min-w-0 flex-1">
                      <span className="font-mono break-all">{r.path}</span>
                      <span className="ml-1 text-ink-faint">({r.tool})</span>
                      {!r.ok ? <span className="block text-seal-2">{r.detail}</span> : null}
                    </span>
                    <span className="shrink-0 text-ink-faint">{formatRelativeTime(r.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {/* 切换动作 */}
        <section className="pt-1">
          {isWork ? (
            <Button size="sm" variant="secondary" onClick={switchBackToDiscuss} loading={switching} disabled={running} className="w-full">
              切回 Discuss（只读）
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => setModalOpen(true)} disabled={running} className="w-full">
              <Hammer className="w-3.5 h-3.5" />
              切换到 Work 模式
            </Button>
          )}
          {running ? <p className="mt-1.5 text-[10px] text-ink-faint">运行中的会话不能切换模式，请先停止。</p> : null}
        </section>
      </div>

      {/* Work 切换确认 Modal（显式授权，§7.6） */}
      <Modal
        open={modalOpen}
        title="切换到 Work 模式"
        onClose={() => setModalOpen(false)}
        contentClassName="max-w-lg"
      >
        <div className="space-y-4">
          <div className="px-3 py-2.5 rounded-md border border-[rgba(180,83,9,0.35)] bg-[rgba(180,83,9,0.05)] text-xs leading-relaxed text-ink-soft">
            Agent 将可以在所选目录内<b className="text-ink">创建、修改文件</b>。它
            <b className="text-ink">不能执行任何命令</b>（不提供 shell）；原始库与标准库对它只读。
            请只授权你接受其被修改的工作目录。
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-ink">选择 Workspace</span>
              <button
                type="button"
                onClick={() => setAdding((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] text-jade hover:text-seal"
              >
                <FolderPlus className="w-3 h-3" />
                {adding ? '收起' : '新增 Workspace'}
              </button>
            </div>

            {adding ? (
              <div className="mb-2.5 p-3 rounded-md border border-line bg-paper/50 space-y-2">
                <div className="grid grid-cols-[1fr_2fr] gap-2">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="名称"
                    className="h-8 px-2 rounded border border-line bg-card-bg text-xs focus:outline-none focus:border-seal/50"
                    aria-label="Workspace 名称"
                  />
                  <div className="flex gap-1.5">
                    <input
                      value={newPath}
                      onChange={(e) => setNewPath(e.target.value)}
                      placeholder="目录绝对路径"
                      className="flex-1 min-w-0 h-8 px-2 rounded border border-line bg-card-bg text-xs font-mono focus:outline-none focus:border-seal/50"
                      aria-label="Workspace 目录路径"
                    />
                    <Button size="sm" variant="secondary" onClick={pickDirectory}>
                      选择…
                    </Button>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                    取消
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={submitAddWorkspace}
                    loading={addBusy}
                    disabled={!newName.trim() || !newPath.trim()}
                  >
                    <FilePlus2 className="w-3.5 h-3.5" />
                    添加
                  </Button>
                </div>
              </div>
            ) : null}

            {wsLoading ? (
              <p className="flex items-center gap-2 text-xs text-ink-faint py-3">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> 正在读取 Workspace…
              </p>
            ) : workspaces && workspaces.length > 0 ? (
              <ul className="space-y-1.5 max-h-[240px] overflow-auto scrollbar-thin pr-1">
                {workspaces.map((w) => (
                  <li key={w.id}>
                    <label
                      className={`flex items-start gap-2.5 px-3 py-2 rounded-md border cursor-pointer transition-colors ${
                        selectedWs === w.id
                          ? 'border-seal/50 bg-[rgba(158,43,37,0.05)]'
                          : 'border-line hover:bg-paper'
                      }`}
                    >
                      <input
                        type="radio"
                        name="workspace"
                        checked={selectedWs === w.id}
                        onChange={() => setSelectedWs(w.id)}
                        className="mt-1 accent-[#9e2b25]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-ink">{w.name}</span>
                        <span className="block text-[11px] text-ink-faint font-mono break-all">{w.path}</span>
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          void removeWorkspace(w.id, w.name);
                        }}
                        className="p-1 rounded text-ink-faint hover:text-seal-2"
                        aria-label={`移除 ${w.name}`}
                        title="移除该 Workspace"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-ink-faint py-2">
                还没有 Workspace。点击「新增 Workspace」授权一个工作目录（桌面端可用目录选择器）。
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setModalOpen(false)} disabled={switching}>
              取消
            </Button>
            <Button size="sm" variant="primary" onClick={confirmSwitchToWork} loading={switching} disabled={!validSelection}>
              确认切换（授权写入）
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
