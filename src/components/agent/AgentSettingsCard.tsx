/**
 * AgentSettingsCard —— 设置页 Agent 段（F2，设计 §11.4）
 *
 * 覆盖：运行时状态（node/pi 路径与版本、就绪码）+ 重新检测、路径覆盖、
 * 模型来源（app-llm 下拉选既有 provider/preset；pi-agent-dir 从pi有效
 * 配置探测的列表中选择）、thinking 档位、标准库输出目录、Workspace 增删、
 * MCP 连接片段（复制按钮，API §9.5）。
 *
 * 秘密边界：本卡不展示/不持有任何 apiKey（provider key 由「模型与整理」
 * 卡管理）；agent.status DTO 本身无秘密字段。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Check,
  Copy,
  Database,
  FolderPlus,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Button } from '../common/Button';
import { StatusBadge } from '../common/StatusBadge';
import { useToast } from '../common/Toast';
import { useConfig } from '../../hooks/useConfig';
import { useAgentStatus } from '../../hooks/useAgentStatus';
import {
  addAgentWorkspace,
  APIError,
  deleteAgentWorkspace,
  getKbMcpInfo,
  listAgentWorkspaces,
} from '../../api/client';
import { describeReadinessCode as describeReadiness } from '../../utils/agentReadiness';
import type { AgentConfig, AgentWorkspaceConfig, KbMcpInfoDto, StandardKbConfig } from '../../types/agent';

/** 设置卡骨架（对齐既有设置卡片视觉：标题 + 描述 + 内容区）。 */
function CardShell({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-line bg-card-bg shadow-sm overflow-hidden">
      <header className="px-5 py-4 border-b border-line/60 flex items-start gap-3">
        <div className="mt-0.5 text-ink-faint">{icon}</div>
        <div className="min-w-0">
          <h3 className="text-sm font-kai font-medium text-ink">{title}</h3>
          <p className="mt-0.5 text-xs text-ink-faint leading-snug">{description}</p>
        </div>
      </header>
      <div className="p-5 space-y-4">{children}</div>
    </section>
  );
}

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <label className="block text-xs font-medium text-ink mb-1.5">
      {children}
      {hint ? <span className="ml-1.5 font-normal text-ink-faint">{hint}</span> : null}
    </label>
  );
}

const INPUT_CLS =
  'w-full h-9 px-3 rounded-md border border-line bg-card-bg text-sm text-ink focus:outline-none focus:border-seal/50 disabled:bg-paper-2 disabled:text-ink-faint';

// ---------------------------------------------------------------------------
// 运行时与模型
// ---------------------------------------------------------------------------

export function AgentRuntimeSettingsCard() {
  const toast = useToast();
  const { config, updateConfig } = useConfig();
  const agentStatus = useAgentStatus(true);

  const agent = config?.agent;
  const [nodePath, setNodePath] = useState('');
  const [piCliPath, setPiCliPath] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setNodePath(agent?.runtime?.nodePath ?? '');
    setPiCliPath(agent?.runtime?.piCliPath ?? '');
  }, [agent?.runtime?.nodePath, agent?.runtime?.piCliPath]);

  const readiness = agentStatus.status
    ? describeReadiness(agentStatus.status.code, agentStatus.status)
    : null;
  const ready = agentStatus.status?.code === 'ready' && !agentStatus.unreachable;

  const providers = useMemo(() => (config?.llm.providers ?? []).filter((p) => p.enabled), [config?.llm.providers]);
  const currentProviderId = agent?.model?.providerId || config?.llm.activeProviderId || '';
  const currentModelId = agent?.model?.modelId || config?.llm.activeModelId || '';
  const source = agent?.model?.source ?? 'app-llm';
  const piModel = agent?.model?.piModel ?? '';
  const piModels = useMemo(() => {
    if (agentStatus.unreachable || agentStatus.status?.model.source !== 'pi-agent-dir') return [];
    return [...new Set(agentStatus.status.model.available)].sort((a, b) => a.localeCompare(b));
  }, [agentStatus.status, agentStatus.unreachable]);
  const piModelGroups = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const model of piModels) {
      const provider = model.split('/')[0];
      groups.set(provider, [...(groups.get(provider) ?? []), model]);
    }
    return [...groups];
  }, [piModels]);
  const loadingModels = agentStatus.loading || agentStatus.rechecking
    || (!agentStatus.unreachable && agentStatus.status?.model.source !== source);
  const invalidPiModel = Boolean(piModel) && !loadingModels && piModels.length > 0 && !piModels.includes(piModel);
  const thinking = agent?.model?.thinkingLevel ?? 'off';

  const saveAgent = async (patch: {
    runtime?: { nodePath?: string; piCliPath?: string };
    model?: Partial<AgentConfig['model']>;
  }) => {
    setSaving(true);
    try {
      const baseAgent: AgentConfig =
        config?.agent ?? {
          runtime: {},
          model: {
            source: 'app-llm',
            thinkingLevel: 'off',
            contextWindow: 128000,
            maxTokens: 8192,
          },
          maxConcurrentProcesses: 2,
          idleTimeoutMinutes: 10,
          workspaces: [],
        };
      const next: AgentConfig = {
        ...baseAgent,
        runtime: { ...baseAgent.runtime, ...(patch.runtime ?? {}) },
        model: { ...baseAgent.model, ...(patch.model ?? {}) },
      };
      await updateConfig({ agent: next });
      toast.push({ type: 'success', message: 'Agent 配置已保存' });
      agentStatus.refresh();
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <CardShell
      icon={<Bot className="w-4 h-4" />}
      title="Agent 运行时与模型"
      description="pi 以外部子进程运行（RPC 侧车）；模型不可用时如实禁用并给出原因"
    >
      {/* 就绪状态 */}
      <div className="flex items-center gap-3 flex-wrap px-3 py-2.5 rounded-md border border-line bg-paper/40">
        {agentStatus.loading ? (
          <StatusBadge status="loading">检测中…</StatusBadge>
        ) : agentStatus.unreachable ? (
          <StatusBadge status="error">服务不可用</StatusBadge>
        ) : ready ? (
          <StatusBadge status="success">就绪</StatusBadge>
        ) : (
          <StatusBadge status="warning">{readiness?.reason ?? '未就绪'}</StatusBadge>
        )}
        <Button size="sm" variant="secondary" onClick={() => void agentStatus.recheck()} loading={agentStatus.rechecking}>
          <RefreshCw className="w-3.5 h-3.5" /> 重新检测
        </Button>
        <div className="min-w-0 text-[11px] text-ink-faint leading-relaxed">
          {agentStatus.status?.runtime.nodeVersion ? (
            <span className="font-mono">node {agentStatus.status.runtime.nodeVersion}</span>
          ) : (
            <span>未发现 Node</span>
          )}
          {agentStatus.status?.runtime.piVersion ? (
            <>
              {' · '}
              <span className="font-mono">pi {agentStatus.status.runtime.piVersion}</span>
            </>
          ) : (
            ' · 未发现 pi'
          )}
          {agentStatus.status?.model.model ? (
            <>
              {' · '}
              <span className="font-mono">{agentStatus.status.model.model}</span>
            </>
          ) : null}
          {readiness && !ready && readiness.action ? (
            <p className="mt-0.5 text-ink-soft">{readiness.action}</p>
          ) : null}
        </div>
      </div>

      {/* 路径覆盖 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <FieldLabel hint="留空自动发现">Node 可执行文件路径</FieldLabel>
          <input
            className={`${INPUT_CLS} font-mono text-xs`}
            value={nodePath}
            onChange={(e) => setNodePath(e.target.value)}
            placeholder="自动发现（≥22.19）"
            aria-label="Node 路径覆盖"
          />
        </div>
        <div>
          <FieldLabel hint="留空自动发现">pi 包路径</FieldLabel>
          <input
            className={`${INPUT_CLS} font-mono text-xs`}
            value={piCliPath}
            onChange={(e) => setPiCliPath(e.target.value)}
            placeholder="自动发现（>=1.4.0 <2）"
            aria-label="pi 路径覆盖"
          />
        </div>
      </div>

      {/* 模型来源 */}
      <div>
        <FieldLabel>模型来源</FieldLabel>
        <div className="grid grid-cols-2 gap-2">
          <label
            className={`flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer text-xs ${
              source === 'app-llm' ? 'border-seal/50 bg-[rgba(158,43,37,0.05)] text-ink' : 'border-line text-ink-soft hover:bg-paper'
            }`}
          >
            <input
              type="radio"
              name="agent-model-source"
              checked={source === 'app-llm'}
              disabled={saving || agentStatus.loading}
              onChange={() => saveAgent({ model: { source: 'app-llm' } })}
              className="accent-[#9e2b25]"
            />
            应用内模型（app-llm）
          </label>
          <label
            className={`flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer text-xs ${
              source === 'pi-agent-dir' ? 'border-seal/50 bg-[rgba(158,43,37,0.05)] text-ink' : 'border-line text-ink-soft hover:bg-paper'
            }`}
          >
            <input
              type="radio"
              name="agent-model-source"
              checked={source === 'pi-agent-dir'}
              disabled={saving || agentStatus.loading}
              onChange={() => saveAgent({ model: { source: 'pi-agent-dir' } })}
              className="accent-[#9e2b25]"
            />
            本机 pi 凭据
          </label>
        </div>
      </div>

      {source === 'app-llm' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <FieldLabel>提供商（应用内已配置）</FieldLabel>
            <select
              className={INPUT_CLS}
              value={currentProviderId}
              onChange={(e) => saveAgent({ model: { providerId: e.target.value } })}
              aria-label="选择提供商"
            >
              <option value="">（跟随「模型与整理」默认）</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {providers.length === 0 ? (
              <p className="mt-1 text-[11px] text-ink-faint">尚无已启用的提供商——在「模型与整理」中配置。</p>
            ) : null}
          </div>
          <div>
            <FieldLabel>模型预设</FieldLabel>
            <select
              className={INPUT_CLS}
              value={currentModelId}
              onChange={(e) => saveAgent({ model: { modelId: e.target.value } })}
              aria-label="选择模型预设"
            >
              <option value="">（默认）</option>
              {(providers.find((p) => p.id === currentProviderId)?.models ?? [])
                .filter((m) => m.enabled)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
      ) : (
        <div>
          <FieldLabel hint="从本机 pi 有效配置加载">pi 模型</FieldLabel>
          <div className="flex gap-2">
            <select
              className={`${INPUT_CLS} font-mono text-xs`}
              value={piModel}
              onChange={(e) => void saveAgent({ model: { piModel: e.target.value } })}
              disabled={saving || loadingModels || piModels.length === 0}
              aria-label="pi 模型"
            >
              <option value="" disabled>
                {loadingModels ? '正在加载 pi 模型…' : piModels.length ? '请选择 pi 模型' : '未发现可用模型'}
              </option>
              {piModel && !piModels.includes(piModel) ? (
                <option value={piModel} disabled>
                  {piModel}（{loadingModels ? '正在核验' : piModels.length ? '当前不可用' : '尚未核验'}）
                </option>
              ) : null}
              {piModelGroups.map(([provider, models]) => (
                <optgroup key={provider} label={provider}>
                  {models.map((model) => <option key={model} value={model}>{model}</option>)}
                </optgroup>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              loading={agentStatus.loading || agentStatus.rechecking}
              disabled={saving}
              className="shrink-0 whitespace-nowrap"
              onClick={() => void agentStatus.recheck()}
            >
              <RefreshCw className="w-3.5 h-3.5" /> 刷新模型
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-ink-faint">
            通过 pi 加载配置与认证后列出可用模型，按提供商分组；选择后自动保存。应用不读取其密钥，实际调用是否成功以模型响应为准。
          </p>
          {invalidPiModel ? <p className="mt-1 text-xs text-seal-2" role="alert">原模型已不在可用列表中，请重新选择。</p> : null}
          {!loadingModels && piModels.length === 0 ? (
            <p className="mt-1 text-xs text-ink-soft">{agentStatus.unreachable ? '模型列表读取失败，请刷新重试。' : '请检查本机 pi 配置与认证，然后刷新模型。'}</p>
          ) : null}
        </div>
      )}

      {/* thinking + 保存路径覆盖 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
        <div>
          <FieldLabel>思考档位</FieldLabel>
          <select
            className={INPUT_CLS}
            value={thinking}
            onChange={(e) => saveAgent({ model: { thinkingLevel: e.target.value as AgentConfig['model']['thinkingLevel'] } })}
            aria-label="思考档位"
          >
            <option value="off">关闭</option>
            <option value="minimal">最小</option>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={saving}
          onClick={() => saveAgent({ runtime: { nodePath: nodePath.trim() || undefined, piCliPath: piCliPath.trim() || undefined } })}
        >
          保存路径覆盖
        </Button>
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// 标准库目录 + Workspace + MCP
// ---------------------------------------------------------------------------

export function AgentKbSettingsCard() {
  const toast = useToast();
  const { config, updateConfig } = useConfig();

  const [outputRoot, setOutputRoot] = useState('');
  const [savingRoot, setSavingRoot] = useState(false);

  const [workspaces, setWorkspaces] = useState<AgentWorkspaceConfig[] | null>(null);
  const [wsLoading, setWsLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  const [mcp, setMcp] = useState<KbMcpInfoDto | null>(null);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOutputRoot(config?.standardKb?.outputRoot ?? '');
  }, [config?.standardKb?.outputRoot]);

  const reloadWorkspaces = async () => {
    setWsLoading(true);
    try {
      setWorkspaces(await listAgentWorkspaces());
    } catch {
      setWorkspaces([]);
    } finally {
      setWsLoading(false);
    }
  };
  useEffect(() => {
    void reloadWorkspaces();
    getKbMcpInfo()
      .then(setMcp)
      .catch(() => setMcp(null))
      .finally(() => setMcpLoading(false));
  }, []);

  const saveOutputRoot = async () => {
    setSavingRoot(true);
    try {
      const base: StandardKbConfig =
        config?.standardKb ?? {
          outputRoot: '',
          retainReleases: 3,
          buildBatchSize: 10,
          promptTimeoutMinutes: 15,
          buildTimeoutMinutes: 180,
          autoBuildAfterSync: false,
        };
      await updateConfig({ standardKb: { ...base, outputRoot: outputRoot.trim() } });
      toast.push({ type: 'success', message: '标准库目录已保存' });
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '保存失败' });
    } finally {
      setSavingRoot(false);
    }
  };

  const pickDirectory = async () => {
    if (typeof window !== 'undefined' && window.desktop?.selectDirectory) {
      const dir = await window.desktop.selectDirectory();
      if (dir) setNewPath(dir);
      return;
    }
    toast.push({ type: 'info', message: '浏览器模式下请手动输入目录绝对路径' });
  };

  const submitAdd = async () => {
    const name = newName.trim();
    const dir = newPath.trim();
    if (!name || !dir) return;
    setAddBusy(true);
    try {
      const created = await addAgentWorkspace({ name, path: dir });
      setWorkspaces((prev) => [...(prev ?? []), created]);
      setNewName('');
      setNewPath('');
      toast.push({ type: 'success', message: `Workspace「${created.name}」已添加` });
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '添加失败' });
    } finally {
      setAddBusy(false);
    }
  };

  const removeWs = async (ws: AgentWorkspaceConfig) => {
    try {
      await deleteAgentWorkspace(ws.id);
      setWorkspaces((prev) => (prev ?? []).filter((w) => w.id !== ws.id));
      toast.push({ type: 'info', message: `Workspace「${ws.name}」已移除` });
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '移除失败' });
    }
  };

  const copySnippet = async () => {
    if (!mcp?.snippet) return;
    try {
      await navigator.clipboard.writeText(mcp.snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.push({ type: 'warning', message: '复制失败，请手动选择文本复制' });
    }
  };

  return (
    <>
      <CardShell
        icon={<Database className="w-4 h-4" />}
        title="标准库输出目录与 Workspace"
        description="标准库必须位于原始库之外；Workspace 是 Work 会话唯一可写的授权目录"
      >
        <div>
          <FieldLabel hint="默认 ~/.feishu-sync/standard-kb">标准库输出目录</FieldLabel>
          <div className="flex gap-2">
            <input
              className={`${INPUT_CLS} font-mono text-xs`}
              value={outputRoot}
              onChange={(e) => setOutputRoot(e.target.value)}
              placeholder="/Users/you/.feishu-sync/standard-kb"
              aria-label="标准库输出目录"
            />
            <Button size="sm" variant="secondary" loading={savingRoot} onClick={saveOutputRoot}>
              保存
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-ink-faint">目录不得位于原始知识库内；已有内容且非标准库结构时会被拒绝。</p>
        </div>

        <div>
          <FieldLabel>Workspace（Work 模式可写目录）</FieldLabel>
          {wsLoading ? (
            <p className="flex items-center gap-2 text-xs text-ink-faint py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 读取中…
            </p>
          ) : workspaces && workspaces.length > 0 ? (
            <ul className="space-y-1.5 mb-2">
              {workspaces.map((w) => (
                <li
                  key={w.id}
                  className="flex items-center gap-2 px-3 py-2 rounded-md border border-line bg-paper/30"
                >
                  <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-jade" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-ink">{w.name}</span>
                    <span className="block text-[11px] text-ink-faint font-mono break-all">{w.path}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void removeWs(w)}
                    className="p-1.5 rounded text-ink-faint hover:text-seal-2 hover:bg-card-bg"
                    aria-label={`移除 ${w.name}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-faint mb-2">尚无 Workspace。Work 会话需要至少一个授权目录。</p>
          )}
          <div className="p-3 rounded-md border border-line bg-paper/40 space-y-2">
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
                  aria-label="Workspace 目录"
                />
                <Button size="sm" variant="secondary" onClick={pickDirectory}>
                  选择…
                </Button>
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" onClick={submitAdd} loading={addBusy} disabled={!newName.trim() || !newPath.trim()}>
                <FolderPlus className="w-3.5 h-3.5" /> 添加 Workspace
              </Button>
            </div>
          </div>
        </div>
      </CardShell>

      <CardShell
        icon={<Server className="w-4 h-4" />}
        title="标准库 MCP 连接"
        description="把已发布的标准知识库以只读 MCP 提供给外部工具（IDE、其他 Agent）"
      >
        {mcpLoading ? (
          <p className="flex items-center gap-2 text-xs text-ink-faint">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 读取连接信息…
          </p>
        ) : mcp ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              {mcp.available ? (
                <StatusBadge status="success">可用</StatusBadge>
              ) : (
                <StatusBadge status="neutral">未就绪</StatusBadge>
              )}
              <span className="text-[11px] text-ink-faint font-mono truncate">{mcp.command} {mcp.args.join(' ')}</span>
            </div>
            <div className="relative">
              <pre className="max-h-[180px] overflow-auto scrollbar-thin px-3 py-2.5 rounded-md border border-line bg-dark text-[11px] leading-relaxed text-paper font-mono whitespace-pre">
                {mcp.snippet}
              </pre>
              <Button size="sm" variant="secondary" className="absolute right-2 top-2" onClick={copySnippet}>
                {copied ? <Check className="w-3.5 h-3.5 text-jade" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? '已复制' : '复制'}
              </Button>
            </div>
            <p className="text-[11px] text-ink-faint leading-relaxed">
              推荐使用应用自带 Electron 以 Node 模式启动（见片段）；备选：{mcp.alternative.command}（{mcp.alternative.note}）。
              MCP 只读已发布内容，未发布时外部调用会得到明确错误。
            </p>
          </div>
        ) : (
          <p className="text-xs text-ink-faint">MCP 连接信息不可用（后端未实现或服务不可达）。</p>
        )}
      </CardShell>
    </>
  );
}
