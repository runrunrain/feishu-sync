/**
 * ContentBackend - LLM channel abstraction (v0.2.0 P3)
 *
 * Implements 03 §4.1.1 (双通道抽象层). Cognitive correction
 * (2026-06-18): there is ONE LLM provider (智谱 bigmodel GLM);
 * `claude -p` and OpenAI SDK 直连 are two CHANNELS of the same
 * provider, sharing ONE `LlmConfig`. `name` is a channel name
 * ('claude-cli' | 'direct'), NOT a model name.
 *
 * Architectural invariants:
 *   - ContentAdapter is channel-agnostic (only编排; no SDK import).
 *   - Registry exposes primaryChannel + getFallback() (single-layer
 *     fallback, claude-cli <-> direct).
 *   - Both channels consume the SAME `LlmConfig` (one apiKey/baseUrl/model).
 *   - ClaudeCliChannel env-injects bigmodel's Anthropic-compat endpoint
 *     (ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / ANTHROPIC_MODEL); the
 *     P0-Q4 实测 confirmed these three env var names drive claude CLI.
 *   - DirectChannel hits bigmodel's OpenAI-compat endpoint
 *     (https://open.bigmodel.cn/api/paas/v4) via OpenAI SDK.
 *
 * The two endpoints differ (one Anthropic-protocol, one OpenAI-protocol)
 * so LlmConfig carries BOTH urls explicitly rather than deriving one
 * from the other. This is documented in the type and surfaced in the
 * settings UI so the user understands they point to the same provider
 * via two protocol adapters.
 */

// ============================================================================
// Channel Names
// ============================================================================

/**
 * Channel identifier. A channel is a CALL MECHANISM, not a model.
 * - 'claude-cli': spawn `claude -p` subprocess, env-inject bigmodel
 *   Anthropic-compat credentials (main channel).
 * - 'direct': OpenAI SDK 直连 bigmodel OpenAI-compat endpoint
 *   (fallback channel).
 */
export type ChannelName = 'claude-cli' | 'direct';

// ============================================================================
// Shared Configuration Types (one config, two channels share it)
// ============================================================================

/**
 * Single LLM provider configuration shared by both channels.
 *
 * NOTE on dual baseUrl:
 *   bigmodel exposes TWO protocol adapters:
 *     - `claudeCompatBaseUrl`: Anthropic-protocol path (e.g.
 *       `https://open.bigmodel.cn/api/anthropic`), consumed by claude
 *       CLI via ANTHROPIC_BASE_URL env var. Claude CLI itself does NOT
 *       accept an OpenAI-compat URL.
 *     - `openAiCompatBaseUrl`: OpenAI-protocol path (e.g.
 *       `https://open.bigmodel.cn/api/paas/v4`), consumed by the OpenAI
 *       SDK. The SDK does NOT accept an Anthropic-protocol URL.
 *   For providers that expose BOTH adapters (like bigmodel), users fill
 *   both. For a hypothetical provider that only has one adapter, leave
 *   the other blank and disable the corresponding channel.
 *
 * `apiKey` is a single credential accepted by BOTH endpoints (verified
 * by P3 实测: bigmodel accepts the same `<id>.<secret>` key as
 * `Authorization: Bearer <key>` on paas/v4 and as the ANTHROPIC_API_KEY
 * env var for claude CLI).
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
   * OPTIONAL per-channel model overrides. Bigmodel's two endpoints
   * (paas/v4 OpenAI-compat vs /api/anthropic) use different alias
   * spaces; e.g. `glm-5.2[1m]` is valid only at the Anthropic
   * endpoint, while `glm-4-flash` is valid only at the OpenAI
   * endpoint. When `directModel` / `claudeCliModel` are set they
   * take precedence over the shared `model` for the respective
   * channel. Otherwise both channels fall back to `model`.
   */
  directModel?: string;
  claudeCliModel?: string;
  /** Sampling temperature, 0.0-1.0. Default 0.2. */
  temperature?: number;
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
 * Channel selection and fallback policy.
 */
export interface ChannelConfig {
  /** Shared LLM provider config. */
  llm: LlmConfig;
  /** ClaudeCliChannel-only control fields. */
  claudeCli?: ClaudeCliConfig;
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
