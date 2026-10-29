import { resolveProviderModel, type ModelSelection } from './model-selection.js';
/**
 * ContentBackend - LLM channel abstraction (v0.2.0 P3)
 *
 * v0.2.9 清理：claude-cli 与 opencode 两个本地无头 CLI 通道整体移除，
 * 保留 DirectChannel（OpenAI/Anthropic SDK 按共享协议调用）。本文件
 * 同步移除 ClaudeCliConfig / OpenCodeCliConfig / claudeCompatBaseUrl /
 * claudeCliModel 等仅服务于已删通道的类型与字段。
 *
 * Architectural invariants:
 *   - ContentAdapter is channel-agnostic (only编排; no SDK import).
 *   - Registry exposes get()/getFallback()；单通道时代 getFallback()
 *     恒为 null，整理失败由 sync-engine 的确定性结果兜底。
 */

import type { LlmProviderConfig, LlmProtocol } from '../types/index.js';

export type { LlmModelPreset, LlmProviderConfig, LlmProtocol } from '../types/index.js';

// ============================================================================
// Channel Names
// ============================================================================

/**
 * Channel identifier. A channel is a CALL MECHANISM, not a model.
 * v0.2.9 起仅剩 'direct'：OpenAI SDK 直连 OpenAI 兼容端点。
 */
export type ChannelName = 'direct';

// ============================================================================
// Shared Configuration Types
// ============================================================================

/**
 * Flat compatibility projection consumed by DirectChannel.
 *
 * `openAiCompatBaseUrl` 是 OpenAI 协议端点（如
 * `https://open.bigmodel.cn/api/paas/v4`），`apiKey` 为 bearer 凭证，
 * `model` / `directModel` 为该端点可用的模型别名。
 */
export interface LlmConfig {
  anthropicAuthType?: 'api-key' | 'auth-token';
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  protocol?: LlmProtocol;
  /** OpenAI-compat base URL for DirectChannel (OpenAI SDK baseURL). */
  openAiCompatBaseUrl: string;
  /** Provider credential (bearer key). */
  apiKey: string;
  /** Model alias valid at the OpenAI-compat endpoint. */
  model: string;
  /** Optional per-channel model override for DirectChannel. */
  directModel?: string;
  /** Sampling temperature, 0.0-1.0. Default 0.2. */
  temperature?: number;
  /**
   * Per-call adaptation timeout in milliseconds. Default 600000 (10
   * minutes). See `LlmConfig.timeoutMs` in types/index.ts for the full
   * rationale on why this default was raised from the previous 60s
   * hard-coded value.
   */
  timeoutMs?: number;
  /** Remote-provider profiles. When present, the active profile wins over legacy fields. */
  providers?: LlmProviderConfig[];
  /** Selected provider id for the direct channel. */
  activeProviderId?: string;
  /** Selected model-preset id within the active provider. */
  activeModelId?: string;
}

/**
 * Resolve a user-selected provider/model preset into the legacy flat shape
 * consumed by DirectChannel.
 *
 * Keeping this boundary here makes provider profiles operational rather than
 * merely UI metadata: DirectChannel always receives the selected provider's
 * key, endpoint and model alias. Empty endpoint/key/model values are
 * preserved deliberately so the channel can fail fast with its existing
 * friendly configuration error instead of accidentally falling back to a
 * different provider's legacy credentials.
 */
export function resolveActiveLlmConfig(llm: LlmConfig, selection?: ModelSelection): LlmConfig {
  // Only genuinely old flat configs may use flat credentials. An explicit empty
  // provider array means unconfigured and must never revive deleted profiles.
  if (!Array.isArray(llm.providers)) return llm;
  const resolved = resolveProviderModel(llm, selection);
  return { ...llm, protocol: resolved?.protocol ?? 'openai-completions',
    openAiCompatBaseUrl: resolved?.baseUrl ?? '', apiKey: resolved?.apiKey ?? '', anthropicAuthType: resolved?.anthropicAuthType,
    model: resolved?.openAiModel ?? '', directModel: resolved?.openAiModel ?? '',
    contextWindow: resolved?.contextWindow, maxTokens: resolved?.maxTokens, reasoning: resolved?.reasoning };
}

/**
 * Channel selection policy (v0.2.9 单通道精简版：仅承载共享 LLM 配置)。
 */
export interface ChannelConfig {
  /** Shared LLM provider config. */
  llm: LlmConfig;
  selection?: ModelSelection;
}

// ============================================================================
// Channel I/O Types
// ============================================================================

export interface AdaptInput {
  /** Feishu raw content (post LayoutReconstructor reconstruction). */
  rawContent: string;
  /** Local old version, used as few-shot style example (optional). */
  localOldContent: string | null;
  /** Adaptation options. */
  options: AdaptOptions;
}

export interface AdaptOptions {
  /** Sampling temperature override (falls back to LlmConfig.temperature). */
  temperature?: number;
  /** Reserved for SDK streaming. */
  enableStreaming?: boolean;
  /** Optional progress callback (SDK streaming only). */
  onProgress?: (chunk: string) => void;
  /** Per-call timeout in ms. Default 60000. */
  timeoutMs?: number;
}

export type AdaptFinishReason = 'stop' | 'length' | 'timeout' | 'error';

export interface AdaptOutput {
  /** Adapted markdown produced by the channel. */
  adaptedMarkdown: string;
  /** Total tokens consumed (best-effort). */
  tokensUsed?: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Channel that produced this output. */
  channelName: ChannelName;
  /** Effective model alias used by the channel. */
  model: string;
  /** Finish reason; 'stop'|'length' counts as success. */
  finishReason?: AdaptFinishReason;
  /** Optional error message for non-success finish reasons. */
  errorMessage?: string;
}

// ============================================================================
// ContentBackend Interface
// ============================================================================

/**
 * Channel abstraction. Implementations encapsulate the call mechanism
 * (OpenAI SDK), the protocol translation, and the error classification.
 */
export interface ContentBackend {
  /** Channel name; identifies the call mechanism. */
  readonly name: ChannelName;
  /** Whether streaming chunks are supported. */
  readonly supportsStreaming: boolean;

  /**
   * Adapt raw markdown to local style. MUST NOT throw on
   * transient/channel errors; instead return finishReason='error' or
   * 'timeout' so the caller can apply the deterministic fallback.
   */
  adapt(input: AdaptInput): Promise<AdaptOutput>;
}

// ============================================================================
// Success Predicate
// ============================================================================

/**
 * A channel call is considered SUCCESSFUL if the model produced output
 * and stopped normally (either by end_turn or by hitting max_tokens).
 */
export function isSuccess(reason: AdaptFinishReason | undefined): boolean {
  return reason === 'stop' || reason === 'length';
}
