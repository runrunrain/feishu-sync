/**
 * ContentBackend - LLM channel abstraction (v0.2.0 P3)
 *
 * Implements 03 §4.1.1 (双通道抽象层). `claude -p` and OpenAI SDK 直连
 * are two CHANNELS of the selected remote provider/model preset. OpenCode
 * is a third, local CLI channel which deliberately uses the user's existing
 * OpenCode provider configuration instead of this application's remote
 * credentials.
 *
 * Architectural invariants:
 *   - ContentAdapter is channel-agnostic (only编排; no SDK import).
 *   - Registry exposes primaryChannel + getFallback() (single-layer
 *     fallback, claude-cli <-> direct).
 *   - Both remote channels resolve the SAME active provider/model preset.
 *   - ClaudeCliChannel env-injects an Anthropic-compatible endpoint. Z.AI
 *     Coding Plan uses ANTHROPIC_AUTH_TOKEN; generic providers use
 *     ANTHROPIC_API_KEY / ANTHROPIC_MODEL.
 *   - DirectChannel hits an OpenAI-compatible endpoint via OpenAI SDK.
 *
 * The two endpoints differ (one Anthropic-protocol, one OpenAI-protocol)
 * so LlmConfig carries BOTH urls explicitly rather than deriving one
 * from the other. This is documented in the type and surfaced in the
 * settings UI so the user can configure both protocol adapters for a
 * provider when needed.
 */

import type { LlmModelPreset, LlmProviderConfig } from '../types/index.js';

export type { LlmModelPreset, LlmProviderConfig } from '../types/index.js';

// ============================================================================
// Channel Names
// ============================================================================

/**
 * Channel identifier. A channel is a CALL MECHANISM, not a model.
 * - 'claude-cli': spawn `claude -p` subprocess, env-inject an
 *   Anthropic-compatible credential (main channel).
 * - 'direct': OpenAI SDK 直连 an OpenAI-compatible endpoint (fallback).
 */
export type ChannelName = 'claude-cli' | 'direct' | 'opencode';

// ============================================================================
// Shared Configuration Types (one config, two channels share it)
// ============================================================================

/**
 * Flat compatibility projection shared by both remote channels.
 *
 * NOTE on dual baseUrl:
 *   a provider may expose TWO protocol adapters:
 *     - `claudeCompatBaseUrl`: Anthropic-protocol path (e.g.
 *       `https://open.bigmodel.cn/api/anthropic`), consumed by claude
 *       CLI via ANTHROPIC_BASE_URL env var. Claude CLI itself does NOT
 *       accept an OpenAI-compat URL.
 *     - `openAiCompatBaseUrl`: OpenAI-protocol path (e.g.
 *       `https://open.bigmodel.cn/api/paas/v4`), consumed by the OpenAI
 *       SDK. The SDK does NOT accept an Anthropic-protocol URL.
 *   For providers that expose BOTH adapters (like GLM), users fill
 *   both. For a hypothetical provider that only has one adapter, leave
 *   the other blank and disable the corresponding channel.
 *
 * `apiKey` is a shared provider credential. The OpenAI endpoint uses a
 * bearer key; Z.AI's Claude Code compatibility path consumes it as
 * `ANTHROPIC_AUTH_TOKEN`.
 */
export interface LlmConfig {
  /** OpenAI-compat base URL for DirectChannel (OpenAI SDK baseURL). */
  openAiCompatBaseUrl: string;
  /**
   * Anthropic-compat base URL for ClaudeCliChannel (env-injected as
   * ANTHROPIC_BASE_URL to the claude subprocess).
   */
  claudeCompatBaseUrl: string;
  /** Single API key shared by both channels. */
  apiKey: string;
  /**
   * Model alias. Must be valid at BOTH endpoints. For bigmodel, the
   * OpenAI-compat endpoint uses names like `glm-4-flash` / `glm-4.5`,
   * while the Anthropic-compat endpoint accepts `glm-4.5` / `glm-5.2`.
   * When a single alias is not valid at both endpoints, populate the
   * channel-specific overrides below.
   */
  model: string;
  /**
 * OPTIONAL per-channel model overrides. A provider can expose different
 * aliases per protocol. When `directModel` / `claudeCliModel` are set they
 * take precedence over the shared `model` for the respective channel.
 * Otherwise both channels fall back to `model`.
   */
  directModel?: string;
  claudeCliModel?: string;
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
  /** Selected provider id for the remote direct / Claude Code channels. */
  activeProviderId?: string;
  /** Selected model-preset id within the active provider. */
  activeModelId?: string;
}

/**
 * Resolve a user-selected provider/model preset into the legacy flat shape
 * consumed by the two remote channel implementations.
 *
 * Keeping this boundary here makes provider profiles operational rather than
 * merely UI metadata: DirectChannel and ClaudeCliChannel always receive the
 * selected provider's key, endpoint and protocol-specific model aliases.
 * Empty endpoint/key/model values are preserved deliberately so the channel
 * can fail fast with its existing friendly configuration error instead of
 * accidentally falling back to a different provider's legacy credentials.
 */
export function resolveActiveLlmConfig(llm: LlmConfig): LlmConfig {
  const profiles = Array.isArray(llm.providers)
    ? llm.providers.filter((profile): profile is LlmProviderConfig => (
      !!profile
      && typeof profile === 'object'
      && profile.enabled !== false
      && typeof profile.id === 'string'
    ))
    : [];
  const provider = profiles.find((profile) => profile.id === llm.activeProviderId)
    ?? profiles[0];

  if (!provider) return llm;

  const presets = Array.isArray(provider.models)
    ? provider.models.filter((preset): preset is LlmModelPreset => (
      !!preset
      && typeof preset === 'object'
      && preset.enabled !== false
      && typeof preset.id === 'string'
    ))
    : [];
  const preset = presets.find((item) => item.id === llm.activeModelId)
    ?? presets.find((item) => item.id === provider.defaultModelId)
    ?? presets[0];

  // A provider without an enabled model remains a valid saved draft. Its
  // endpoint/key still become effective, while blank model aliases surface a
  // deterministic channel-side configuration error rather than calling a
  // previously selected provider by accident.
  const openAiModel = preset && typeof preset.openAiModel === 'string'
    ? preset.openAiModel
    : '';
  const claudeCliModel = preset && typeof preset.claudeCliModel === 'string'
    ? preset.claudeCliModel
    : '';
  const isZai = /(?:^|\.)bigmodel\.cn|(?:^|\.)z\.ai/i.test(provider.openAiCompatBaseUrl)
    || /(?:^|\.)bigmodel\.cn|(?:^|\.)z\.ai/i.test(provider.claudeCompatBaseUrl);
  // GLM's current API model identifier is e.g. `glm-5.2`. Older config
  // examples sometimes stored a capacity display suffix (`glm-5.2[1m]`),
  // which the OpenAI-compatible endpoint rejects as an unknown model. Keep
  // the saved display value intact but use the canonical runtime identifier.
  const normalizeZaiModel = (value: string) => (
    isZai ? value.trim().replace(/\[[^\]]+\]$/, '') : value
  );
  const resolvedOpenAiModel = normalizeZaiModel(openAiModel);
  const resolvedClaudeCliModel = normalizeZaiModel(claudeCliModel);

  return {
    ...llm,
    openAiCompatBaseUrl: typeof provider.openAiCompatBaseUrl === 'string'
      ? provider.openAiCompatBaseUrl
      : '',
    claudeCompatBaseUrl: typeof provider.claudeCompatBaseUrl === 'string'
      ? provider.claudeCompatBaseUrl
      : '',
    apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : '',
    // `model` is kept meaningful for logs and old callers. Individual
    // channels use their protocol-specific override below.
    model: resolvedClaudeCliModel || resolvedOpenAiModel || '',
    directModel: resolvedOpenAiModel,
    claudeCliModel: resolvedClaudeCliModel,
  };
}

/**
 * ClaudeCliChannel-specific control fields.
 *
 * Contains ONLY process-control knobs; NO apiKey/baseUrl/model (those
 * live in `LlmConfig`, shared with DirectChannel).
 */
export interface ClaudeCliConfig {
  /** Optional path to `claude` executable; defaults to PATH lookup. */
  claudePath?: string;
  /** Extra CLI args appended after the standard invocation. */
  extraArgs?: string[];
}

/**
 * OpenCode process control. Credentials themselves are never persisted in
 * this object: when the active app provider has a key, OpenCode receives a
 * one-process `OPENCODE_CONFIG_CONTENT` overlay; otherwise it falls back to
 * the user's own OpenCode configuration (for example
 * ~/.config/opencode/opencode.json). All fields are optional.
 */
export interface OpenCodeCliConfig {
  /** Optional absolute executable path; otherwise the app resolves PATH/npm globals. */
  executablePath?: string;
  /** Optional OpenCode model in `provider/model` form. */
  model?: string;
  /** Optional OpenCode agent name. */
  agent?: string;
  /** Per-document process timeout. Defaults to LlmConfig.timeoutMs / 10 minutes. */
  timeoutMs?: number;
}

/**
 * Channel selection and fallback policy.
 */
export interface ChannelConfig {
  /** Shared LLM provider config. */
  llm: LlmConfig;
  /** ClaudeCliChannel-only control fields. */
  claudeCli?: ClaudeCliConfig;
  /** OpenCode-specific process controls. */
  opencode?: OpenCodeCliConfig;
  /** Primary channel used first. Default 'claude-cli'. */
  primaryChannel: ChannelName;
  /**
   * On primary channel failure (timeout/error), retry with the other
   * channel. Default true.
   */
  fallbackOnFailure: boolean;
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
  /** Unused for claude (claude -p is non-streaming); reserved for SDK. */
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
  /** Total tokens consumed (best-effort; claude CLI exposes this via usage). */
  tokensUsed?: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Channel that produced this output. */
  channelName: ChannelName;
  /** Effective model alias used by the channel. */
  model: string;
  /** Finish reason; 'stop'|'length' counts as success for fallback logic. */
  finishReason?: AdaptFinishReason;
  /** Optional error message for non-success finish reasons. */
  errorMessage?: string;
}

// ============================================================================
// ContentBackend Interface
// ============================================================================

/**
 * Channel abstraction. Implementations encapsulate the call mechanism
 * (claude CLI subprocess vs OpenAI SDK), the protocol translation, and
 * the error classification. The orchestrator (ContentAdapter) selects
 * channels and applies the fallback chain.
 */
export interface ContentBackend {
  /** Channel name; identifies the call mechanism. */
  readonly name: ChannelName;
  /** Whether streaming chunks are supported. */
  readonly supportsStreaming: boolean;

  /**
   * Adapt raw markdown to local style. MUST NOT throw on
   * transient/channel errors; instead return finishReason='error' or
   * 'timeout' so the orchestrator can fall back. Reserved-only throws
   * (e.g. misconfiguration) are acceptable.
   */
  adapt(input: AdaptInput): Promise<AdaptOutput>;
}

// ============================================================================
// Success Predicate
// ============================================================================

/**
 * A channel call is considered SUCCESSFUL if the model produced output
 * and stopped normally (either by end_turn or by hitting max_tokens).
 * Failure modes 'timeout' and 'error' trigger fallback in the registry.
 */
export function isSuccess(reason: AdaptFinishReason | undefined): boolean {
  return reason === 'stop' || reason === 'length';
}
