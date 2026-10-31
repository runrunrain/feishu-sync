/**
 * BuildOrchestrationSettings —— 设置页 Agent 分组「构建编排」卡（T5a，B案 §3/§5/§6/§7/§8）
 *
 * 管理 standardKb 的编排段：buildRoles（撰写/审查/整合模型 + 思考档位）、
 * buildConcurrency（1..8 构建名额 N）、reviewPolicy（修订/接口重试上限）、
 * publishMode（auto/confirm）。数据契约 = server/src/types/agent-knowledge.ts
 * StandardKbConfig（T1 冻结），经现有 PUT /api/config 读写（唯一出口
 * src/api/client.ts），写入模式对齐 AgentSettingsCard 的即时暂存
 * （设置草稿内 updateConfig 只进草稿，顶部保存统一提交）。
 *
 * 写盘语义（与 server ConfigManager 浅合并行为对齐，勿凭直觉改）：
 * - PUT 的 standardKb 段内子对象整体替换：每次写 buildRoles 都携带全量
 *   （writer/reviewer 必带、plannerEnabled 恒保留现值）；integrator 只在
 *   显式选择时携带——「跟随撰写」= 省略该键，靠整体替换语义移除旧覆盖。
 * - buildConcurrency 缺省不落盘（防默认值冻结回落语义）；一旦写入，
 *   PUT 浅合并保留已写值、无法经本卡移除，故下拉只提供 1..8。
 * - thinking 'off' 是服务端缺省，选「关闭」时不写该键（undefined 不落盘）。
 */

import { useMemo, useState } from 'react';
import { Workflow } from 'lucide-react';
import { useToast } from '../common/Toast';
import { useConfig } from '../../hooks/useConfig';
import { useSettingsDraft } from '../../hooks/settingsDraft';
import { APIError } from '../../api/client';
import type {
  AgentThinkingLevel,
  KbBuildRoleConfig,
  KbBuildRolesConfig,
  StandardKbConfig,
} from '../../types/agent';

// ---------------------------------------------------------------------------
// 常量与纯函数（导出供单测锚定）
// ---------------------------------------------------------------------------

export const THINKING_LABELS: Record<AgentThinkingLevel, string> = {
  off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
};

const THINKING_LEVEL_SET = new Set<string>(Object.keys(THINKING_LABELS));

/** 角色模型下拉中「引用的预设已不存在/未启用」占位 value（不可选中）。 */
export const MISSING_PRESET_VALUE = '__missing__';

/** config.standardKb 整段缺失时的防御性兜底（对齐 AgentKbSettingsCard 的
 *  saveBuildParallelism fallback；服务端归一会补全各字段缺省）。 */
const FALLBACK_STANDARD_KB: StandardKbConfig = {
  outputRoot: '', retainReleases: 3, buildBatchSize: 10, buildBatchWordBudget: 40_000,
  promptTimeoutMinutes: 15, buildTimeoutMinutes: 180, buildParallelism: 2, autoBuildAfterSync: false,
};

/** B案 §6 构建名额解析的只读镜像（server resolveBuildConcurrency 同款语义）：
 *  buildConcurrency 优先，未设回落 buildParallelism（缺省 2），统一钳到 1..8。 */
export function resolveBuildConcurrencyClient(
  standardKb?: { buildConcurrency?: number; buildParallelism?: number } | null,
): number {
  const explicit = standardKb?.buildConcurrency;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.min(8, Math.max(1, Math.floor(explicit)));
  }
  const fallback = typeof standardKb?.buildParallelism === 'number' && Number.isFinite(standardKb.buildParallelism)
    ? standardKb.buildParallelism
    : 2;
  return Math.min(8, Math.max(1, Math.floor(fallback)));
}

export interface BuildOrchestrationIssue {
  field: string;
  message: string;
}

/** 前端轻校验（范围/枚举/预设引用必有效）。只校验显式值；'' 模型预设 =
 *  跟随活跃预设，是合法取值。校验结果同时用于表单内联错误展示与保存前拦截。 */
export function validateBuildOrchestrationInput(input: {
  standardKb?: Pick<StandardKbConfig, 'buildConcurrency' | 'buildRoles' | 'reviewPolicy' | 'publishMode'> | null;
  presets: Array<{ providerId: string; presetId: string }>;
}): BuildOrchestrationIssue[] {
  const issues: BuildOrchestrationIssue[] = [];
  const kb = input.standardKb;
  if (!kb) return issues;
  const concurrency = kb.buildConcurrency;
  if (concurrency !== undefined
    && (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)) {
    issues.push({ field: 'standardKb.buildConcurrency', message: '构建并发须为 1–8 的整数' });
  }
  const policy = kb.reviewPolicy;
  const revisions = policy?.maxAutoRevisions;
  if (revisions !== undefined && (!Number.isInteger(revisions) || revisions < 1 || revisions > 5)) {
    issues.push({ field: 'standardKb.reviewPolicy.maxAutoRevisions', message: '自动修订轮数上限须为 1–5 的整数（默认 2）' });
  }
  const retries = policy?.maxInterfaceRetries;
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 0 || retries > 5)) {
    issues.push({ field: 'standardKb.reviewPolicy.maxInterfaceRetries', message: '接口重试上限须为 0–5 的整数（默认 2）' });
  }
  if (kb.publishMode !== undefined && kb.publishMode !== 'auto' && kb.publishMode !== 'confirm') {
    issues.push({ field: 'standardKb.publishMode', message: '发布方式须为「自动发布」或「构建后待确认」' });
  }
  const roleEntries: Array<['writer' | 'reviewer' | 'integrator', KbBuildRoleConfig | undefined]> = [
    ['writer', kb.buildRoles?.writer],
    ['reviewer', kb.buildRoles?.reviewer],
    ['integrator', kb.buildRoles?.integrator],
  ];
  for (const [roleKey, role] of roleEntries) {
    if (!role) continue;
    if (typeof role.modelPresetId !== 'string') {
      issues.push({ field: `standardKb.buildRoles.${roleKey}.modelPresetId`, message: '模型预设引用无效' });
      continue;
    }
    if (role.modelPresetId
      && !input.presets.some((option) => option.presetId === role.modelPresetId
        && (!role.providerId || option.providerId === role.providerId))) {
      issues.push({
        field: `standardKb.buildRoles.${roleKey}.modelPresetId`,
        message: `引用的模型预设「${role.modelPresetId}」不存在或未启用，请重新选择`,
      });
    }
    if (role.thinking !== undefined && !THINKING_LEVEL_SET.has(role.thinking)) {
      issues.push({ field: `standardKb.buildRoles.${roleKey}.thinking`, message: '思考档位无效' });
    }
  }
  return issues;
}

/**
 * 从后端校验错误提取「字段路径 → 展示文本」映射（details 字段映射到表单项）。
 * 兼容两种形态：
 * 1. APIError.response.details = Array<{field, code}>（结构化，未来形态）；
 * 2. 400 config_validation_failed 的 message（现行形态）：InvalidConfigError
 *    的 message 形如 `配置校验失败：standardKb.buildConcurrency(out_of_range), …`，
 *    路由层未透传 details，按 `field(code)` 模式解析；只回收 standardKb.* 项。
 */
export function extractConfigFieldErrors(source: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  const response = (source as { response?: unknown } | null | undefined)?.response;
  const details = (response as { details?: unknown } | null | undefined)?.details;
  if (Array.isArray(details)) {
    for (const item of details) {
      if (!item || typeof item !== 'object') continue;
      const { field, code } = item as { field?: unknown; code?: unknown };
      if (typeof field !== 'string') continue;
      errors[field] = `${field}${typeof code === 'string' ? `(${code})` : ''}`;
    }
    if (Object.keys(errors).length > 0) return errors;
  }
  const message = source instanceof Error ? source.message : typeof source === 'string' ? source : '';
  for (const match of message.matchAll(/([A-Za-z0-9_.[\]]+)\((\w+)\)/g)) {
    if (match[1].startsWith('standardKb.')) errors[match[1]] = `${match[1]}(${match[2]})`;
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 骨架（对齐 AgentSettingsCard 的设置卡视觉约定）
// ---------------------------------------------------------------------------

const INPUT_CLS = 'h-9 w-full px-3 rounded-md border border-line bg-card-bg text-sm text-ink focus:outline-none focus:border-seal/50 disabled:bg-paper-2 disabled:text-ink-faint';

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <label className="block text-xs font-medium text-ink mb-1.5">
      {children}
      {hint ? <span className="ml-1.5 font-normal text-ink-faint">{hint}</span> : null}
    </label>
  );
}

/** 可选模型预设（应用已配置的 provider × enabled 模型，与「运行时与模型」同源筛选）。 */
interface BuildPresetOption {
  key: string;
  providerId: string;
  providerName: string;
  presetId: string;
  name: string;
  openAiModel: string;
  reasoning?: boolean;
  thinkingLevels?: AgentThinkingLevel[];
}

/** 定位角色当前引用的预设：providerId+id 精确匹配优先，缺省取同 id 首个；
 *  找不到（预设被删/停用）返回 null（下拉展示「不可用」占位 + 内联告警）。 */
function findRolePreset(role: KbBuildRoleConfig | undefined, options: BuildPresetOption[]): BuildPresetOption | null {
  if (!role?.modelPresetId) return null;
  const byId = options.filter((option) => option.presetId === role.modelPresetId);
  if (byId.length === 0) return null;
  return (role.providerId ? byId.find((option) => option.providerId === role.providerId) : undefined) ?? byId[0];
}

/** 预设可用的思考档位（对齐「运行时与模型」knownLevels：reasoning 声明才展开，
 *  否则仅「关闭」）；跟随活跃/撰写时取被跟随预设的档位。 */
function thinkingLevelsForPreset(option: BuildPresetOption | null): AgentThinkingLevel[] {
  if (!option?.reasoning || !option.thinkingLevels?.length) return ['off'];
  return ['off', ...option.thinkingLevels.filter((level) => level !== 'off')];
}

// ---------------------------------------------------------------------------
// 角色模型行（模型预设 + 思考档位）
// ---------------------------------------------------------------------------

function RoleModelRow({
  roleKey,
  label,
  followLabel,
  role,
  option,
  fallbackOption,
  options,
  error,
  onPresetChange,
  onThinkingChange,
}: {
  roleKey: 'writer' | 'reviewer' | 'integrator';
  label: string;
  /** 下拉空值项文案：writer/reviewer=跟随活跃预设（含当前值）；integrator=跟随撰写。 */
  followLabel: string;
  role: KbBuildRoleConfig | undefined;
  option: BuildPresetOption | null;
  /** 跟随（'' 值）时档位展示所参照的预设（writer→活跃预设，integrator→撰写）。 */
  fallbackOption: BuildPresetOption | null;
  options: BuildPresetOption[];
  error: string | null;
  onPresetChange: (key: string) => void;
  onThinkingChange: (level: AgentThinkingLevel) => void;
}) {
  const selectValue = !role?.modelPresetId ? '' : option ? option.key : MISSING_PRESET_VALUE;
  const thinking = role?.thinking ?? 'off';
  const levels = thinkingLevelsForPreset(option ?? fallbackOption);
  const groups = useMemo(() => {
    const map = new Map<string, BuildPresetOption[]>();
    for (const item of options) map.set(item.providerName, [...(map.get(item.providerName) ?? []), item]);
    return [...map];
  }, [options]);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid={`orch-role-${roleKey}`}>
      <div>
        <FieldLabel>{label}</FieldLabel>
        <select
          className={INPUT_CLS}
          value={selectValue}
          aria-label={label}
          data-testid={`orch-${roleKey}-preset`}
          onChange={(e) => onPresetChange(e.target.value)}
        >
          <option value="">{followLabel}</option>
          {selectValue === MISSING_PRESET_VALUE ? (
            <option value={MISSING_PRESET_VALUE} disabled>原模型预设不可用，请重新选择</option>
          ) : null}
          {groups.map(([providerName, presets]) => (
            <optgroup key={providerName} label={providerName}>
              {presets.map((preset) => (
                <option key={preset.key} value={preset.key}>
                  {preset.name} · {preset.openAiModel}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {error ? (
          <p className="mt-1 text-[11px] text-seal-2 leading-snug" role="alert" data-testid={`orch-${roleKey}-error`}>{error}</p>
        ) : null}
      </div>
      <div>
        <FieldLabel hint={role?.modelPresetId ? undefined : '跟随所选来源的档位'}>{label}思考档位</FieldLabel>
        <select
          className={INPUT_CLS}
          value={thinking}
          aria-label={`${label}思考档位`}
          data-testid={`orch-${roleKey}-thinking`}
          onChange={(e) => onThinkingChange(e.target.value as AgentThinkingLevel)}
        >
          {!levels.includes(thinking) ? <option value={thinking} disabled>{THINKING_LABELS[thinking] ?? thinking}（当前档位未确认）</option> : null}
          {levels.map((level) => (
            <option key={level} value={level}>{THINKING_LABELS[level]}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主卡
// ---------------------------------------------------------------------------

export function BuildOrchestrationSettings() {
  const toast = useToast();
  const { config, updateConfig } = useConfig();
  const draft = useSettingsDraft();
  /** updateConfig 立即保存路径（设置草稿外）失败时，从错误提取的字段映射。 */
  const [localFieldErrors, setLocalFieldErrors] = useState<Record<string, string>>({});

  const standardKb = config?.standardKb;
  const buildRoles = standardKb?.buildRoles;

  // 可选 provider 筛选与「运行时与模型」卡同源（enabled + 有密钥 + 有可用端点 + 至少一个 enabled 模型）。
  const providers = useMemo(() => (config?.llm.providers ?? []).filter((p) => p.enabled && p.apiKey?.trim()
    && (/^https?:\/\//i.test(p.openAiCompatBaseUrl) || Object.values(p.protocolBaseUrls ?? {}).some((url) => /^https?:\/\//i.test(url ?? '')))
    && p.models.some((m) => m.enabled && m.openAiModel.trim())), [config?.llm.providers]);

  const presetOptions = useMemo<BuildPresetOption[]>(() => providers.flatMap((provider) => provider.models
    .filter((model) => model.enabled && model.openAiModel.trim())
    .map((model) => ({
      key: `${provider.id}::${model.id}`,
      providerId: provider.id,
      providerName: provider.name,
      presetId: model.id,
      name: model.name,
      openAiModel: model.openAiModel,
      reasoning: model.reasoning,
      thinkingLevels: model.thinkingLevels,
    }))), [providers]);

  const activePresetOption = useMemo(
    () => presetOptions.find((option) => option.providerId === (config?.llm.activeProviderId ?? '')
      && option.presetId === (config?.llm.activeModelId ?? '')) ?? null,
    [presetOptions, config?.llm.activeProviderId, config?.llm.activeModelId],
  );
  const activeLabel = activePresetOption ? `${activePresetOption.providerName} / ${activePresetOption.name}` : '未配置';

  // ---- 前端轻校验（当前配置即时呈现）+ 服务器错误映射 ----
  const validationErrors = useMemo(() => {
    const issues = validateBuildOrchestrationInput({ standardKb, presets: presetOptions });
    return Object.fromEntries(issues.map((issue) => [issue.field, issue.message]));
  }, [standardKb, presetOptions]);
  const draftErrors = useMemo(
    () => (draft?.saveError ? extractConfigFieldErrors(draft.saveError) : {}),
    [draft?.saveError],
  );
  const fieldErrors = { ...draftErrors, ...localFieldErrors, ...validationErrors };
  const errorFor = (...fields: string[]): string | null => {
    for (const field of fields) {
      if (fieldErrors[field]) return fieldErrors[field];
    }
    return null;
  };

  const roleError = (roleKey: 'writer' | 'reviewer' | 'integrator'): string | null => errorFor(
    `standardKb.buildRoles.${roleKey}.modelPresetId`,
    `standardKb.buildRoles.${roleKey}.providerId`,
    `standardKb.buildRoles.${roleKey}.thinking`,
    `standardKb.buildRoles.${roleKey}`,
    'standardKb.buildRoles',
  );

  // ---- 保存：即时暂存（草稿内只进草稿；草稿外直接 PUT，错误映射到表单项） ----
  const saveKb = async (mutate: (base: StandardKbConfig) => StandardKbConfig) => {
    const base = standardKb ?? FALLBACK_STANDARD_KB;
    const next = mutate({
      ...base,
      buildRoles: base.buildRoles ? { ...base.buildRoles } : undefined,
      reviewPolicy: base.reviewPolicy ? { ...base.reviewPolicy } : undefined,
    });
    const issues = validateBuildOrchestrationInput({ standardKb: next, presets: presetOptions });
    if (issues.length > 0) {
      setLocalFieldErrors(Object.fromEntries(issues.map((issue) => [issue.field, issue.message])));
      toast.push({ type: 'error', message: `构建编排：${issues[0].message}` });
      return;
    }
    setLocalFieldErrors({});
    try {
      await updateConfig({ standardKb: next });
      if (!draft) toast.push({ type: 'success', message: '构建编排设置已保存' });
    } catch (err) {
      const mapped = extractConfigFieldErrors(err);
      if (Object.keys(mapped).length > 0) setLocalFieldErrors(mapped);
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '保存失败' });
    }
  };

  const presetByKey = (key: string): BuildPresetOption | undefined => presetOptions.find((option) => option.key === key);

  /** 换角色模型预设：'' = 跟随（integrator 省略键=跟随撰写）；选具体预设时
   *  保留原 thinking（新预设不支持则丢弃），providerId 记录用于跨 provider 定位。 */
  const setRolePreset = (roleKey: 'writer' | 'reviewer' | 'integrator', key: string) => {
    void saveKb((base) => {
      const roles: KbBuildRolesConfig = {
        ...(base.buildRoles ?? { writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' }, plannerEnabled: false }),
      };
      if (roleKey === 'integrator') {
        if (!key) {
          delete roles.integrator; // 整体替换语义下省略键 = 移除「整合单独覆盖」
        } else {
          const option = presetByKey(key)!;
          const prev = roles.integrator;
          const levels = thinkingLevelsForPreset(option);
          roles.integrator = {
            modelPresetId: option.presetId,
            providerId: option.providerId,
            ...(prev?.thinking && levels.includes(prev.thinking) ? { thinking: prev.thinking } : {}),
          };
        }
        return { ...base, buildRoles: roles };
      }
      const option = key ? presetByKey(key)! : null;
      const levels = thinkingLevelsForPreset(option);
      const prevThinking = roles[roleKey]?.thinking;
      roles[roleKey] = option
        ? {
          modelPresetId: option.presetId,
          providerId: option.providerId,
          ...(prevThinking && levels.includes(prevThinking) ? { thinking: prevThinking } : {}),
        }
        : { modelPresetId: '', ...(prevThinking ? { thinking: prevThinking } : {}) };
      return { ...base, buildRoles: roles };
    });
  };

  const setRoleThinking = (roleKey: 'writer' | 'reviewer' | 'integrator', level: AgentThinkingLevel) => {
    void saveKb((base) => {
      const roles: KbBuildRolesConfig = {
        ...(base.buildRoles ?? { writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' }, plannerEnabled: false }),
      };
      // 'off' 是服务端缺省：不写 thinking 键（undefined 不落盘）。
      const nextThinking = level === 'off' ? undefined : level;
      const withThinking = (role: KbBuildRoleConfig): KbBuildRoleConfig => {
        const merged: KbBuildRoleConfig = { ...role, ...(nextThinking ? { thinking: nextThinking } : {}) };
        if (!nextThinking) delete merged.thinking;
        return merged;
      };
      if (roleKey === 'integrator') {
        if (roles.integrator) roles.integrator = withThinking(roles.integrator);
      } else {
        roles[roleKey] = withThinking(roles[roleKey] ?? { modelPresetId: '' });
      }
      return { ...base, buildRoles: roles };
    });
  };

  // ---- 构建并发（B案 §6：1..8；未显式设置回落构建并行数） ----
  const buildParallelism = standardKb?.buildParallelism ?? 2;
  const explicitConcurrency = standardKb?.buildConcurrency;
  const concurrencyExplicit = typeof explicitConcurrency === 'number';
  const concurrencyDisplay = concurrencyExplicit ? explicitConcurrency : resolveBuildConcurrencyClient(standardKb);
  const concurrencyOutOfRange = concurrencyExplicit
    && (!Number.isInteger(explicitConcurrency) || explicitConcurrency < 1 || explicitConcurrency > 8);

  // ---- 审查策略（B案 §5：缺省 2/2） ----
  const maxAutoRevisions = standardKb?.reviewPolicy?.maxAutoRevisions ?? 2;
  const maxInterfaceRetries = standardKb?.reviewPolicy?.maxInterfaceRetries ?? 2;

  // ---- 发布方式（B案 §7：缺省 auto） ----
  const publishMode = standardKb?.publishMode ?? 'auto';

  return (
    <section className="rounded-md border border-line bg-card-bg shadow-sm overflow-hidden" aria-label="构建编排">
      <header className="px-4 py-3 border-b border-line/60 flex items-start gap-3">
        <div className="mt-0.5 text-ink-faint"><Workflow className="w-4 h-4" /></div>
        <div className="min-w-0">
          <h3 className="text-sm font-kai font-medium text-ink">构建编排</h3>
          <p className="mt-0.5 text-xs text-ink-faint leading-snug">
            标准库构建的角色模型、构建并发、审查闭环预算与发布方式；修改后随设置页顶部保存生效
          </p>
        </div>
      </header>
      <div className="p-4 space-y-4">
        {/* 角色模型（B案 §3/§8） */}
        <div className="space-y-3">
          <RoleModelRow
            roleKey="writer"
            label="撰写模型"
            followLabel={`跟随活跃预设（当前：${activeLabel}）`}
            role={buildRoles?.writer}
            option={findRolePreset(buildRoles?.writer, presetOptions)}
            fallbackOption={activePresetOption}
            options={presetOptions}
            error={roleError('writer')}
            onPresetChange={(key) => setRolePreset('writer', key)}
            onThinkingChange={(level) => setRoleThinking('writer', level)}
          />
          <RoleModelRow
            roleKey="reviewer"
            label="审查模型"
            followLabel={`跟随活跃预设（启用编排流水；当前：${activeLabel}）`}
            role={buildRoles?.reviewer}
            option={findRolePreset(buildRoles?.reviewer, presetOptions)}
            fallbackOption={activePresetOption}
            options={presetOptions}
            error={roleError('reviewer')}
            onPresetChange={(key) => setRolePreset('reviewer', key)}
            onThinkingChange={(level) => setRoleThinking('reviewer', level)}
          />
          <RoleModelRow
            roleKey="integrator"
            label="整合模型"
            followLabel="跟随撰写模型（不单独设置）"
            role={buildRoles?.integrator}
            option={findRolePreset(buildRoles?.integrator, presetOptions)}
            fallbackOption={findRolePreset(buildRoles?.writer, presetOptions) ?? activePresetOption}
            options={presetOptions}
            error={roleError('integrator')}
            onPresetChange={(key) => setRolePreset('integrator', key)}
            onThinkingChange={(level) => setRoleThinking('integrator', level)}
          />
          {presetOptions.length === 0 ? (
            <p className="text-xs text-ink-faint">尚无可用模型预设，请先在「服务提供商与模型」中配置端点、API Key 并启用模型。</p>
          ) : null}
        </div>

        {/* 构建并发（B案 §6） */}
        <div>
          <FieldLabel hint="1..8">构建并发</FieldLabel>
          <select
            className={INPUT_CLS}
            value={String(concurrencyDisplay)}
            aria-label="构建并发"
            data-testid="orch-concurrency-select"
            onChange={(e) => void saveKb((base) => ({ ...base, buildConcurrency: Number(e.target.value) }))}
          >
            {concurrencyOutOfRange ? (
              <option value={String(concurrencyDisplay)} disabled>当前值 {String(concurrencyDisplay)} 越界，请重新选择</option>
            ) : null}
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>{n} 路{n === 1 ? '（单进程等价回退）' : ''}</option>
            ))}
          </select>
          {errorFor('standardKb.buildConcurrency') ? (
            <p className="mt-1 text-[11px] text-seal-2 leading-snug" role="alert" data-testid="orch-concurrency-error">
              {errorFor('standardKb.buildConcurrency')}
            </p>
          ) : null}
          <p className="mt-1 text-[11px] text-ink-faint leading-relaxed" data-testid="orch-concurrency-hint">
            同时运行的文本构建任务总数，撰写/审查/修订合计计入；交互会话名额另计，不占此配额。
            {!concurrencyExplicit
              ? `未显式设置时按「构建并行数」${buildParallelism} 生效（当前生效 ${resolveBuildConcurrencyClient(standardKb)} 路）；`
              : '已显式设置，优先于「构建并行数」；'}
            设置后保存在下一次构建生效。
          </p>
        </div>

        {/* 审查策略（B案 §5） */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <FieldLabel hint="1..5，默认 2">自动修订轮数上限</FieldLabel>
            <select
              className={INPUT_CLS}
              value={String(maxAutoRevisions)}
              aria-label="自动修订轮数上限"
              data-testid="orch-revisions-select"
              onChange={(e) => void saveKb((base) => ({
                ...base,
                reviewPolicy: { ...(base.reviewPolicy ?? { maxAutoRevisions: 2, maxInterfaceRetries: 2 }), maxAutoRevisions: Number(e.target.value) },
              }))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n} 轮{n === 2 ? '（默认）' : ''}</option>
              ))}
            </select>
            {errorFor('standardKb.reviewPolicy.maxAutoRevisions') ? (
              <p className="mt-1 text-[11px] text-seal-2 leading-snug" role="alert">{errorFor('standardKb.reviewPolicy.maxAutoRevisions')}</p>
            ) : null}
            <p className="mt-1 text-[11px] text-ink-faint leading-snug">每个审查对象最多自动修订轮数；同一对象换稿不重置预算。</p>
          </div>
          <div>
            <FieldLabel hint="0..5，默认 2">接口重试上限</FieldLabel>
            <select
              className={INPUT_CLS}
              value={String(maxInterfaceRetries)}
              aria-label="接口重试上限"
              data-testid="orch-retries-select"
              onChange={(e) => void saveKb((base) => ({
                ...base,
                reviewPolicy: { ...(base.reviewPolicy ?? { maxAutoRevisions: 2, maxInterfaceRetries: 2 }), maxInterfaceRetries: Number(e.target.value) },
              }))}
            >
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n} 次{n === 2 ? '（默认）' : ''}</option>
              ))}
            </select>
            {errorFor('standardKb.reviewPolicy.maxInterfaceRetries') ? (
              <p className="mt-1 text-[11px] text-seal-2 leading-snug" role="alert">{errorFor('standardKb.reviewPolicy.maxInterfaceRetries')}</p>
            ) : null}
            <p className="mt-1 text-[11px] text-ink-faint leading-snug">模型接口失败的重试次数；与内容修订分开计数。</p>
          </div>
        </div>

        {/* 发布方式（B案 §7） */}
        <div>
          <FieldLabel>发布方式</FieldLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className={`flex items-start gap-2 px-3 py-2 rounded-md border cursor-pointer text-xs ${publishMode === 'auto' ? 'border-seal/50 bg-[rgba(158,43,37,0.05)]' : 'border-line hover:bg-paper'}`}>
              <input
                type="radio"
                name="kb-publish-mode"
                className="mt-0.5 accent-[#9e2b25]"
                checked={publishMode === 'auto'}
                aria-label="发布方式自动发布"
                data-testid="orch-publish-auto"
                onChange={() => { if (publishMode !== 'auto') void saveKb((base) => ({ ...base, publishMode: 'auto' as const })); }}
              />
              <span>
                <span className="block font-medium text-ink">自动发布</span>
                <span className="block mt-0.5 text-[11px] text-ink-faint leading-snug">全部审查通过并满足发布条件后，自动生成不可变版本并原子切换。</span>
              </span>
            </label>
            <label className={`flex items-start gap-2 px-3 py-2 rounded-md border cursor-pointer text-xs ${publishMode === 'confirm' ? 'border-seal/50 bg-[rgba(158,43,37,0.05)]' : 'border-line hover:bg-paper'}`}>
              <input
                type="radio"
                name="kb-publish-mode"
                className="mt-0.5 accent-[#9e2b25]"
                checked={publishMode === 'confirm'}
                aria-label="发布方式构建后待确认"
                data-testid="orch-publish-confirm"
                onChange={() => { if (publishMode !== 'confirm') void saveKb((base) => ({ ...base, publishMode: 'confirm' as const })); }}
              />
              <span>
                <span className="block font-medium text-ink">构建后待确认</span>
                <span className="block mt-0.5 text-[11px] text-ink-faint leading-snug">最终候选版本就绪后暂停，人工确认一次才发布；确认绑定该候选版本。</span>
              </span>
            </label>
          </div>
          {errorFor('standardKb.publishMode') ? (
            <p className="mt-1 text-[11px] text-seal-2 leading-snug" role="alert">{errorFor('standardKb.publishMode')}</p>
          ) : null}
        </div>

        {/* 缺省行为说明（未配置字段不落盘，后端按缺省执行） */}
        <div className="rounded-md border border-line bg-paper/30 p-3 text-[11px] text-ink-faint leading-relaxed" data-testid="orch-defaults-note">
          未显式设置时的后端缺省行为：角色模型跟随「运行时与模型」的活跃预设（当前：{activeLabel}），整合跟随撰写；
          审查预算 2/2；发布方式为自动发布；构建并发回落「构建并行数」（当前 {buildParallelism}）。
          未改动的字段不会写入配置。
        </div>
      </div>
    </section>
  );
}
