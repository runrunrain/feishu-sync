/**
 * ConfigManager - Manages application configuration
 *
 * Follows the revised config schema from 飞书认证架构专项设计:
 * - REMOVED: app_id, app_secret, feishuAuthRef, feishuSpaceId
 * - REMOVED (2026-10): larkCliPath — 不再是可配置项。历史上该字段一旦被
 *   填入错误路径便无法通过 UI 清空（undefined 在 JSON 序列化时丢键、
 *   updateConfig 浅合并保留旧值），且错误路径会让 discovery 永远解析失败。
 *   现在加载时主动剔除磁盘上的存量 larkCliPath 并写回清理后的文件；
 *   lark-cli 解析只走 PATH + 桌面发现目录（lark-cli-client.ts），环境变量
 *   LARK_CLI_PATH 仍可作为部署级逃生口。
 * - ADDED: requiredScopes
 *
 * v0.2.0 P3: LLM config migrated to channel-agnostic shape
 * (LlmConfig). Both channels (ClaudeCliChannel + DirectChannel) share
 * ONE provider config (default: bigmodel GLM). Legacy flat
 * `{ baseUrl, apiKey, model, temperature }` is auto-migrated on first
 * load. Sensible bigmodel defaults are derived from the local
 * ANTHROPIC_* env vars when present (open-box-usable on a machine that
 * already runs claude CLI), or fall back to bigmodel's public docs.
 *
 * Storage: ~/.feishu-sync/config.json (or userData path in desktop mode)
 *
 * SECURITY (decision 3 / B3 plan B): the bigmodel apiKey is stored in
 * PLAINTEXT. A prominent warning is written to the top of config.json
 * (as a JSON comment-style `_warning` field) to remind users not to
 * commit the file to a public repo. Encryption (keytar) is deferred to
 * a later iteration per architecture decision §5.4.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataRoot } from './data-root.js';
import { validateWorkspacesAgainstConfig } from '../agent/protected-roots.js';
import {
  buildDefaultAgentConfig,
  buildDefaultStandardKbConfig,
  buildDefaultAgentVisionConfig,
  VISION_MAX_IMAGE_BYTES_CEILING,
  buildDefaultAgentOrchestrationConfig,
  type AgentConfig,
  type AgentOrchestrationConfig,
  type AgentVisionConfig,
  type AgentWorkspaceConfig,
  type StandardKbConfig,
} from '../types/agent-knowledge.js';
import type { LlmProtocol } from '../types/index.js';
import type {
  CliConfig,
  Config,
  FeishuPublishConfig,
  FeishuWriteConfig,
  LayoutProfile,
  LegacyLLMConfig,
  LlmConfig,
  LlmModelPreset,
  LlmProviderConfig,
  SyncConfig,
  WatchedRootConfig,
} from '../types/index.js';
import { getEnabledWatchedRootUrls, isLegacyLlmConfig } from '../types/index.js';

const DEFAULT_CONFIG_PATH = path.join(resolveDataRoot(), 'config.json');
/**
 * Minimal user scopes for read-only wiki sync (must match lark-cli auth login).
 * Exported so LarkCliManager's device-flow scope assembly shares the same
 * default source instead of drifting into a third copy of the list.
 *
 * 2026-10 移除 docs:document:read：实测（lark-cli 1.0.93，OAuth 应用
 * cli_aab83ada483cdcc0 启用清单 198 项中无此名）带上它发起 device flow
 * 会被整单拒绝：「The provided scope list contains invalid or malformed
 * scopes」。该名是 2026-09 曾短暂可用的交替名，上游已失效；旧名
 * docx:document:readonly 始终有效，checkAuthReady 的别名等价表兼底。
 */
export const DEFAULT_REQUIRED_SCOPES = [
  'wiki:node:retrieve',
  'wiki:space:retrieve',
  'docs:document.content:read',
  'sheets:spreadsheet:read',
  'docx:document:readonly',
  'drive:drive.metadata:readonly',
  'docs:document.media:download',
  'slides:presentation:read',
  'offline_access',
];

/**
 * 已在上游失效的 scope 名：出现在 `auth login --scope` 请求集里会让整单
 * device authorization 被拒（2026-10 实测 docs:document:read）。加载迁移
 * 从存量配置剔除，device flow 发起前再兑底过滤一次（防手改配置回灌）。
 */
export const RETIRED_REQUEST_SCOPES: readonly string[] = ['docs:document:read'];

/**
 * 计算知识库根目录的缺省建议值（2026-10 首次配置引导）。
 *
 * 规则（用户拍板）：Windows 且 D 盘存在 → `D:\飞书知识库`（国内同事机
 * 器惯例，数据盘独立于系统盘）；无 D 盘 → `C:\飞书知识库`；macOS /
 * Linux → `~/Documents/飞书知识库`。
 *
 * 仅计算不创建：预览端点直接返回；采用端点（adopt）才 mkdir + 落盘
 * 保存，避免「看一眼建议」就往用户磁盘写目录。
 */
export function suggestKnowledgeRoot(
  options: { platform?: NodeJS.Platform; homeDir?: string; exists?: (p: string) => boolean } = {},
): string {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const exists = options.exists ?? ((p: string) => fs.existsSync(p));
  // 平台感知 join：注入 win32 语义时必须用 win32 分隔符（否则在
  // macOS 宿主上测试/调用会得到 `C:\Users\x/Documents/…` 的混合分隔符）。
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32' && exists('D:\\')) {
    return 'D:\\飞书知识库';
  }
  if (platform === 'win32') return 'C:\\飞书知识库';
  return join(homeDir, 'Documents', '飞书知识库');
}

/**
 * 飞书 scope 新旧名等价组：授权端可能只授予其中一个名字。比对
 * requiredScopes 时组内任一命中即视为满足，避免新名/旧名交替期的误报
 * 「缺少权限」阻断认证。docs:document:read 已于 2026-10 从默认需求集
 * 退役，该组保留作为兑底：手改配置或未来上游回摆时仍不误报。
 */
export const SCOPE_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ['docx:document:readonly', 'docs:document:read'],
];

/**
 * Default bigmodel endpoints (decision 3 cognitive correction):
 *   - OpenAI-protocol: https://open.bigmodel.cn/api/paas/v4
 *   - Anthropic-protocol: https://open.bigmodel.cn/api/anthropic
 *
 * Default model is `glm-4-flash` (free tier) for the OpenAI-compat
 * endpoint; the Anthropic-compat endpoint accepts it too via claude
 * CLI's tier alias mapping (the env overrides set by ClaudeCliChannel
 * pin all tiers to LlmConfig.model).
 */
const DEFAULT_OPENAI_COMPAT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
/**
 * 默认模型别名（bigmodel paas/v4 免费档）。
 * v0.2.9 起 claude-cli / opencode 通道移除，仅剩 direct 通道，单一默认。
 */
const DEFAULT_DIRECT_MODEL = 'glm-4-flash';
/**
 * Per-call LLM adaptation timeout, in milliseconds.
 *
 * 10 minutes gives bigmodel glm-4.7 (the Anthropic-compat model
 * used by the claude-cli primary channel) enough headroom to finish
 * under transient 529 over-load retries without making the user wait
 * unbounded. The previous hard-coded 60s value aborted the primary
 * channel too aggressively and forced a fall-back to DirectChannel.
 */
const DEFAULT_LLM_TIMEOUT_MS = 600_000;

/**
 * Set of known non-bigmodel OpenAI-compat base URLs whose providers do
 * NOT accept a bigmodel apiKey. When the persisted config still points
 * at one of these (a known P3 migration side-effect: legacy deepseek
 * `baseUrl` was carried over as `openAiCompatBaseUrl`) but the apiKey
 * has since been replaced with a bigmodel `<id>.<secret>` key, the
 * bigmodel paas/v4 endpoint MUST be substituted — otherwise DirectChannel
 * sends a bigmodel Bearer key to deepseek and gets 401.
 *
 * This list is intentionally narrow (exact host match on the known
 * legacy providers). Custom OpenAI-compat gateways are left untouched.
 */
const KNOWN_NON_BIGMODEL_OPENAI_HOSTS = new Set<string>([
  'api.deepseek.com',
  'api.openai.com',
]);

/**
 * Detect a bigmodel (zhipu) API key by its `<id>.<secret>` shape.
 *
 * Both segments are base62-ish (alphanumeric, no `sk-` prefix, no
 * underscores). bigmodel does not contract a stable segment length, so
 * the regex is intentionally permissive but anchored — the id segment
 * matches `[A-Za-z0-9]{6,64}` and the secret segment matches
 * `[A-Za-z0-9]{6,80}`. This keeps the detector from breaking on minor
 * future format tweaks while still rejecting OpenAI/Anthropic keys
 * (which typically start with `sk-` / `sk-ant-` and contain dashes).
 *
 * Reference: https://open.bigmodel.cn/dev/api#nosdk
 *
 * Exported for unit tests (config-manager.test.ts).
 */
export function looksLikeBigmodelKey(apiKey: string | undefined | null): boolean {
  if (!apiKey || typeof apiKey !== 'string') return false;
  // bigmodel keys are `<id>.<secret>` where both halves are alphanumeric
  // (no `sk-` prefix, no underscores); id matches {6,64}, secret {6,80}.
  return /^[A-Za-z0-9]{6,64}\.[A-Za-z0-9]{6,80}$/.test(apiKey);
}

/**
 * Returns true when host(u) is one of the known non-bigmodel OpenAI-compat
 * hosts (deepseek / openai.com) that must be replaced when paired with a
 * bigmodel apiKey. Unknown custom gateways are left as-is.
 */
function isKnownNonBigmodelOpenAiHost(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const host = new URL(url).host.toLowerCase();
    return KNOWN_NON_BIGMODEL_OPENAI_HOSTS.has(host);
  } catch {
    return false;
  }
}

/**
 * Normalize the OpenAI-compat base URL for DirectChannel when the apiKey
 * is a bigmodel key but the URL still points at a non-bigmodel host
 * (deepseek / openai.com). This is the root-cause fix for the direct
 * channel 401 reported in the 2026-06-19 e2e-sync report: P3 migration
 * preserved the legacy deepseek `baseUrl` as `openAiCompatBaseUrl`, but
 * the persisted `apiKey` had already been swapped to a bigmodel key.
 *
 * Behavior:
 *   - bigmodel key + non-bigmodel host -> DEFAULT_OPENAI_COMPAT_BASE_URL
 *   - bigmodel key + (already) bigmodel host -> unchanged
 *   - non-bigmodel key -> unchanged (respect user's custom gateway)
 *
 * Exported for unit tests (config-manager.test.ts).
 */
export function reconcileOpenAiCompatBaseUrl(
  url: string | undefined | null,
  apiKey: string | undefined | null,
): string {
  if (looksLikeBigmodelKey(apiKey) && isKnownNonBigmodelOpenAiHost(url)) {
    return DEFAULT_OPENAI_COMPAT_BASE_URL;
  }
  return url || DEFAULT_OPENAI_COMPAT_BASE_URL;
}

/**
 * bigmodel keys do NOT support `deepseek-chat` / `deepseek-reasoner` /
 * generic OpenAI aliases on paas/v4. When the persisted `model` field
 * still carries a deepseek alias but the apiKey is bigmodel, reset it
 * to the Anthropic-adapter alias (the primary-channel default).
 *
 * Exported for unit tests (config-manager.test.ts).
 */
export function reconcileModelAlias(
  model: string | undefined | null,
  apiKey: string | undefined | null,
): string {
  const canonicalModel = canonicalizeGlmModelAlias(model);
  if (!canonicalModel) return DEFAULT_DIRECT_MODEL;
  const deepseekAliases = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'];
  if (
    looksLikeBigmodelKey(apiKey) &&
    deepseekAliases.includes(canonicalModel.toLowerCase())
  ) {
    return DEFAULT_DIRECT_MODEL;
  }
  return canonicalModel;
}

// ===========================================================================
// Agent 标准知识库配置段（F1，additive）：默认合并 + 严格校验
// ===========================================================================

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_SOURCES = new Set(['app-llm', 'pi-agent-dir']);
const WORKSPACE_ID_PATTERN = /^ws_[A-Za-z0-9]{6,32}$/;

/** pi的provider可含中文/空格，model id也可含路径；由RPC列表提供精确标识。 */
function isValidPiModel(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return false;
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  return provider.trim() === provider && model.trim() === model
    && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export class InvalidConfigError extends Error {
  details: Array<{ field: string; code: string }>;
  constructor(details: Array<{ field: string; code: string }>) {
    super(`配置校验失败：${details.map((item) => `${item.field}(${item.code})`).join(', ')}`);
    this.details = details;
  }
}

/** 宽容归一：旧配置缺段/缺字段 → 补默认；非法值 → 回退默认并保留结构。 */
function normalizeAgentConfigLoose(value: unknown, dataRoot: string): AgentConfig {
  const base = buildDefaultAgentConfig(dataRoot);
  if (!value || typeof value !== 'object') return base;
  const raw = value as Partial<AgentConfig>;
  const modelRaw: Partial<AgentConfig['model']> = raw.model && typeof raw.model === 'object' ? raw.model : {};
  const runtimeRaw: Partial<AgentConfig['runtime']> = raw.runtime && typeof raw.runtime === 'object' ? raw.runtime : {};
  return {
    runtime: {
      backend: runtimeRaw.backend === 'pi' ? 'pi' : 'claude-code',
      nodePath: typeof runtimeRaw.nodePath === 'string' && runtimeRaw.nodePath.trim() ? runtimeRaw.nodePath.trim() : undefined,
      piCliPath: typeof runtimeRaw.piCliPath === 'string' && runtimeRaw.piCliPath.trim() ? runtimeRaw.piCliPath.trim() : undefined,
      claudeCliPath: typeof runtimeRaw.claudeCliPath === 'string' && runtimeRaw.claudeCliPath.trim() ? runtimeRaw.claudeCliPath.trim() : undefined,
    },
    model: {
      source: MODEL_SOURCES.has(modelRaw.source as string) ? (modelRaw.source as AgentConfig['model']['source']) : 'app-llm',
      providerId: typeof modelRaw.providerId === 'string' && modelRaw.providerId ? modelRaw.providerId : undefined,
      modelId: typeof modelRaw.modelId === 'string' && modelRaw.modelId ? modelRaw.modelId : undefined,
      piModel: typeof modelRaw.piModel === 'string' && modelRaw.piModel.trim() ? modelRaw.piModel.trim() : undefined,
      piThinkingLevels: modelRaw.piThinkingLevels && typeof modelRaw.piThinkingLevels === 'object' && !Array.isArray(modelRaw.piThinkingLevels)
        ? Object.fromEntries(Object.entries(modelRaw.piThinkingLevels).filter(([, levels]) => Array.isArray(levels)).map(([id, levels]) => [id, levels.filter((level) => THINKING_LEVELS.has(level))])) : undefined,
      thinkingLevel: THINKING_LEVELS.has(modelRaw.thinkingLevel as string)
        ? (modelRaw.thinkingLevel as AgentConfig['model']['thinkingLevel'])
        : 'off',
      contextWindow: typeof modelRaw.contextWindow === 'number' && modelRaw.contextWindow >= 1000 ? Math.floor(modelRaw.contextWindow) : base.model.contextWindow,
      maxTokens: typeof modelRaw.maxTokens === 'number' && modelRaw.maxTokens >= 256 ? Math.floor(modelRaw.maxTokens) : base.model.maxTokens,
    },
    vision: normalizeVisionConfigLoose(raw.vision),
    orchestration: normalizeOrchestrationConfigLoose(raw.orchestration),
    maxConcurrentProcesses: typeof raw.maxConcurrentProcesses === 'number'
      ? Math.max(1, Math.min(6, Math.floor(raw.maxConcurrentProcesses)))
      : base.maxConcurrentProcesses,
    idleTimeoutMinutes: typeof raw.idleTimeoutMinutes === 'number'
      ? Math.max(1, Math.min(240, Math.floor(raw.idleTimeoutMinutes)))
      : base.idleTimeoutMinutes,
    workspaces: Array.isArray(raw.workspaces) ? raw.workspaces.filter(isValidWorkspaceEntry) : [],
  };
}

/** 宽容归一：vision 段缺字段补默认；非法值回退默认（load 与 updateConfig 共用）。S2 设计 §3.1。 */
function normalizeVisionConfigLoose(value: unknown): AgentVisionConfig {
  const base = buildDefaultAgentVisionConfig();
  if (!value || typeof value !== 'object') return base;
  const raw = value as Partial<AgentVisionConfig>;
  const int = (candidate: unknown, fallback: number, min: number, max: number): number =>
    typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.max(min, Math.min(max, Math.floor(candidate)))
      : fallback;
  return {
    enabled: raw.enabled === true,
    providerId: typeof raw.providerId === 'string' && raw.providerId.trim() ? raw.providerId.trim() : undefined,
    modelId: typeof raw.modelId === 'string' && raw.modelId.trim() ? raw.modelId.trim() : undefined,
    concurrency: int(raw.concurrency, base.concurrency, 1, 8),
    maxImageBytes: int(raw.maxImageBytes, base.maxImageBytes, 1024, VISION_MAX_IMAGE_BYTES_CEILING),
    maxImagesPerBuild: int(raw.maxImagesPerBuild, base.maxImagesPerBuild, 0, 5000),
    timeoutMs: int(raw.timeoutMs, base.timeoutMs, 5_000, 600_000),
  };
}

/** 宽容归一：S6 任务编排参数（设计 kb-agent-upgrade §5.2/§5.3）；开关本身在内置插件条目上，不在此段。 */
function normalizeOrchestrationConfigLoose(value: unknown): AgentOrchestrationConfig {
  const base = buildDefaultAgentOrchestrationConfig();
  if (!value || typeof value !== 'object') return base;
  const raw = value as Partial<AgentOrchestrationConfig>;
  const int = (candidate: unknown, fallback: number, min: number, max: number): number =>
    typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.max(min, Math.min(max, Math.floor(candidate)))
      : fallback;
  return {
    maxActiveTasksPerSession: int(raw.maxActiveTasksPerSession, base.maxActiveTasksPerSession, 1, 5),
    taskTimeoutMinutes: int(raw.taskTimeoutMinutes, base.taskTimeoutMinutes, 1, 1440),
  };
}

function isValidWorkspaceEntry(value: unknown): value is AgentWorkspaceConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AgentWorkspaceConfig>;
  return (
    typeof candidate.id === 'string' && WORKSPACE_ID_PATTERN.test(candidate.id)
    && typeof candidate.name === 'string' && candidate.name.trim().length > 0 && candidate.name.length <= 80
    && typeof candidate.path === 'string' && candidate.path.length > 0 && path.isAbsolute(candidate.path)
    && typeof candidate.createdAt === 'string'
  );
}

function normalizeStandardKbConfigLoose(value: unknown, dataRoot: string): StandardKbConfig {
  const base = buildDefaultStandardKbConfig(dataRoot);
  if (!value || typeof value !== 'object') return base;
  const raw = value as Partial<StandardKbConfig>;
  return {
    outputRoot: typeof raw.outputRoot === 'string' && raw.outputRoot.trim() ? raw.outputRoot.trim() : base.outputRoot,
    retainReleases: typeof raw.retainReleases === 'number'
      ? Math.max(1, Math.min(20, Math.floor(raw.retainReleases)))
      : base.retainReleases,
    buildBatchSize: typeof raw.buildBatchSize === 'number'
      ? Math.max(1, Math.min(50, Math.floor(raw.buildBatchSize)))
      : base.buildBatchSize,
    // P2-S2（§2.5）：每批有效字数预算 0 或 4000..400000；越界钳制到边界，
    // 非数字回落缺省 40000（0 = 旧行为按源数分批，兼容回退开关）
    buildBatchWordBudget: normalizeBuildBatchWordBudget(
      raw.buildBatchWordBudget,
      base.buildBatchWordBudget,
    ),
    // S4（设计 §4.6）：并行构建 worker 数 1..6；旧配置缺省回落默认值
    buildParallelism: typeof raw.buildParallelism === 'number'
      ? Math.max(1, Math.min(6, Math.floor(raw.buildParallelism)))
      : base.buildParallelism,
    promptTimeoutMinutes: typeof raw.promptTimeoutMinutes === 'number'
      ? Math.max(1, Math.min(240, Math.floor(raw.promptTimeoutMinutes)))
      : base.promptTimeoutMinutes,
    buildTimeoutMinutes: typeof raw.buildTimeoutMinutes === 'number'
      ? Math.max(5, Math.min(1440, Math.floor(raw.buildTimeoutMinutes)))
      : base.buildTimeoutMinutes,
    autoBuildAfterSync: raw.autoBuildAfterSync === true ? true : false,
  };
}

/**
 * P2-S2（§2.5）：buildBatchWordBudget 宽容归一——取整后钳制到
 * {0} ∪ [4000, 400000]；非数字/非有限数回落缺省（40000）。
 */
function normalizeBuildBatchWordBudget(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const budget = Math.floor(value);
  if (budget <= 0) return 0;
  return Math.min(400_000, Math.max(4_000, budget));
}

/** 严格校验（PUT /api/config 路径）：非法直接报 InvalidConfigError。 */
export function validateAgentAndKbConfig(value: {
  agent?: unknown;
  standardKb?: unknown;
}): void {
  const details: Array<{ field: string; code: string }> = [];
  if (value.agent !== undefined && (!value.agent || typeof value.agent !== 'object')) {
    details.push({ field: 'agent', code: 'invalid_type' });
  } else if (value.agent && typeof value.agent === 'object') {
    const agent = value.agent as Partial<AgentConfig>;
    if (agent.runtime?.backend !== undefined && !['pi', 'claude-code'].includes(agent.runtime.backend)) {
      details.push({ field: 'agent.runtime.backend', code: 'invalid_value' });
    }
    if (agent.model && typeof agent.model === 'object') {
      const model = agent.model as Partial<AgentConfig['model']>;
      if (model.source !== undefined && !MODEL_SOURCES.has(model.source as string)) {
        details.push({ field: 'agent.model.source', code: 'invalid_value' });
      }
      if (model.source === 'pi-agent-dir' && model.piModel !== undefined
        && !isValidPiModel(model.piModel)) {
        details.push({ field: 'agent.model.piModel', code: 'invalid_format' });
      }
      if (model.thinkingLevel !== undefined && !THINKING_LEVELS.has(model.thinkingLevel as string)) {
        details.push({ field: 'agent.model.thinkingLevel', code: 'invalid_value' });
      }
    }
    if (agent.maxConcurrentProcesses !== undefined
      && (typeof agent.maxConcurrentProcesses !== 'number'
        || agent.maxConcurrentProcesses < 1 || agent.maxConcurrentProcesses > 6)) {
      details.push({ field: 'agent.maxConcurrentProcesses', code: 'out_of_range' });
    }
    // S2 vision 段结构校验（引用存在性由 validateVisionProviderReference 交叉校验）
    if (agent.vision !== undefined && (!agent.vision || typeof agent.vision !== 'object')) {
      details.push({ field: 'agent.vision', code: 'invalid_type' });
    } else if (agent.vision && typeof agent.vision === 'object') {
      const vision = agent.vision as Partial<AgentVisionConfig>;
      if (vision.enabled !== undefined && typeof vision.enabled !== 'boolean') {
        details.push({ field: 'agent.vision.enabled', code: 'invalid_type' });
      }
      if (vision.providerId !== undefined && typeof vision.providerId !== 'string') {
        details.push({ field: 'agent.vision.providerId', code: 'invalid_type' });
      }
      if (vision.modelId !== undefined && typeof vision.modelId !== 'string') {
        details.push({ field: 'agent.vision.modelId', code: 'invalid_type' });
      }
      if (vision.concurrency !== undefined
        && (typeof vision.concurrency !== 'number' || vision.concurrency < 1 || vision.concurrency > 8)) {
        details.push({ field: 'agent.vision.concurrency', code: 'out_of_range' });
      }
      if (vision.maxImageBytes !== undefined
        && (typeof vision.maxImageBytes !== 'number'
          || vision.maxImageBytes < 1024 || vision.maxImageBytes > VISION_MAX_IMAGE_BYTES_CEILING)) {
        details.push({ field: 'agent.vision.maxImageBytes', code: 'out_of_range' });
      }
      if (vision.maxImagesPerBuild !== undefined
        && (typeof vision.maxImagesPerBuild !== 'number'
          || vision.maxImagesPerBuild < 0 || vision.maxImagesPerBuild > 5000)) {
        details.push({ field: 'agent.vision.maxImagesPerBuild', code: 'out_of_range' });
      }
      if (vision.timeoutMs !== undefined
        && (typeof vision.timeoutMs !== 'number' || vision.timeoutMs < 5000 || vision.timeoutMs > 600000)) {
        details.push({ field: 'agent.vision.timeoutMs', code: 'out_of_range' });
      }
    }
    // agent.workspaces：不校验也不报错——updateConfig 静默忽略该字段
    //（增删只走专用路由，见 updateConfig 的合并逻辑）。
    // S6：任务编排参数（严格路径；宽容归一在 normalizeOrchestrationConfigLoose）
    if (agent.orchestration !== undefined && (!agent.orchestration || typeof agent.orchestration !== 'object')) {
      details.push({ field: 'agent.orchestration', code: 'invalid_type' });
    } else if (agent.orchestration && typeof agent.orchestration === 'object') {
      const orchestration = agent.orchestration as Partial<AgentOrchestrationConfig>;
      if (orchestration.maxActiveTasksPerSession !== undefined
        && (typeof orchestration.maxActiveTasksPerSession !== 'number'
          || !Number.isInteger(orchestration.maxActiveTasksPerSession)
          || orchestration.maxActiveTasksPerSession < 1 || orchestration.maxActiveTasksPerSession > 5)) {
        details.push({ field: 'agent.orchestration.maxActiveTasksPerSession', code: 'out_of_range' });
      }
      if (orchestration.taskTimeoutMinutes !== undefined
        && (typeof orchestration.taskTimeoutMinutes !== 'number'
          || !Number.isInteger(orchestration.taskTimeoutMinutes)
          || orchestration.taskTimeoutMinutes < 1 || orchestration.taskTimeoutMinutes > 1440)) {
        details.push({ field: 'agent.orchestration.taskTimeoutMinutes', code: 'out_of_range' });
      }
    }
  }
  if (value.standardKb !== undefined && (!value.standardKb || typeof value.standardKb !== 'object')) {
    details.push({ field: 'standardKb', code: 'invalid_type' });
  } else if (value.standardKb && typeof value.standardKb === 'object') {
    const kb = value.standardKb as Partial<StandardKbConfig>;
    if (kb.outputRoot !== undefined && (typeof kb.outputRoot !== 'string' || !kb.outputRoot.trim())) {
      details.push({ field: 'standardKb.outputRoot', code: 'invalid_value' });
    }
    // S4：并行数范围校验（严格路径；宽容归一在 normalizeStandardKbConfigLoose）
    if (kb.buildParallelism !== undefined
      && (typeof kb.buildParallelism !== 'number'
        || !Number.isInteger(kb.buildParallelism)
        || kb.buildParallelism < 1 || kb.buildParallelism > 6)) {
      details.push({ field: 'standardKb.buildParallelism', code: 'out_of_range' });
    }
  }
  if (details.length > 0) throw new InvalidConfigError(details);
}

/** S2（设计 §3.1）：vision 引用交叉校验——enabled=true 时引用的 provider
 * 与预设必须存在且启用（否则 400 invalid_config{field:'agent.vision.*'}）。
 * 在合并后的完整配置上执行：agent 段保存与 llm 段保存（可能删除被引用的
 * provider）两条路径都要过这里，防止“删除 provider 后 vision 悬空”。 */
export function validateVisionProviderReference(agent: AgentConfig, llm: LlmConfig): void {
  if (!agent.vision?.enabled) return;
  const providers = llm.providers ?? [];
  const providerId = agent.vision.providerId ?? llm.activeProviderId;
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) {
    throw new InvalidConfigError([{ field: 'agent.vision.providerId', code: 'invalid_value' }]);
  }
  if (!provider.enabled) {
    throw new InvalidConfigError([{ field: 'agent.vision.providerId', code: 'provider_disabled' }]);
  }
  const models = provider.models.filter((m) => m.enabled);
  const modelId = agent.vision.modelId ?? provider.defaultModelId;
  if (!modelId || !models.some((m) => m.id === modelId)) {
    throw new InvalidConfigError([{ field: 'agent.vision.modelId', code: 'invalid_value' }]);
  }
}

const LLM_PROTOCOLS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages']);
function validateLlmProtocols(llm: Partial<LlmConfig> | undefined): void {
  if (!Array.isArray(llm?.providers)) return;
  const details = llm.providers.flatMap((p, i) => p && p.protocol !== undefined && !LLM_PROTOCOLS.has(p.protocol)
    ? [{ field: `llm.providers[${i}].protocol`, code: 'unsupported_protocol' }] : []);
  llm.providers.forEach((p, i) => {
    if (p && p.anthropicAuthType !== undefined && !['api-key', 'auth-token'].includes(p.anthropicAuthType)) {
      details.push({ field: `llm.providers[${i}].anthropicAuthType`, code: 'unsupported_auth_type' });
    }
  });
  if (details.length) throw new InvalidConfigError(details);
}

const CONFIG_ENTITY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/**
 * Z.AI / BigModel API model identifiers do not include capacity labels such
 * as `[1m]`. That label can appear in UI plan names or old local settings,
 * but sending it as the API `model` returns a misleading "model not found"
 * response. Normalize only GLM names so custom-provider model IDs remain
 * untouched.
 */
function canonicalizeGlmModelAlias(value: string | undefined | null): string {
  const model = stringValue(value);
  const match = /^(glm-[^\s[\]]+)\s*\[[^\]]+\]$/i.exec(model);
  return match ? match[1] : model;
}

function uniqueConfigId(value: unknown, fallback: string, used: Set<string>): string {
  const raw = stringValue(value).toLowerCase();
  const base = CONFIG_ENTITY_ID.test(raw) ? raw : fallback;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function inferLegacyProviderName(
  openAiCompatBaseUrl: string,
  apiKey: string,
): string {
  const looksLikeBigmodelEndpoint = /(?:^|\.)bigmodel\.cn/i.test(openAiCompatBaseUrl);
  return looksLikeBigmodelEndpoint || looksLikeBigmodelKey(apiKey)
    ? '智谱 GLM（BigModel）'
    : '默认提供商';
}

interface LegacyProviderProjection {
  openAiCompatBaseUrl: string;
  apiKey: string;
  model: string;
  directModel?: string;
}

function makeLegacyProviderProfile(legacy: LegacyProviderProjection): LlmProviderConfig {
  const directModel = canonicalizeGlmModelAlias(legacy.directModel)
    || canonicalizeGlmModelAlias(legacy.model);
  return {
    id: 'bigmodel',
    name: inferLegacyProviderName(
      legacy.openAiCompatBaseUrl,
      legacy.apiKey,
    ),
    enabled: true,
    protocol: 'openai-completions',
    apiKey: legacy.apiKey,
    openAiCompatBaseUrl: legacy.openAiCompatBaseUrl,
    defaultModelId: 'default',
    models: [{
      id: 'default',
      name: '默认模型',
      openAiModel: directModel,
      enabled: true,
    }],
  };
}

function normalizeModelPresets(
  value: unknown,
): LlmModelPreset[] {
  const rawPresets = Array.isArray(value) ? value : [];
  const usedIds = new Set<string>();
  const presets: LlmModelPreset[] = [];

  rawPresets.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return;
    const raw = candidate as Partial<LlmModelPreset>;
    const id = uniqueConfigId(raw.id, `model-${index + 1}`, usedIds);
    presets.push({
      id,
      name: stringValue(raw.name, `模型 ${index + 1}`) || `模型 ${index + 1}`,
      openAiModel: canonicalizeGlmModelAlias(raw.openAiModel),
      ...(Number.isInteger(raw.contextWindow) && raw.contextWindow! >= 1024 ? { contextWindow: raw.contextWindow } : {}),
      ...(Number.isInteger(raw.maxTokens) && raw.maxTokens! >= 1 ? { maxTokens: Math.min(raw.maxTokens!, Number.isInteger(raw.contextWindow) && raw.contextWindow! >= 1024 ? raw.contextWindow! : Number.MAX_SAFE_INTEGER) } : {}),
      ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
      ...(Array.isArray(raw.thinkingLevels) ? { thinkingLevels: raw.thinkingLevels.filter((level) => THINKING_LEVELS.has(level)) } : {}),
      ...(typeof raw.supportsImages === 'boolean' ? { supportsImages: raw.supportsImages } : {}),
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    });
  });

  return presets;
}

/**
 * Normalize provider profiles without interpreting a custom endpoint as a
 * particular vendor. This is intentionally independent from bigmodel's
 * legacy reconciliation: users may configure OpenAI, a gateway, or any
 * provider exposing either compatible protocol.
 */
function normalizeProviderProfiles(
  value: unknown,
  legacy: LegacyProviderProjection,
): LlmProviderConfig[] {
  // Missing profile data means an existing flat configuration is being
  // migrated. An explicitly empty array is preserved so a local-OpenCode-only
  // setup can opt out of remote profiles.
  if (!Array.isArray(value)) {
    return (legacy.model || legacy.directModel) ? [makeLegacyProviderProfile(legacy)] : [];
  }

  const usedIds = new Set<string>();
  const providers: LlmProviderConfig[] = [];
  value.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return;
    const raw = candidate as Partial<LlmProviderConfig>;
    const id = uniqueConfigId(raw.id, `provider-${index + 1}`, usedIds);
    const models = normalizeModelPresets(raw.models);
    const requestedDefault = stringValue(raw.defaultModelId);
    const defaultModel = models.find((model) => model.id === requestedDefault && model.enabled)
      ?? models.find((model) => model.enabled)
      ?? models[0];

    providers.push({
      id,
      name: stringValue(raw.name, `提供商 ${index + 1}`) || `提供商 ${index + 1}`,
      enabled: (typeof raw.enabled === 'boolean' ? raw.enabled : true) && (raw.protocol === undefined || LLM_PROTOCOLS.has(raw.protocol)),
      protocol: LLM_PROTOCOLS.has(raw.protocol!) ? raw.protocol : 'openai-completions',
      openAiProtocol: raw.openAiProtocol === 'openai-responses' || raw.openAiProtocol === 'openai-completions' ? raw.openAiProtocol : undefined,
      anthropicAuthType: raw.anthropicAuthType === 'api-key' || raw.anthropicAuthType === 'auth-token' ? raw.anthropicAuthType : undefined,
      protocolBaseUrls: raw.protocolBaseUrls && typeof raw.protocolBaseUrls === 'object'
        ? Object.fromEntries([...LLM_PROTOCOLS].flatMap((protocol) => typeof raw.protocolBaseUrls?.[protocol as LlmProtocol] === 'string' ? [[protocol, raw.protocolBaseUrls[protocol as LlmProtocol]]] : [])) : undefined,
      apiKey: stringValue(raw.apiKey),
      openAiCompatBaseUrl: stringValue(raw.openAiCompatBaseUrl),
      defaultModelId: defaultModel?.id,
      models,
    });
  });

  return providers;
}

/**
 * Build the default LLM config（v0.2.9 单通道精简版）。
 * 仅保留 direct 通道字段：默认 bigmodel paas/v4 端点 + 空 apiKey（用户
 * 在设置页填写）；不再读取 ANTHROPIC_* 环境变量（那是 claude CLI 时代
 * 的开箱约定）。
 */
function buildDefaultLlmConfig(): LlmConfig {
  return {
    openAiCompatBaseUrl: '', apiKey: '', model: '', directModel: '',
    temperature: 0.2, providers: [],
    activeProviderId: undefined, activeModelId: undefined,
    // 10-minute default. See LlmConfig.timeoutMs rationale in types/index.ts.
    timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    // Document body organisation is opt-in.
    contentAdaptationEnabled: false,
    primaryChannel: 'direct',
    fallbackOnFailure: false,
  };
}

const DEFAULT_CONFIG: Config = {
  llm: buildDefaultLlmConfig(),
  agent: buildDefaultAgentConfig(resolveDataRoot()),
  standardKb: buildDefaultStandardKbConfig(resolveDataRoot()),
  // S8（additive）：命令行访问默认关闭；旧配置无此段时内存补默认。
  // S12（additive）：飞书写回默认关闭（设计 §7.6）。
  cli: { enabled: false },
  // S12（additive）：飞书写回默认关闭；旧配置无此段时内存补默认。
  feishuWrite: { enabled: false },
  // P1-S8（additive）：反向发布默认关闭；旧配置无此段时内存补默认。
  feishuPublish: { enabled: false },
  // P1-S5（additive）：同步行为段（幻灯片截图采集）默认关闭；旧配置无此段时内存补默认。
  // P0-S6（additive）：白板旁路导出（svg 主 + raw 降级）缺省开启（设计
  // §5.3：旁路失败只告警，md 唯一引用仍是 PNG 预览）。
  sync: {
    slidesScreenshot: { enabled: false },
    whiteboardExport: { enabled: true },
  },
  pollIntervalMinutes: 30,
  knowledgeBaseRoot: '',
  watchedRoots: [],
  watchedRootUrls: [],
  requiredScopes: DEFAULT_REQUIRED_SCOPES,
  enableAutoStart: true,
  enableNotifications: true,
};

/**
 * One-time compatibility presets for the four roots already present in the
 * checked-in knowledge-base corpus. Runtime mapping must consume the saved
 * `watchedRoots` objects rather than this table. Unknown legacy URLs are
 * intentionally disabled and placed under a non-existent safe directory so
 * path planning cannot guess where to write.
 */
const LEGACY_ROOT_PRESETS: Record<string, Pick<WatchedRootConfig, 'localDir' | 'layoutProfile'>> = {
  Wramw1XxRihIgnkCrhqcdEbRnHb: {
    localDir: '策划 - Designer',
    layoutProfile: 'mirror-title-file',
  },
  QdZpwOmgBi25JVkAUmYcBiMinIf: {
    localDir: '技术 - Dev',
    layoutProfile: 'directory-readme',
  },
  NudewPkE9inlGhkEDA1c9FSsnkb: {
    localDir: '[必读] 研发规范',
    layoutProfile: 'directory-readme',
  },
  FEaww3vUHieIumk6FdIc92WHnyh: {
    localDir: '开发环境指引',
    layoutProfile: 'directory-readme',
  },
};

const VALID_LAYOUT_PROFILES = new Set<LayoutProfile>([
  'directory-readme',
  'mirror-title-file',
]);
const WINDOWS_RESERVED_SEGMENTS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const UNSAFE_PATH_SEGMENT_CHARS = /[\u0000-\u001f<>:"|?*]/;

interface CanonicalWatchedRootUrl {
  id: string;
  url: string;
}

/** Parse and canonicalize an HTTPS Feishu wiki root URL. */
export function canonicalizeWatchedRootUrl(value: unknown): CanonicalWatchedRootUrl | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== 'https:'
      || !/\.feishu\.cn$/i.test(parsed.hostname)
      || parsed.port
      || parsed.username
      || parsed.password
    ) return null;
    const match = parsed.pathname.match(/^\/wiki\/([A-Za-z0-9]+)\/?$/);
    if (!match) return null;
    return {
      id: match[1],
      url: `${parsed.origin}/wiki/${match[1]}`,
    };
  } catch {
    return null;
  }
}

/** Validate a portable root-relative POSIX directory. */
export function normalizeWatchedRootLocalDir(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => (
    !segment
    || segment !== segment.trim()
    || segment === '.'
    || segment === '..'
    || segment.endsWith('.')
    || UNSAFE_PATH_SEGMENT_CHARS.test(segment)
    || WINDOWS_RESERVED_SEGMENTS.test(segment)
  ))) {
    return null;
  }
  return normalized;
}

/**
 * 2026-09-04 自动 localDir：watchedRoots 保存时 localDir 留空 → 按根节点
 * 标题自动命名。标题 → 目录名 sanitize 规则（产出必须能通过上方
 * normalizeWatchedRootLocalDir 校验，保证与手填路径同一安全边界）：
 *   - 跨平台非法字符（控制符与 \\ / : * ? " < > |）替换为 '-'，压缩连续 '-'
 *   - 去首尾空白/点/'-'，截断 64 字符
 *   - 空/保留名/其他校验不过 → 回退 fallback（wiki 根 token 安全可用）
 */
export function sanitizeLocalDirName(title: unknown, fallback: string): string {
  const raw = typeof title === 'string' ? title : '';

  const cleaned = raw.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\s-]+/, '')
    .replace(/[.\s-]+$/, '')
    .slice(0, 64)
    .replace(/[.\s-]+$/, '');
  if (cleaned && normalizeWatchedRootLocalDir(cleaned)) {
    return cleaned;
  }
  return fallback;
}

/** Strictly normalize user-supplied structured root configuration. */
export function normalizeWatchedRootConfig(value: unknown): WatchedRootConfig {
  if (!value || typeof value !== 'object') {
    throw new Error('watchedRoot 必须是对象');
  }
  const candidate = value as Partial<WatchedRootConfig>;
  const canonical = canonicalizeWatchedRootUrl(candidate.url);
  if (!canonical) {
    throw new Error('watchedRoot.url 必须是规范的 https://<tenant>.feishu.cn/wiki/<token> 地址');
  }
  if (candidate.id !== canonical.id) {
    throw new Error('watchedRoot.id 必须等于 URL 中的 wiki 根 token');
  }
  const localDir = normalizeWatchedRootLocalDir(candidate.localDir);
  if (!localDir) {
    throw new Error('watchedRoot.localDir 必须是非空、不可越界的根相对 POSIX 路径');
  }
  if (!VALID_LAYOUT_PROFILES.has(candidate.layoutProfile as LayoutProfile)) {
    throw new Error('watchedRoot.layoutProfile 必须是 directory-readme 或 mirror-title-file');
  }
  if (typeof candidate.enabled !== 'boolean') {
    throw new Error('watchedRoot.enabled 必须是布尔值');
  }
  return {
    id: canonical.id,
    url: canonical.url,
    localDir,
    layoutProfile: candidate.layoutProfile as LayoutProfile,
    enabled: candidate.enabled,
  };
}

function normalizeWatchedRootList(value: unknown): WatchedRootConfig[] {
  if (!Array.isArray(value)) {
    throw new Error('watchedRoots 必须是数组');
  }
  const roots = value.map((root) => normalizeWatchedRootConfig(root));
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const root of roots) {
    if (ids.has(root.id) || urls.has(root.url)) {
      throw new Error(`watchedRoots 存在重复根：${root.id}`);
    }
    ids.add(root.id);
    urls.add(root.url);
  }
  return roots;
}

function legacyWatchedRoot(url: unknown): WatchedRootConfig | null {
  const canonical = canonicalizeWatchedRootUrl(url);
  if (!canonical) return null;
  const preset = LEGACY_ROOT_PRESETS[canonical.id];
  if (preset) {
    return { ...canonical, ...preset, enabled: true };
  }
  return {
    ...canonical,
    localDir: `__unmapped__/${canonical.id}`,
    layoutProfile: 'directory-readme',
    enabled: false,
  };
}

function migrateLegacyWatchedRootUrls(value: unknown): WatchedRootConfig[] {
  if (!Array.isArray(value)) return [];
  const roots: WatchedRootConfig[] = [];
  const ids = new Set<string>();
  for (const url of value) {
    const root = legacyWatchedRoot(url);
    if (root && !ids.has(root.id)) {
      roots.push(root);
      ids.add(root.id);
    }
  }
  return roots;
}

/**
 * Visible-at-top-of-file security warning. Written into config.json
 * as a `_warning` field so any human opening the file sees it.
 */
const API_KEY_PLAINTEXT_WARNING =
  'SECURITY WARNING: this file contains plaintext LLM API keys under ' +
  '`llm.apiKey` and/or `llm.providers[].apiKey`. Do NOT commit this file to a public repository. ' +
  'Encryption (keytar) is on the roadmap; until then, treat the key ' +
  'with the same care as a password.';

export class ConfigManager {
  private configPath: string;
  private config: Config | null = null;
  private loadFailed = false;
  /**
   * T4b-03：候选配置发布根↔watchedRoots 联合校验钩子（需云端祖先链
   * 解析器，由 index.ts 注入；未注入时跳过——嵌入式/单测场景，专用
   * target 路由自身仍独立校验）。抛错即拒绝保存。
   */
  private publishOverlapHook?: (candidate: Config, previous: Config) => Promise<void>;

  constructor(configPath?: string) {
    this.configPath = configPath || DEFAULT_CONFIG_PATH;
  }

  /** T4b-03：注入发布根联合校验钩子（见字段注释）。 */
  setPublishOverlapHook(hook: (candidate: Config, previous: Config) => Promise<void>): void {
    this.publishOverlapHook = hook;
  }

  /** Startup only: keep existing paths, and retry writable candidates for an unconfigured library. */
  async initializeKnowledgeBase(options: {
    candidates?: string[];
    mkdir?: (root: string) => void;
  } = {}): Promise<Config> {
    const current = this.config ?? await this.load();
    if (this.loadFailed) return current; // Never overwrite an unreadable existing configuration.
    if (current.knowledgeBaseRoot.trim()) return current;
    const candidates = options.candidates ?? (process.env.FEISHU_SYNC_HOME?.trim()
      ? [path.join(resolveDataRoot(), '飞书知识库')]
      : process.platform === 'win32'
        ? [suggestKnowledgeRoot(), 'C:\\飞书知识库', path.join(os.homedir(), 'Documents', '飞书知识库')]
        : [suggestKnowledgeRoot()]);
    const mkdir = options.mkdir ?? ((root: string) => { fs.mkdirSync(root, { recursive: true }); });
    for (const root of new Set(candidates)) {
      try { mkdir(root); }
      catch { continue; }
      // Preserve updateConfig's workspace overlap checks. A save failure must not
      // silently choose another location after successful directory creation.
      return this.updateConfig({ knowledgeBaseRoot: root });
    }
    console.warn('[ConfigManager] 无法创建默认知识库目录，请在设置中指定可写目录');
    return current;
  }

  /**
   * Load configuration from file, or return defaults if file doesn't exist.
   * On load, runs the v0.2.0 migration that lifts legacy flat LLM
   * config into the new channel-aware shape and writes back the
   * upgraded config (plus the security warning).
   */
  async load(): Promise<Config> {
    this.loadFailed = false;
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8');
        const raw = JSON.parse(content) as Partial<Config> & { llm?: unknown };

        // Migration step 1: legacy flat LLM config -> LlmConfig.
        const migrated = this.migrateConfig(raw);
        this.config = migrated;

        // Migration step 2: if migration changed the shape, persist the
        // upgraded config (one-time write-back).
        if (migrated._migrated) {
          const { _migrated, ...persisted } = migrated;
          await this.save(persisted);
          console.info(
            '[ConfigManager] config migration applied and persisted ' +
              '(LLM shape upgrade and/or legacy larkCliPath cleanup).'
          );
        } else {
          console.info(`[ConfigManager] Loaded config from ${this.configPath}`);
        }
      } else {
        // Fresh install: derive defaults from env and persist.
        this.config = structuredClone(DEFAULT_CONFIG);
        await this.save(this.config);
        console.info('[ConfigManager] Created default config');
      }
    } catch (error) {
      console.error('[ConfigManager] Failed to load config:', error);
      this.loadFailed = true;
      this.config = structuredClone(DEFAULT_CONFIG);
    }

    return this.config!;
  }

  /**
   * Save configuration to file. Always writes the security warning as
   * a `_warning` field at the top of the JSON so users see it when
   * opening the file.
   */
  async save(config: Config): Promise<void> {
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      const watchedRoots = normalizeWatchedRootList(config.watchedRoots);
      // `watchedRootUrls` remains available to old in-memory callers for one
      // release, but new config files carry only the structured authority.
      const runtimeConfig: Config = {
        ...config,
        watchedRoots,
        watchedRootUrls: getEnabledWatchedRootUrls({ watchedRoots }),
      };
      const { watchedRootUrls: _legacyWatchedRootUrls, ...persistentConfig } = runtimeConfig;

      // SECURITY (decision 3 / B3 plan B): plaintext key + prominent
      // warning. The warning is a JSON field (not a real JSON comment,
      // which JSON does not support). Tools reading the file MUST
      // ignore unknown keys, per JSON spec.
      const withWarning = {
        _warning: API_KEY_PLAINTEXT_WARNING,
        ...persistentConfig,
      };

      fs.writeFileSync(this.configPath, JSON.stringify(withWarning, null, 2), 'utf-8');
      this.config = runtimeConfig;
      console.info(`[ConfigManager] Saved config to ${this.configPath}`);
    } catch (error) {
      console.error('[ConfigManager] Failed to save config:', error);
      throw error;
    }
  }

  /**
   * Update LLM configuration. Accepts partial fields and merges with
   * the existing config.
   */
  async updateLLMConfig(llm: Partial<LlmConfig>): Promise<void> {
    validateLlmProtocols(llm);
    const currentConfig = await this.load();
    const updatedLlm = this.mergeLlmPartial(currentConfig.llm, llm);
    const updatedConfig: Config = {
      ...currentConfig,
      llm: updatedLlm,
    };
    // S2：llm 侧保存也可能删除/停用被 vision 引用的 provider —— 同一交叉校验
    validateVisionProviderReference(currentConfig.agent, updatedLlm);
    await this.save(updatedConfig);
  }

  /**
   * Apply a partial configuration update through the same normalization path
   * as load/save. This prevents HTTP callers from bypassing v5 root
   * validation with a shallow object merge.
   */
  async updateConfig(partial: Partial<Config>): Promise<Config> {
    // 2026-10 larkCliPath 下线：拒绝任何调用方把废弃键带回运行时/磁盘
    // 配置（旧版前端缓存、第三方脚本可能仍回传）。解析链已不读该键，
    // 但保持 config.json 干净可避免用户手工排查时被误导。
    if (Object.prototype.hasOwnProperty.call(partial, 'larkCliPath')) {
      delete (partial as Record<string, unknown>).larkCliPath;
    }
    // F1：agent/standardKb 段严格校验；workspaces 只走专用路由（防绕过路径校验）
    validateAgentAndKbConfig({ agent: partial.agent, standardKb: partial.standardKb });
    validateLlmProtocols(partial.llm);
    // S8：cli 段严格校验（缺失不报错，非法类型拒绝）。
    validateCliConfig(partial.cli);
    // S12：feishuWrite 段严格校验（同 S8 cli 模式；缺失不报错）。
    validateFeishuWriteConfig(partial.feishuWrite);
    // P1-S8：feishuPublish 段严格校验（同 S12 feishuWrite 模式；缺失不报错）。
    validateFeishuPublishConfig(partial.feishuPublish);
    // P1-S5：sync 段严格校验（同 S8 cli 模式；缺失不报错）。
    validateSyncConfig(partial.sync);
    const currentConfig = await this.load();
    const hasStructuredRoots = Object.prototype.hasOwnProperty.call(partial, 'watchedRoots');
    const hasLegacyUrls = Object.prototype.hasOwnProperty.call(partial, 'watchedRootUrls');

    let watchedRoots = currentConfig.watchedRoots;
    if (hasStructuredRoots) {
      watchedRoots = normalizeWatchedRootList(partial.watchedRoots);
    } else if (hasLegacyUrls) {
      watchedRoots = this.mergeLegacyWatchedRootUrls(
        currentConfig.watchedRoots,
        partial.watchedRootUrls,
      );
    }

    const updatedConfig: Config = {
      ...currentConfig,
      ...partial,
      watchedRoots,
      watchedRootUrls: getEnabledWatchedRootUrls({ watchedRoots }),
      llm: partial.llm
        ? this.mergeLlmPartial(currentConfig.llm, partial.llm)
        : currentConfig.llm,
      agent: partial.agent || partial.standardKb
        ? (() => {
          // workspaces：显式提供时采用（专用路由 POST/DELETE
          // /api/agent/workspaces 走这里）；PUT /api/config 在路由层剔除
          // 该字段（防 UI 全量回传绕过路径校验），两层各管各的。
          const incomingWorkspaces = Array.isArray(
            (partial.agent as { workspaces?: unknown } | undefined)?.workspaces,
          );
          const merged = normalizeAgentConfigLoose(
            partial.agent ? { ...currentConfig.agent, ...partial.agent } : currentConfig.agent,
            resolveDataRoot(),
          );
          return {
            ...merged,
            workspaces: incomingWorkspaces ? merged.workspaces : currentConfig.agent.workspaces,
          };
        })()
        : currentConfig.agent,
      standardKb: partial.standardKb
        ? normalizeStandardKbConfigLoose(
          { ...currentConfig.standardKb, ...partial.standardKb },
          resolveDataRoot(),
        )
        : currentConfig.standardKb,
      // S8（additive）：cli 段显式提供时采用（严格校验已在上方完成），
      // 否则保留当前值（旧配置内存态默认 {enabled:false}）。
      cli: partial.cli !== undefined
        ? normalizeCliConfigLoose({ ...(currentConfig.cli ?? { enabled: false }), ...partial.cli })
        : (currentConfig.cli ?? { enabled: false }),
      // S12（additive）：feishuWrite 段同 S8 cli 模式（显式提供时采用，
      // 否则保留当前值；旧配置内存态默认 {enabled:false}）。
      feishuWrite: partial.feishuWrite !== undefined
        ? normalizeFeishuWriteConfigLoose({ ...(currentConfig.feishuWrite ?? { enabled: false }), ...partial.feishuWrite })
        : (currentConfig.feishuWrite ?? { enabled: false }),
      // P1-S8（additive）：feishuPublish 段同 S12 feishuWrite 模式。
      feishuPublish: partial.feishuPublish !== undefined
        ? normalizeFeishuPublishConfigLoose({ ...(currentConfig.feishuPublish ?? { enabled: false }), ...partial.feishuPublish })
        : (currentConfig.feishuPublish ?? { enabled: false }),
      // P1-S5（additive）：sync 段同 S8 cli 模式（显式提供时采用，否则
      // 保留当前值；旧配置内存态默认 {slidesScreenshot:{enabled:false}}）。
      sync: partial.sync !== undefined
        ? normalizeSyncConfigLoose({
          slidesScreenshot: {
            ...(currentConfig.sync?.slidesScreenshot ?? { enabled: false }),
            ...(partial.sync.slidesScreenshot ?? {}),
          },
          whiteboardExport: {
            ...(currentConfig.sync?.whiteboardExport ?? { enabled: true }),
            ...(partial.sync.whiteboardExport ?? {}),
          },
        })
        : (currentConfig.sync ?? {
          slidesScreenshot: { enabled: false },
          whiteboardExport: { enabled: true },
        }),
    };
    // F3-R02：合并后配置交叉校验——已授权 Workspace 与新 knowledgeBaseRoot /
    // outputRoot / dataRoot / 静态受保护运行资源（源码树/node_modules/Electron/
    // pi 凭据目录）冲突时拒绝保存（InvalidConfigError → 400 invalid_config），
    // 而不是让冲突配置落盘后在能力使用时才暴露；同步启动不受影响（load
    // 保持宽容，只拒绝保存）。pi/Node 安装根依赖运行时发现，由路由层
    // （routes/config.ts，有 resolver 可用）在保存前补充校验。
    const workspaceConflicts = validateWorkspacesAgainstConfig({
      workspaces: updatedConfig.agent.workspaces,
      knowledgeBaseRoot: updatedConfig.knowledgeBaseRoot,
      outputRoot: updatedConfig.standardKb.outputRoot,
      dataRoot: resolveDataRoot(),
    });
    if (workspaceConflicts.length > 0) {
      throw new InvalidConfigError(workspaceConflicts.map((detail) => ({
        field: detail.field,
        code: 'workspace_path_forbidden',
      })));
    }
    // S2（设计 §3.1）：vision.enabled=true 时引用的 provider/预设必须存在且启用
    validateVisionProviderReference(updatedConfig.agent, updatedConfig.llm);
    // T4b-03：发布根↔watchedRoots 候选态联合校验收敛点——feishuPublish 段
    // 或 watchedRoots 变化时做祖先链交叉验证（覆盖通用 PUT /api/config 与
    // 专用 target 路由两个入口、target 与 watchedRoots 两个方向），祖先链
    // 不可读 fail-closed 拒绝。钩子未注入时跳过（无云端解析器场景）。
    if (this.publishOverlapHook
      && (partial.feishuPublish !== undefined || hasStructuredRoots || hasLegacyUrls)) {
      await this.publishOverlapHook(updatedConfig, currentConfig);
    }
    await this.save(updatedConfig);
    return this.config!;
  }

  /**
   * LLM partial update semantics for secrets:
   *   - omit apiKey        → retain
   *   - apiKey === '***'   → retain (masked UI echo)
   *   - apiKey === ''      → clear
   *   - any other string   → replace
   * The same semantics apply independently to every
   * `providers[].apiKey`, matched by stable provider id.
   */
  private mergeLlmPartial(
    current: LlmConfig,
    partial: Partial<LlmConfig>,
  ): LlmConfig {
    const hasProviders = Object.prototype.hasOwnProperty.call(partial, 'providers');
    const next: LlmConfig = {
      ...current,
      ...partial,
      providers: hasProviders
        ? this.mergeProviderProfiles(current.providers, partial.providers)
        : current.providers,
    };
    if (!hasProviders && !current.providers?.length && ['apiKey', 'model', 'directModel', 'openAiCompatBaseUrl'].some((key) => Object.prototype.hasOwnProperty.call(partial, key))) {
      delete next.providers;
    }
    if (Object.prototype.hasOwnProperty.call(partial, 'apiKey')) {
      const incoming = partial.apiKey;
      if (incoming === undefined || incoming === '***') {
        next.apiKey = current.apiKey;
      } else {
        next.apiKey = incoming;
      }
    } else {
      next.apiKey = current.apiKey;
    }
    return this.normalizeLlmConfig(next);
  }

  /**
   * A config GET masks provider keys as `***`. Settings sends the complete
   * provider list back on save, so merge each profile by id and retain only
   * the masked/missing secret while still allowing deliberate key clearing.
   */
  private mergeProviderProfiles(
    current: LlmProviderConfig[] | undefined,
    incoming: LlmProviderConfig[] | undefined,
  ): LlmProviderConfig[] | undefined {
    if (!Array.isArray(incoming)) return current;
    const existingById = new Map((current ?? []).map((provider) => [provider.id, provider]));

    return incoming.map((provider) => {
      const previous = existingById.get(provider.id);
      const incomingKey = provider.apiKey;
      return {
        ...(previous ?? {}),
        ...provider,
        // A model-list field is authoritative when present; an omitted one
        // (older clients) retains the stored list.
        models: Array.isArray(provider.models) ? provider.models : (previous?.models ?? []),
        apiKey: incomingKey === undefined || incomingKey === '***'
          ? (previous?.apiKey ?? '')
          : incomingKey,
      } as LlmProviderConfig;
    });
  }

  /**
   * Update polling interval.
   */
  async updatePollInterval(minutes: number): Promise<void> {
    const currentConfig = await this.load();
    const updatedConfig = {
      ...currentConfig,
      pollIntervalMinutes: minutes,
    };
    await this.save(updatedConfig);
  }

  /**
   * Add a watched URL.
   */
  async addWatchedUrl(url: string): Promise<void> {
    const currentConfig = await this.load();
    const canonical = canonicalizeWatchedRootUrl(url);
    if (!canonical) {
      throw new Error('watchedRoot URL 无效');
    }
    if (!currentConfig.watchedRoots.some((root) => root.id === canonical.id)) {
      await this.updateConfig({
        watchedRootUrls: [...currentConfig.watchedRootUrls, canonical.url],
      });
    }
  }

  /**
   * Remove a watched URL.
   */
  async removeWatchedUrl(url: string): Promise<void> {
    const currentConfig = await this.load();
    const canonical = canonicalizeWatchedRootUrl(url);
    if (!canonical) return;
    await this.updateConfig({
      watchedRootUrls: currentConfig.watchedRootUrls.filter((item) => item !== canonical.url),
    });
  }

  /**
   * Get current config (cached).
   */
  getConfig(): Config | null {
    return this.config;
  }

  /**
   * Migrate a raw parsed config object into the v0.2.0 shape. Detects
   * the legacy flat LLM config (`{ baseUrl, apiKey, model, temperature }`)
   * and lifts it into `LlmConfig` with channel-control defaults.
   *
   * Returns the migrated config with a `_migrated: true` marker if a
   * write-back is required. Callers strip `_migrated` before saving.
   *
   * Self-independence (decision 3): when the legacy config has an
   * empty apiKey, we read ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL/
   * ANTHROPIC_MODEL from env to give open-box defaults (so the app
   * works immediately on a machine that already runs claude CLI).
   * If env is also empty, we leave apiKey blank and the user fills it
   * in via the UI later.
   */
  private migrateConfig(raw: Partial<Config> & { llm?: unknown }):
    Config & { _migrated?: boolean } {
    const llmRaw = raw.llm;
    let migrated = false;

    let llm: LlmConfig;
    if (isLegacyLlmConfig(llmRaw)) {
      llm = this.migrateLegacyLlmConfig(llmRaw);
      migrated = true;
    } else if (this.isPartialLlmConfig(llmRaw)) {
      // Already new shape but possibly missing fields; normalize.
      llm = this.normalizeLlmConfig(llmRaw as Partial<LlmConfig>);
      // Avoid rewriting config.json on every load once the normalized shape
      // has already been persisted. JSON property order is stable because
      // save() writes this normalized object verbatim.
      migrated = JSON.stringify(llm) !== JSON.stringify(llmRaw);
    } else {
      // No llm field at all (shouldn't happen in practice); use defaults.
      llm = buildDefaultLlmConfig();
      migrated = true;
    }

    let watchedRoots: WatchedRootConfig[];
    if (Array.isArray(raw.watchedRoots)) {
      const normalized = this.normalizeStoredWatchedRoots(raw.watchedRoots);
      watchedRoots = normalized.roots;
      // A short-lived transition build may have written an empty structured
      // array alongside an older URL list. Preserve URL-only roots that do
      // not already have a structured owner; otherwise a config upgrade
      // could silently drop an existing sync root. Structured entries win on
      // id collisions, and unknown legacy roots stay explicitly disabled.
      const legacyRoots = migrateLegacyWatchedRootUrls(raw.watchedRootUrls);
      const knownIds = new Set(watchedRoots.map((root) => root.id));
      for (const legacyRoot of legacyRoots) {
        if (!knownIds.has(legacyRoot.id)) {
          watchedRoots.push(legacyRoot);
          knownIds.add(legacyRoot.id);
        }
      }
      // A file containing both shapes is rewritten to the canonical P2
      // shape. Invalid stored entries are retained only as disabled,
      // explicitly-unmapped roots so no path is guessed on the user's behalf.
      migrated = migrated
        || normalized.hadInvalid
        || Object.prototype.hasOwnProperty.call(raw, 'watchedRootUrls');
    } else {
      watchedRoots = migrateLegacyWatchedRootUrls(raw.watchedRootUrls);
      migrated = migrated || Array.isArray(raw.watchedRootUrls);
    }

    // larkCliPath 已废弃（2026-10）：不再读入运行时配置。磁盘上若仍有存量
    // 键（可能是指向不存在路径的错误值），触发一次迁移写回把它物理清除，
    // 防止旧配置在版本更新后继续污染 lark-cli 解析。
    migrated = migrated || Object.prototype.hasOwnProperty.call(raw, 'larkCliPath');

    // F1 additive：旧配置缺 agent/standardKb 段时补默认并写回一次。
    migrated = migrated || raw.agent === undefined || raw.standardKb === undefined;

    // 2026-10 scope 退役清理：2026-09 的 additive 迁移曾把 docs:document:read
    // 追加进存量配置；该名现已在上游失效，带上它发起授权会被整单拒绝。
    // 从存量列表剔除并触发写回，否则升级后 device flow 依旧发起失败。
    const scopeSource = Array.isArray(raw.requiredScopes) && raw.requiredScopes.length > 0
      ? raw.requiredScopes
      : DEFAULT_REQUIRED_SCOPES;
    const scopeMigration = this.migrateRequiredScopes(scopeSource);
    migrated = migrated || scopeMigration.changed;

    const config: Config = {
      llm,
      agent: normalizeAgentConfigLoose(raw.agent, resolveDataRoot()),
      standardKb: normalizeStandardKbConfigLoose(raw.standardKb, resolveDataRoot()),
      // S8（additive）：cli 段宽容归一——缺失/非法 → 默认关闭；不参与
      // _migrated 回写判定（首次任意 save 时自然落盘）。
      cli: normalizeCliConfigLoose(raw.cli),
      // S12（additive）：feishuWrite 段宽容归一——缺失/非法 → 默认关闭；
      // 同样不参与 _migrated 回写判定。
      feishuWrite: normalizeFeishuWriteConfigLoose(raw.feishuWrite),
      // P1-S8（additive）：feishuPublish 段宽容归一——缺失/非法 → 默认
      // 关闭；不参与 _migrated 回写判定。
      feishuPublish: normalizeFeishuPublishConfigLoose(raw.feishuPublish),
      // P1-S5（additive）：sync 段宽容归一——缺失/非法 → 默认关闭；
      // 不参与 _migrated 回写判定（首次任意 save 时自然落盘）。
      sync: normalizeSyncConfigLoose(raw.sync),
      pollIntervalMinutes: typeof raw.pollIntervalMinutes === 'number'
        ? raw.pollIntervalMinutes
        : DEFAULT_CONFIG.pollIntervalMinutes,
      knowledgeBaseRoot: typeof raw.knowledgeBaseRoot === 'string'
        ? raw.knowledgeBaseRoot
        : '',
      watchedRoots,
      // In-memory compatibility projection only; save() deliberately omits
      // this legacy field from the on-disk schema.
      watchedRootUrls: getEnabledWatchedRootUrls({ watchedRoots }),
      // Scope 退役迁移（2026-10）：剔除已上游失效的名字，见上方
      // scopeMigration 注释；checkAuthReady 的 SCOPE_ALIAS_GROUPS 仍作
      // 旧 token / 手改配置的等价兑底。
      requiredScopes: scopeMigration.scopes,
      enableAutoStart: typeof raw.enableAutoStart === 'boolean'
        ? raw.enableAutoStart
        : true,
      enableNotifications: typeof raw.enableNotifications === 'boolean'
        ? raw.enableNotifications
        : true,
    };

    return migrated ? { ...config, _migrated: true } : config;
  }

  /**
   * Scope 退役迁移（2026-10）：从存量列表剔除已在上游失效的 scope 名
   * （docs:document:read —— 曾由 2026-09 additive 迁移写入，现会使
   * `auth login --scope` 整单被拒）。返回是否发生变化供迁移写回判定。
   */
  private migrateRequiredScopes(scopes: string[]): { scopes: string[]; changed: boolean } {
    const retired = new Set(RETIRED_REQUEST_SCOPES);
    const kept = scopes.filter((s) => !retired.has(s));
    return { scopes: kept, changed: kept.length !== scopes.length };
  }

  /**
   * Load-time normalization is deliberately tolerant: corrupt or incomplete
   * stored roots become disabled `__unmapped__` records instead of causing
   * ConfigManager to discard the entire configuration file.
   */
  private normalizeStoredWatchedRoots(value: unknown[]): {
    roots: WatchedRootConfig[];
    hadInvalid: boolean;
  } {
    const roots: WatchedRootConfig[] = [];
    const ids = new Set<string>();
    let hadInvalid = false;
    for (const candidate of value) {
      try {
        const root = normalizeWatchedRootConfig(candidate);
        if (ids.has(root.id)) {
          hadInvalid = true;
          continue;
        }
        roots.push(root);
        ids.add(root.id);
      } catch {
        hadInvalid = true;
        const rawUrl = candidate && typeof candidate === 'object'
          ? (candidate as { url?: unknown }).url
          : undefined;
        const fallback = legacyWatchedRoot(rawUrl);
        if (fallback && !ids.has(fallback.id)) {
          roots.push({ ...fallback, enabled: false });
          ids.add(fallback.id);
        }
      }
    }
    return { roots, hadInvalid };
  }

  /** Convert legacy URL-only edits while preserving existing root layouts. */
  private mergeLegacyWatchedRootUrls(
    currentRoots: WatchedRootConfig[],
    value: unknown,
  ): WatchedRootConfig[] {
    if (!Array.isArray(value)) {
      throw new Error('watchedRootUrls 必须是数组');
    }
    const existingById = new Map(currentRoots.map((root) => [root.id, root]));
    const roots: WatchedRootConfig[] = [];
    const ids = new Set<string>();
    for (const rawUrl of value) {
      const canonical = canonicalizeWatchedRootUrl(rawUrl);
      if (!canonical) {
        throw new Error('watchedRootUrls 包含无效的飞书 wiki URL');
      }
      if (ids.has(canonical.id)) continue;
      const existing = existingById.get(canonical.id);
      roots.push(existing ? { ...existing, url: canonical.url } : legacyWatchedRoot(canonical.url)!);
      ids.add(canonical.id);
    }
    return roots;
  }

  /**
   * Lift a legacy flat `{ baseUrl, apiKey, model, temperature }` config
   * into the new `LlmConfig` shape with channel-control defaults.
   *
   * The legacy `baseUrl` was always an OpenAI-protocol URL (deepseek's
   * `https://api.deepseek.com`). We map it to `openAiCompatBaseUrl`.
   * `claudeCompatBaseUrl` defaults to the local ANTHROPIC_BASE_URL env
   * or bigmodel's default; the deepseek provider historically did not
   * expose an Anthropic adapter, so we do NOT try to infer one from
   * the legacy baseUrl.
   */
  private migrateLegacyLlmConfig(legacy: LegacyLLMConfig): LlmConfig {
    const apiKey = legacy.apiKey || '';
    // Root-cause fix for 2026-06-19 e2e-sync direct 401: when the legacy
    // deepseek `baseUrl` is carried over but the apiKey is a bigmodel
    // key, force the OpenAI-compat endpoint to bigmodel paas/v4.
    // Otherwise deepseek receives a bigmodel Bearer key and returns 401.
    const openAiBaseUrl = legacy.baseUrl ? reconcileOpenAiCompatBaseUrl(legacy.baseUrl, apiKey) : '';
    const model = legacy.model ? reconcileModelAlias(legacy.model, apiKey) : '';

    return this.normalizeLlmConfig({
      openAiCompatBaseUrl: openAiBaseUrl,
      apiKey,
      model,
      directModel: model,
      temperature: typeof legacy.temperature === 'number' ? legacy.temperature : 0.2,
      // Legacy flat configs had no timeout field; surface the 10-min
      // default so the timeout config knob is usable immediately after
      // migration.
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
      contentAdaptationEnabled: false,
      primaryChannel: 'direct',
      fallbackOnFailure: false,
    });
  }

  /**
   * Normalize a partially-populated LlmConfig into a complete one,
   * filling missing fields with sensible defaults.
   */
  private normalizeLlmConfig(partial: Partial<LlmConfig>): LlmConfig {
    const base = buildDefaultLlmConfig();
    const apiKey = partial.apiKey ?? base.apiKey;
    // Root-cause fix for 2026-06-19 e2e-sync direct 401: persisted new-shape
    // configs may still carry the legacy deepseek `openAiCompatBaseUrl`
    // (P3 migration preserved it verbatim). When the apiKey is a bigmodel
    // key but the host is deepseek/openai, substitute bigmodel paas/v4.
    const rawOpenAiBaseUrl = partial.openAiCompatBaseUrl ?? base.openAiCompatBaseUrl;
    const rawModel = partial.model ?? base.model;
    const authority = Array.isArray(partial.providers);
    const normalizedFlat = {
      openAiCompatBaseUrl: authority ? rawOpenAiBaseUrl : rawOpenAiBaseUrl ? reconcileOpenAiCompatBaseUrl(rawOpenAiBaseUrl, apiKey) : '',
      apiKey,
      model: rawModel ? reconcileModelAlias(rawModel, apiKey) : '',
      directModel: canonicalizeGlmModelAlias(partial.directModel ?? base.directModel),
    };
    const providers = normalizeProviderProfiles(partial.providers, normalizedFlat);
    const requestedProviderId = stringValue(partial.activeProviderId);
    const activeProvider = providers.find((provider) => (
      provider.id === requestedProviderId && provider.enabled
    ))
      ?? providers.find((provider) => provider.enabled)
      ?? providers[0];
    const requestedModelId = stringValue(partial.activeModelId);
    const activeModel = activeProvider?.models.find((model) => (
      model.id === requestedModelId && model.enabled
    ))
      ?? activeProvider?.models.find((model) => (
        model.id === activeProvider.defaultModelId && model.enabled
      ))
      ?? activeProvider?.models.find((model) => model.enabled)
      ?? activeProvider?.models[0];

    return {
      ...((authority || providers.length > 0) ? {
        anthropicAuthType: activeProvider?.anthropicAuthType,
        openAiCompatBaseUrl: activeProvider?.openAiCompatBaseUrl ?? '',
        apiKey: activeProvider?.apiKey ?? '', model: activeModel?.openAiModel ?? '', directModel: activeModel?.openAiModel ?? '',
      } : normalizedFlat),
      temperature: typeof partial.temperature === 'number' ? partial.temperature : 0.2,
      providers,
      activeProviderId: activeProvider?.id,
      activeModelId: activeModel?.id,
      // Persisted configs written before v0.2.0 sync-state-timeout-fix lack
      // this field. Fall back to the explicit default; preserve user-provided
      // values verbatim (including 0 / small numbers — the user set them on
      // purpose and the channel will clamp to a sane minimum at call time).
      timeoutMs: typeof partial.timeoutMs === 'number'
        ? partial.timeoutMs
        : DEFAULT_LLM_TIMEOUT_MS,
      contentAdaptationEnabled: typeof partial.contentAdaptationEnabled === 'boolean'
        ? partial.contentAdaptationEnabled
        : false,
      // v0.2.9：claude-cli / opencode 通道已移除；旧配置中的其他取值
      // 一律归一为 direct。
      primaryChannel: 'direct',
      // 单通道时代无回退；字段保留仅为旧配置兼容。
      fallbackOnFailure: false,
    };
  }

  /**
   * Quick shape check: returns true if `value` looks like a (possibly
   * partial) new-shape LlmConfig. Used to decide whether to call
   * `normalizeLlmConfig`.
   */
  private isPartialLlmConfig(value: unknown): value is Partial<LlmConfig> {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
      typeof v.openAiCompatBaseUrl === 'string' ||
      typeof v.claudeCompatBaseUrl === 'string' ||
      typeof v.primaryChannel === 'string' ||
      Array.isArray(v.providers) ||
      typeof v.activeProviderId === 'string'
    );
  }
}

// ============================================================================
// S8 追加：CLI 配置段归一与严格校验（命令行访问，默认关闭）
// ============================================================================

/** 宽容归一：缺失/非法 → 默认关闭（load 路径，不拒绝启动）。 */
function normalizeCliConfigLoose(value: unknown): CliConfig {
  if (!value || typeof value !== 'object') return { enabled: false };
  const raw = value as Partial<CliConfig>;
  return { enabled: raw.enabled === true ? true : false };
}

/**
 * 严格校验（PUT /api/config 与 /api/cli/enable 路径）：cli 段存在时
 * 必须是 { enabled: boolean }，非法直接报 InvalidConfigError（§8
 * invalid_config）。
 */
export function validateCliConfig(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidConfigError([{ field: 'cli', code: 'invalid_type' }]);
  }
  const raw = value as Partial<CliConfig>;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new InvalidConfigError([{ field: 'cli.enabled', code: 'invalid_type' }]);
  }
}

// ============================================================================
// P1-S5 追加：同步行为配置段归一与严格校验（幻灯片截图默认关闭）
// ============================================================================

/** 宽容归一：缺失/非法 → 默认关闭（load 路径，不拒绝启动）。 */
export function normalizeSyncConfigLoose(value: unknown): SyncConfig {
  if (!value || typeof value !== 'object') {
    return {
      slidesScreenshot: { enabled: false },
      whiteboardExport: { enabled: true },
    };
  }
  const raw = value as Partial<SyncConfig>;
  const screenshot = raw.slidesScreenshot as { enabled?: unknown } | undefined;
  // P0-S6：白板旁路导出缺省开启；svgTimeoutMs 仅接受正有限数，非法回落
  // 缺省预算（由 lark-cli 执行层提供）。
  const whiteboard = raw.whiteboardExport as
    | { enabled?: unknown; svgTimeoutMs?: unknown }
    | undefined;
  const svgTimeoutMs = whiteboard?.svgTimeoutMs;
  return {
    slidesScreenshot: {
      enabled: typeof screenshot?.enabled === 'boolean' ? screenshot.enabled : false,
    },
    whiteboardExport: {
      enabled: typeof whiteboard?.enabled === 'boolean' ? whiteboard.enabled : true,
      ...(typeof svgTimeoutMs === 'number' && Number.isFinite(svgTimeoutMs) && svgTimeoutMs > 0
        ? { svgTimeoutMs }
        : {}),
    },
  };
}

/**
 * 严格校验（PUT /api/config 路径）：sync 段存在时必须是
 * { slidesScreenshot: { enabled: boolean } }，非法直接报 InvalidConfigError。
 */
export function validateSyncConfig(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidConfigError([{ field: 'sync', code: 'invalid_type' }]);
  }
  const raw = value as Partial<SyncConfig>;
  if (
    raw.slidesScreenshot !== undefined
    && (!raw.slidesScreenshot || typeof raw.slidesScreenshot !== 'object')
  ) {
    throw new InvalidConfigError([{ field: 'sync.slidesScreenshot', code: 'invalid_type' }]);
  }
  const enabled = (raw.slidesScreenshot as { enabled?: unknown } | undefined)?.enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new InvalidConfigError([{ field: 'sync.slidesScreenshot.enabled', code: 'invalid_type' }]);
  }
  // P0-S6：whiteboardExport 段存在时必须是 { enabled: boolean,
  // svgTimeoutMs?: 正有限数 }，非法直接报 InvalidConfigError。
  if (
    raw.whiteboardExport !== undefined
    && (!raw.whiteboardExport || typeof raw.whiteboardExport !== 'object')
  ) {
    throw new InvalidConfigError([{ field: 'sync.whiteboardExport', code: 'invalid_type' }]);
  }
  const whiteboard = raw.whiteboardExport as
    | { enabled?: unknown; svgTimeoutMs?: unknown }
    | undefined;
  if (whiteboard?.enabled !== undefined && typeof whiteboard.enabled !== 'boolean') {
    throw new InvalidConfigError([{ field: 'sync.whiteboardExport.enabled', code: 'invalid_type' }]);
  }
  if (
    whiteboard?.svgTimeoutMs !== undefined
    && !(typeof whiteboard.svgTimeoutMs === 'number'
      && Number.isFinite(whiteboard.svgTimeoutMs)
      && whiteboard.svgTimeoutMs > 0)
  ) {
    throw new InvalidConfigError([{ field: 'sync.whiteboardExport.svgTimeoutMs', code: 'invalid_type' }]);
  }
}

// ============================================================================
// S12 追加：飞书写回配置段归一与严格校验（默认关闭）
// ============================================================================

/** 宽容归一：缺失/非法 → 默认关闭（load 路径，不拒绝启动）。 */
export function normalizeFeishuWriteConfigLoose(value: unknown): FeishuWriteConfig {
  if (!value || typeof value !== 'object') return { enabled: false };
  const raw = value as Partial<FeishuWriteConfig>;
  return { enabled: raw.enabled === true ? true : false };
}

/**
 * 严格校验（PUT /api/config 路径）：feishuWrite 段存在时必须是
 * { enabled: boolean }，非法直接报 InvalidConfigError（§8 invalid_config）。
 * 只接受 desktop token 链路：CLI 令牌无法到达 PUT /api/config（desktop auth
 * 后挂载；CLI 令牌域仅在 /api/cli/*），结构上已隔离。
 */
export function validateFeishuWriteConfig(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidConfigError([{ field: 'feishuWrite', code: 'invalid_type' }]);
  }
  const raw = value as Partial<FeishuWriteConfig>;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new InvalidConfigError([{ field: 'feishuWrite.enabled', code: 'invalid_type' }]);
  }
}

// ============================================================================
// P1-S8 追加：反向发布配置段归一与严格校验（默认关闭；发布根双向校验
// 在专用路由 PUT /api/kb/publish/target 做——需云端祖先链，超出纯配置
// 校验能力面）
// ============================================================================

const PUBLISH_TARGET_TOKEN_RE = /^[A-Za-z0-9]{8,64}$/;

/** 宽容归一：缺失/非法 → 默认关闭；target 仅保留结构合法的形态。 */
export function normalizeFeishuPublishConfigLoose(value: unknown): FeishuPublishConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { enabled: false };
  const raw = value as Partial<FeishuPublishConfig>;
  const result: FeishuPublishConfig = { enabled: raw.enabled === true };
  const target = raw.target as Partial<FeishuPublishConfig['target']> | null | undefined;
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    if ((target.kind === 'drive_folder' || target.kind === 'wiki_node')
      && typeof target.token === 'string' && PUBLISH_TARGET_TOKEN_RE.test(target.token)
      && typeof target.label === 'string' && target.label.length > 0) {
      result.target = {
        kind: target.kind,
        token: target.token,
        ...(typeof target.spaceId === 'string' && target.spaceId.length > 0 ? { spaceId: target.spaceId } : {}),
        label: target.label,
      };
    }
  }
  return result;
}

/**
 * 严格校验（PUT /api/config 与专用路由路径）：feishuPublish 段存在时
 * 结构非法直接报 InvalidConfigError；target 允许 null（清除发布根）。
 */
export function validateFeishuPublishConfig(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidConfigError([{ field: 'feishuPublish', code: 'invalid_type' }]);
  }
  const raw = value as Partial<FeishuPublishConfig>;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new InvalidConfigError([{ field: 'feishuPublish.enabled', code: 'invalid_type' }]);
  }
  if (raw.target === undefined || raw.target === null) return;
  const target = raw.target as Partial<NonNullable<FeishuPublishConfig['target']>>;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new InvalidConfigError([{ field: 'feishuPublish.target', code: 'invalid_type' }]);
  }
  if (target.kind !== 'drive_folder' && target.kind !== 'wiki_node') {
    throw new InvalidConfigError([{ field: 'feishuPublish.target.kind', code: 'invalid_type' }]);
  }
  if (typeof target.token !== 'string' || !PUBLISH_TARGET_TOKEN_RE.test(target.token)) {
    throw new InvalidConfigError([{ field: 'feishuPublish.target.token', code: 'invalid_type' }]);
  }
  if (typeof target.label !== 'string' || target.label.trim().length === 0 || target.label.length > 200) {
    throw new InvalidConfigError([{ field: 'feishuPublish.target.label', code: 'invalid_type' }]);
  }
  if (target.spaceId !== undefined
    && (typeof target.spaceId !== 'string' || !PUBLISH_TARGET_TOKEN_RE.test(target.spaceId))) {
    throw new InvalidConfigError([{ field: 'feishuPublish.target.spaceId', code: 'invalid_type' }]);
  }
}
