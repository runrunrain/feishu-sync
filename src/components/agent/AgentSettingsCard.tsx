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
  ImageIcon,
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
  getAgentVisionStatus,
  getKbMcpInfo,
  listAgentWorkspaces,
  testAgentVision,
} from '../../api/client';
import { describeReadinessCode as describeReadiness } from '../../utils/agentReadiness';
import type {
  AgentConfig,
  AgentVisionConfig,
  AgentVisionStatusDto,
  AgentVisionTestResult,
  AgentWorkspaceConfig,
  KbMcpInfoDto,
  StandardKbConfig,
} from '../../types/agent';

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
      <header className="px-4 py-3 border-b border-line/60 flex items-start gap-3">
        <div className="mt-0.5 text-ink-faint">{icon}</div>
        <div className="min-w-0">
          <h3 className="text-sm font-kai font-medium text-ink">{title}</h3>
          <p className="mt-0.5 text-xs text-ink-faint leading-snug">{description}</p>
        </div>
      </header>
      <div className="p-4 space-y-3">{children}</div>
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

/** 图片理解默认参数（与服务端 buildDefaultAgentVisionConfig 对齐；仅防御性兜底，保存时服务端仍会归一）。 */
export const DEFAULT_VISION_CONFIG: AgentVisionConfig = {
  enabled: false,
  concurrency: 3,
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerBuild: 300,
  timeoutMs: 120_000,
};

/** 测试按钮可用条件：已启用，或已显式选了 provider/model（服务端允许启用前试测）。导出供单测锚定。 */
export function canTestVision(visionEnabled: boolean, providerId: string, modelId: string): boolean {
  return visionEnabled || Boolean(providerId) || Boolean(modelId);
}

// ---------------------------------------------------------------------------
// P2-S3：构建字数预算（消费 P2-S2 契约：{0} ∪ [4000, 400000]，缺省 40000）
// ---------------------------------------------------------------------------

/** 每批字数预算取值域边界（与 server normalizeBuildBatchWordBudget 同源；
 *  PUT 未新增拒绝规则，越界值服务端静默钳到边界，前端按同款逻辑先行钳制，
 *  保证「保存将按 N 生效」提示与实际落盘值一致）。导出供单测锚定。 */
export const BUILD_BATCH_WORD_BUDGET_MIN = 4000;
export const BUILD_BATCH_WORD_BUDGET_MAX = 400000;
export const BUILD_BATCH_WORD_BUDGET_DEFAULT = 40000;

/** 对齐 server 链制语义（normalizeBuildBatchWordBudget）：非数字/非有限数
 *  （含空串）→ 缺省 40000；floor 后 ≤0 → 0（按源数分批）；再链到
 *  [4000, 400000]。PUT 未新增拒绝规则，越界值服务端静默链到边界，前端
 *  按同款逻辑先行链制，保证提示与实际落盘值一致。导出供单测锚定。 */
export function clampBuildBatchWordBudget(raw: string | number): number {
  if (typeof raw === 'string' && !raw.trim()) return BUILD_BATCH_WORD_BUDGET_DEFAULT;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) return BUILD_BATCH_WORD_BUDGET_DEFAULT;
  const budget = Math.floor(value);
  if (budget <= 0) return 0;
  return Math.min(BUILD_BATCH_WORD_BUDGET_MAX, Math.max(BUILD_BATCH_WORD_BUDGET_MIN, budget));
}

/** 输入框即时反馈（null = 输入合法且不会链制，直接保存即可；
 *  'error' 阻断保存，'hint'/'warn' 仅提示）。导出供单测锚定。 */
export function describeBuildBatchWordBudgetInput(
  raw: string,
): { level: 'hint' | 'warn' | 'error'; text: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { level: 'error', text: '请输入数字（0 或 4000–400000）' };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { level: 'error', text: '非数字：保存时将回落缺省 40000，请修正后再保存' };
  }
  if (value <= 0) {
    // 0 是合法取值；负数/小数 ≤0 会被链到 0，同样回到「按源数分批」。
    return { level: 'hint', text: '0 = 按源数分批（旧行为，兼容回退开关）' };
  }
  const clamped = clampBuildBatchWordBudget(value);
  if (clamped !== Math.floor(value)) {
    return {
      level: 'warn',
      text: clamped < value
        ? `高于上限 ${BUILD_BATCH_WORD_BUDGET_MAX}，保存将按 ${clamped} 生效`
        : `低于下限 ${BUILD_BATCH_WORD_BUDGET_MIN}，保存将按 ${clamped} 生效`,
    };
  }
  return { level: 'hint', text: '0 = 按源数分批（旧行为）；范围 4000–400000，越界保存时按边界链制' };
}

/** 测试结果一行摘要。导出供单测锚定。 */
export function describeVisionTestResult(result: AgentVisionTestResult): string {
  if (result.ok) return `测试通过 · ${result.model} · ${result.latencyMs}ms`;
  return `测试失败（${result.error?.code ?? result.finishReason}）：${result.error?.message ?? '远端调用失败'}`;
}

/** vision 状态行文案（disabled/ready/invalid；徽标已显状态名，行文不重复）。导出供单测锚定。 */
export function describeVisionStatus(status: AgentVisionStatusDto): string {
  if (status.state === 'ready') return `图片描述通道可用 · ${status.model ?? ''} · 已缓存图片描述 ${status.cachedCount} 条`;
  if (status.state === 'invalid') return `配置无效：${status.message || '引用的提供商/模型不可用'}`;
  return '未启用';
}

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
  const [claudeCliPath, setClaudeCliPath] = useState('');
  const [saving, setSaving] = useState(false);

  // ---- S2/S5：图片理解段（独立状态面；保存走 agent.vision，不动文本模型配置） ----
  const vision = agent?.vision ?? DEFAULT_VISION_CONFIG;
  const visionEnabled = vision.enabled;
  const visionProviderId = vision.providerId || config?.llm.activeProviderId || '';
  const visionModelId = vision.modelId || '';
  const [visionStatus, setVisionStatus] = useState<AgentVisionStatusDto | null>(null);
  const [visionStatusLoading, setVisionStatusLoading] = useState(true);
  const [visionTesting, setVisionTesting] = useState(false);
  const [visionTest, setVisionTest] = useState<AgentVisionTestResult | null>(null);

  useEffect(() => {
    let disposed = false;
    setVisionStatusLoading(true);
    getAgentVisionStatus()
      .then((status) => { if (!disposed) setVisionStatus(status); })
      .catch(() => { if (!disposed) setVisionStatus(null); })
      .finally(() => { if (!disposed) setVisionStatusLoading(false); });
    return () => { disposed = true; };
  }, [config]);

  const runVisionTest = async () => {
    setVisionTesting(true);
    setVisionTest(null);
    try {
      const result = await testAgentVision({
        ...(visionProviderId ? { providerId: visionProviderId } : {}),
        ...(visionModelId ? { modelId: visionModelId } : {}),
      });
      setVisionTest(result);
    } catch (err) {
      // 400（vision_unconfigured / invalid_config）等服务端拒绝也如实展示。
      setVisionTest({
        ok: false,
        finishReason: 'error',
        model: '',
        latencyMs: 0,
        sample: '',
        error: {
          code: err instanceof APIError ? String(err.response?.error ?? err.statusCode ?? 'request_failed') : 'request_failed',
          message: err instanceof Error ? err.message : '测试请求失败',
        },
      });
    } finally {
      setVisionTesting(false);
    }
  };

  useEffect(() => {
    setNodePath(agent?.runtime?.nodePath ?? '');
    setPiCliPath(agent?.runtime?.piCliPath ?? '');
    setClaudeCliPath(agent?.runtime?.claudeCliPath ?? '');
  }, [agent?.runtime?.nodePath, agent?.runtime?.piCliPath, agent?.runtime?.claudeCliPath]);

  const readiness = agentStatus.status
    ? describeReadiness(agentStatus.status.code, agentStatus.status)
    : null;
  const ready = agentStatus.status?.code === 'ready' && !agentStatus.unreachable;

  const providers = useMemo(() => (config?.llm.providers ?? []).filter((p) => p.enabled && p.apiKey?.trim() && (/^https?:\/\//i.test(p.openAiCompatBaseUrl) || Object.values(p.protocolBaseUrls ?? {}).some((url) => /^https?:\/\//i.test(url ?? ''))) && p.models.some((m) => m.enabled && m.openAiModel.trim())), [config?.llm.providers]);
  const supportsClaude = (p: typeof providers[number]) => /^https?:\/\//i.test(p.protocolBaseUrls?.['anthropic-messages'] || (p.protocol === 'anthropic-messages' ? p.openAiCompatBaseUrl : ''));
  const visionSelectedProvider = providers.find((p) => p.id === visionProviderId);
  const currentProviderId = agent?.model?.providerId || config?.llm.activeProviderId || '';
  const selectedProvider = providers.find((p) => p.id === currentProviderId);
  const currentModelId = agent?.model?.modelId || (currentProviderId === config?.llm.activeProviderId ? config?.llm.activeModelId : '') || selectedProvider?.defaultModelId || '';
  const backend = agent?.runtime?.backend ?? 'pi';
  const source = backend === 'claude-code' ? 'app-llm' : agent?.model?.source ?? 'app-llm';
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
  const invalidPiModel = Boolean(piModel) && !loadingModels && !piModels.includes(piModel);
  const thinking = agent?.model?.thinkingLevel ?? 'off';

  const saveAgent = async (patch: {
    runtime?: Partial<AgentConfig['runtime']>;
    model?: Partial<AgentConfig['model']>;
    vision?: Partial<AgentVisionConfig>;
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
        ...(patch.vision ? { vision: { ...DEFAULT_VISION_CONFIG, ...baseAgent.vision, ...patch.vision } } : {}),
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
      description="选择新会话及标准库构建使用的基座；既有会话保留原有基座和历史"
    >
      <div>
        <FieldLabel>Agent 基座</FieldLabel>
        <div className="flex gap-2">
          <Button size="sm" variant={backend === 'pi' ? 'primary' : 'secondary'} disabled={saving} onClick={() => void saveAgent({ runtime: { backend: 'pi' } })}>Pi</Button>
          <Button size="sm" variant={backend === 'claude-code' ? 'primary' : 'secondary'} disabled={saving} onClick={() => void saveAgent({ runtime: { backend: 'claude-code' } })}>Claude Code</Button>
        </div>
        {backend === 'claude-code' && <p className="mt-1 text-[11px] text-ink-faint">使用应用内 Anthropic Messages 兼容提供商。应用上下文与受控工具可用；Pi 专用扩展不会加载。预设上下文窗口用于自动压缩，实际窗口受 Claude Code 和模型限制。</p>}
      </div>
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
          {backend === 'claude-code' ? (agentStatus.status?.runtime.claudeVersion ? ` · Claude Code ${agentStatus.status.runtime.claudeVersion}` : ' · 未发现 Claude Code') : agentStatus.status?.runtime.piVersion ? (
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
          <FieldLabel hint="留空自动发现">{backend === 'claude-code' ? 'Claude Code 可执行文件路径' : 'pi 包路径'}</FieldLabel>
          <input
            className={`${INPUT_CLS} font-mono text-xs`}
            value={backend === 'claude-code' ? claudeCliPath : piCliPath}
            onChange={(e) => backend === 'claude-code' ? setClaudeCliPath(e.target.value) : setPiCliPath(e.target.value)}
            placeholder={backend === 'claude-code' ? '自动发现 Claude Code' : '自动发现（>=1.4.0 <2）'}
            aria-label={backend === 'claude-code' ? 'Claude Code 路径覆盖' : 'pi 路径覆盖'}
          />
        </div>
      </div>

      {/* 模型来源 */}
      <div>
        <FieldLabel>模型来源</FieldLabel>
        {backend === 'claude-code' ? (
          <p className="rounded-md border border-line px-3 py-2 text-xs text-ink">应用内服务提供商</p>
        ) : <div className="grid grid-cols-2 gap-2">
          <label
            className={`flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer text-xs ${
              source === 'app-llm' ? 'border-seal/50 bg-[rgba(158,43,37,0.05)] text-ink' : 'border-line text-ink-soft hover:bg-paper'
            }`}
          >
            <input
              type="radio"
              name="agent-model-source"
              checked={source === 'app-llm'}
              disabled={saving}
              onChange={() => saveAgent({ model: { source: 'app-llm' } })}
              className="accent-[#9e2b25]"
            />
            应用内服务提供商
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
              disabled={saving}
              onChange={() => saveAgent({ model: { source: 'pi-agent-dir' } })}
              className="accent-[#9e2b25]"
            />
            本地 Agent 配置（Pi）
          </label>
        </div>}
      </div>

      {source === 'app-llm' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <FieldLabel>提供商（应用内已配置）</FieldLabel>
            <select
              className={INPUT_CLS}
              value={currentProviderId}
              onChange={(e) => saveAgent({ model: { providerId: e.target.value, modelId: '' } })}
              aria-label="选择提供商"
            >
              <option value="">（跟随应用默认）</option>
              {currentProviderId && (!selectedProvider || (backend === 'claude-code' && !supportsClaude(selectedProvider))) ? <option value={currentProviderId} disabled>原提供商不可用或协议不兼容，请重新选择</option> : null}
              {providers.filter((p) => backend !== 'claude-code' || supportsClaude(p)).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {backend === 'claude-code' || p.protocol === 'anthropic-messages' ? 'Anthropic' : p.protocol === 'openai-responses' ? 'Responses' : 'Chat Completions'}
                </option>
              ))}
            </select>
            {providers.filter((p) => backend !== 'claude-code' || supportsClaude(p)).length === 0 ? (
              <p className="mt-1 text-[11px] text-ink-faint">{backend === 'claude-code' ? '请配置 Anthropic Messages 兼容的提供商、API Key 和模型。' : '尚无可用提供商，请在「服务提供商与模型」中配置端点、API Key 并启用模型。'}</p>
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
              {currentModelId && !selectedProvider?.models.some((m) => m.id === currentModelId && m.enabled && m.openAiModel.trim()) ? <option value={currentModelId} disabled>原模型预设不可用，请重新选择</option> : null}
              {(selectedProvider?.models ?? [])
                .filter((m) => m.enabled && m.openAiModel.trim())
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.openAiModel}
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
            通过 pi 加载配置与认证后列出可用模型，按提供商分组；选择后自动保存。认证由 Pi 在本地只读解析，不会复制密钥或改写通用 Pi 配置；未配置认证的内置目录不会列出。实际连通性以调用结果为准。
          </p>
          {invalidPiModel ? <p className="mt-1 text-xs text-seal-2" role="alert">原模型已不在可用列表中，请重新选择。</p> : null}
          {!loadingModels && piModels.length === 0 ? (
            <p className="mt-1 text-xs text-ink-soft">{agentStatus.unreachable ? '模型列表读取失败，请刷新重试。' : '请检查本机 pi 配置与认证，然后刷新模型。'}</p>
          ) : null}
        </div>
      )}

      {/* S2/S5：图片理解段（设计 §3.6；文本模型下方） */}
      <div className="rounded-md border border-line bg-paper/30 p-3 space-y-2.5" data-testid="vision-section">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink">
            <ImageIcon className="w-3.5 h-3.5 text-ink-faint" />
            图片理解
          </span>
          <label className="flex items-center gap-2 text-xs text-ink-soft cursor-pointer">
            <input
              type="checkbox"
              className="accent-[#9e2b25]"
              checked={visionEnabled}
              disabled={saving || providers.length === 0}
              onChange={(e) => saveAgent({ vision: { enabled: e.target.checked } })}
              aria-label="启用图片理解"
              data-testid="vision-enabled-toggle"
            />
            启用
          </label>
        </div>

        <div className="flex items-center gap-2 flex-wrap text-[11px] text-ink-faint" data-testid="vision-status">
          {visionStatusLoading ? (
            <span>正在读取图片理解状态…</span>
          ) : visionStatus ? (
            <>
              <StatusBadge
                status={visionStatus.state === 'ready' ? 'success' : visionStatus.state === 'invalid' ? 'warning' : 'neutral'}
              >
                {visionStatus.state === 'ready' ? '就绪' : visionStatus.state === 'invalid' ? '配置无效' : '未启用'}
              </StatusBadge>
              <span className="min-w-0">{describeVisionStatus(visionStatus)}</span>
            </>
          ) : (
            <span>图片理解状态不可用（服务未实现或不可达）</span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <FieldLabel>识图提供商</FieldLabel>
            <select
              className={INPUT_CLS}
              value={visionProviderId}
              disabled={saving}
              onChange={(e) => saveAgent({ vision: { providerId: e.target.value || undefined, modelId: undefined } })}
              aria-label="识图提供商"
            >
              <option value="">（跟随应用默认）</option>
              {visionProviderId && !visionSelectedProvider ? <option value={visionProviderId} disabled>原提供商未配置或不可用，请重新选择</option> : null}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.protocol === 'anthropic-messages' ? 'Anthropic' : p.protocol === 'openai-responses' ? 'Responses' : 'Chat Completions'}
                </option>
              ))}
            </select>
            {providers.length === 0 ? (
              <p className="mt-1 text-[11px] text-ink-faint">尚无可用提供商，请先在「服务提供商与模型」中配置。</p>
            ) : null}
          </div>
          <div>
            <FieldLabel hint="标注「支持图片」为声明能力">识图模型预设</FieldLabel>
            <select
              className={INPUT_CLS}
              value={visionModelId}
              disabled={saving}
              onChange={(e) => saveAgent({ vision: { modelId: e.target.value || undefined } })}
              aria-label="识图模型预设"
            >
              <option value="">（提供商默认预设）</option>
              {visionModelId && !visionSelectedProvider?.models.some((m) => m.id === visionModelId) ? <option value={visionModelId} disabled>原模型预设不可用，请重新选择</option> : null}
              {(visionSelectedProvider?.models ?? [])
                .filter((m) => m.enabled && m.openAiModel.trim())
                .map((m) => (
                  <option key={m.id} value={m.id} disabled={m.supportsImages === false}>
                    {m.name} · {m.openAiModel}
                    {m.supportsImages === true ? '（支持图片）' : m.supportsImages === false ? '（不支持图片）' : ''}
                  </option>
                ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="secondary"
            loading={visionTesting}
            disabled={saving || providers.length === 0 || !canTestVision(visionEnabled, visionProviderId, visionModelId)}
            onClick={() => void runVisionTest()}
            data-testid="vision-test-button"
          >
            测试识图
          </Button>
          <span className="text-[11px] text-ink-faint">用内置测试图实测所选模型（真实调用远端，消耗少量额度）</span>
        </div>

        {visionTest ? (
          <div data-testid="vision-test-result" className={visionTest.ok ? 'text-[11px] text-jade leading-snug' : 'text-[11px] text-seal-2 leading-snug'} role={visionTest.ok ? undefined : 'alert'}>
            <p>{describeVisionTestResult(visionTest)}</p>
            {visionTest.ok && visionTest.sample ? (
              <p className="mt-0.5 text-ink-soft whitespace-pre-wrap">{visionTest.sample.slice(0, 200)}{visionTest.sample.length > 200 ? '…' : ''}</p>
            ) : null}
          </div>
        ) : null}

        <p className="text-[11px] text-ink-faint leading-relaxed">
          启用后，标准库构建与 Work 会话会把源文档中的图片发送到所选端点生成文字描述，结果按图片内容缓存；
          未启用时构建仍可发布，图片处会插入「未理解」标记。凭证取自所选提供商，不在此重复输入。
        </p>
      </div>

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
          onClick={() => saveAgent({ runtime: { nodePath: nodePath.trim() || undefined, piCliPath: piCliPath.trim() || undefined, claudeCliPath: claudeCliPath.trim() || undefined } })}
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

  // P2-S3：每批字数预算输入（回填自服务端链制后的真相值；保存按前端同款链制发送）。
  const [budgetInput, setBudgetInput] = useState('');
  const [savingBudget, setSavingBudget] = useState(false);

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

  useEffect(() => {
    const value = config?.standardKb?.buildBatchWordBudget;
    setBudgetInput(value === undefined || value === null ? '' : String(value));
  }, [config?.standardKb?.buildBatchWordBudget]);

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
          buildBatchWordBudget: BUILD_BATCH_WORD_BUDGET_DEFAULT,
          promptTimeoutMinutes: 15,
          buildTimeoutMinutes: 180,
          buildParallelism: 2,
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

  // P2-S3：每批字数预算（数字输入 + 保存；越界即时提示链制结果，保存按链制值发送）。
  const budgetFeedback = describeBuildBatchWordBudgetInput(budgetInput);
  const saveBudget = async () => {
    if (!budgetInput.trim() || !Number.isFinite(Number(budgetInput.trim()))) {
      toast.push({ type: 'warning', message: '请输入数字（0 或 4000–400000）' });
      return;
    }
    setSavingBudget(true);
    try {
      const base: StandardKbConfig =
        config?.standardKb ?? {
          outputRoot: '',
          retainReleases: 3,
          buildBatchSize: 10,
          buildBatchWordBudget: BUILD_BATCH_WORD_BUDGET_DEFAULT,
          promptTimeoutMinutes: 15,
          buildTimeoutMinutes: 180,
          buildParallelism: 2,
          autoBuildAfterSync: false,
        };
      await updateConfig({ standardKb: { ...base, buildBatchWordBudget: clampBuildBatchWordBudget(budgetInput) } });
      toast.push({ type: 'success', message: '每批字数预算已保存' });
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '保存失败' });
    } finally {
      setSavingBudget(false);
    }
  };

  // S4 §4.6：构建并行数（1..6；选择即保存，服务端严格校验并夹取）。
  const buildParallelism = config?.standardKb?.buildParallelism ?? 2;
  const saveBuildParallelism = async (value: number) => {
    try {
      const base: StandardKbConfig =
        config?.standardKb ?? {
          outputRoot: '',
          retainReleases: 3,
          buildBatchSize: 10,
          buildBatchWordBudget: BUILD_BATCH_WORD_BUDGET_DEFAULT,
          promptTimeoutMinutes: 15,
          buildTimeoutMinutes: 180,
          buildParallelism: 2,
          autoBuildAfterSync: false,
        };
      await updateConfig({ standardKb: { ...base, buildParallelism: value } });
      toast.push({ type: 'success', message: `构建并行数已设为 ${value}` });
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '保存失败' });
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
    <div className="space-y-3">
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

        {/* S4 §4.6：构建并行数 */}
        <div>
          <FieldLabel hint="1..6">构建并行数</FieldLabel>
          <select
            className={INPUT_CLS}
            value={String(buildParallelism)}
            disabled={savingRoot}
            onChange={(e) => void saveBuildParallelism(Number(e.target.value))}
            aria-label="构建并行数"
            data-testid="build-parallelism-select"
          >
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n} 路{n === 1 ? '（单进程，行为与旧版一致）' : ''}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-ink-faint" data-testid="build-parallelism-hint">
            实际并行受 Agent 进程上限（maxConcurrentProcesses 的后台配额）与工作单元数约束；
            1 路为单进程等价回退，多路只在多单元构建时生效。
          </p>
        </div>

        {/* P2-S3：每批字数预算（字数预算制分批；0 = 按源数分批旧行为） */}
        <div>
          <FieldLabel hint="0 或 4000–400000">每批字数预算</FieldLabel>
          <div className="flex gap-2">
            <input
              className={`${INPUT_CLS} font-mono text-xs`}
              type="number"
              min={0}
              step={1000}
              value={budgetInput}
              disabled={savingBudget}
              onChange={(e) => setBudgetInput(e.target.value)}
              placeholder="40000"
              aria-label="每批字数预算"
              data-testid="build-word-budget-input"
            />
            <Button
              size="sm"
              variant="secondary"
              loading={savingBudget}
              disabled={budgetFeedback?.level === 'error'}
              onClick={saveBudget}
              className="shrink-0 whitespace-nowrap"
              data-testid="build-word-budget-save"
            >
              保存
            </Button>
          </div>
          {budgetFeedback && budgetFeedback.level !== 'hint' ? (
            <p
              className={`mt-1 text-[11px] leading-snug ${
                budgetFeedback.level === 'error' ? 'text-seal-2' : 'text-amber-700'
              }`}
              role={budgetFeedback.level === 'error' ? 'alert' : undefined}
              data-testid="build-word-budget-feedback"
            >
              {budgetFeedback.text}
            </p>
          ) : null}
          <p className="mt-1 text-[11px] text-ink-faint leading-relaxed" data-testid="build-word-budget-hint">
            0 = 按源数分批（旧行为）；范围 4000–400000，越界保存时按边界链制，非数字回落缺省 40000。
            构建分批按有效字数（源正文 + 已描述图片文字）装箱，与模型上下文消耗同量纲，
            单源超预算时独占一批；「每批源数上限」仍由构建批次大小约束。
          </p>
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
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="名称"
                className="min-w-0 h-8 px-2 rounded border border-line bg-card-bg text-xs focus:outline-none focus:border-seal/50"
                aria-label="Workspace 名称"
              />
              <div className="flex min-w-0 gap-1.5">
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
              <span className="min-w-0 flex-1 text-[11px] text-ink-faint font-mono truncate">{mcp.command} {mcp.args.join(' ')}</span>
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
    </div>
  );
}
