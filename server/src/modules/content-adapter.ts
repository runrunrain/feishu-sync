/**
 * ContentAdapter - channel-agnostic LLM orchestration (v0.2.0 P3)
 *
 * Implements 03 §4.1.3. This class no longer imports the OpenAI SDK;
 * SDK calls live inside DirectChannel. ContentAdapter's job is:
 *   1. Resolve the primary channel from the registry.
 *   2. Call adapt(); on failure (timeout/error), consult the registry's
 *      fallback and try the OTHER channel.
 *   3. Return the result; on full failure, return the LAST result so
 *      the caller (sync-engine) can apply the deterministic B6 fallback
 *      (use LayoutReconstructor's reconstructedMarkdown instead of
 *      rawContent).
 *
 * The orchestrator NEVER throws on channel failures; it surfaces them
 * as AdaptOutput with finishReason='error'/'timeout'. This lets the
 * sync pipeline stay deterministic and rely on B6 fallback.
 *
 * Streaming: only honored when the selected channel reports
 * supportsStreaming=true (i.e. DirectChannel). ClaudeCliChannel is
 * non-streaming; the orchestrator skips the onProgress path for it.
 */

import type {
  AdaptOptions,
  AdaptOutput,
  ChannelName,
} from './content-backend.js';
import type { ContentBackendRegistry } from './content-backend-registry.js';

export interface ContentAdapterCallOptions {
  /** Override the registry's primary channel for this call. */
  channel?: ChannelName;
  /** Per-call adapt options (temperature/timeout/streaming/onProgress). */
  adapt: AdaptOptions;
}

export class ContentAdapter {
  constructor(private readonly registry: ContentBackendRegistry) {}

  /**
   * Adapt raw markdown through the primary channel; on failure, try
   * the fallback channel. Returns the final result (success OR the
   * last failure). Never throws on channel errors.
   */
  async adaptContent(
    rawContent: string,
    localOldContent: string | null,
    options: ContentAdapterCallOptions
  ): Promise<AdaptOutput> {
    const primary = this.registry.get(options.channel);
    const primaryOptions = this.applyStreamingConstraint(primary.supportsStreaming, options.adapt);

    const primaryResult = await primary.adapt({
      rawContent,
      localOldContent,
      options: primaryOptions,
    });

    if (this.isOk(primaryResult)) {
      return primaryResult;
    }

    const fallback = this.registry.getFallback(primary.name);
    if (!fallback) {
      // Fallback disabled in config, or no alternative registered.
      return primaryResult;
    }

    console.warn(
      `[ContentAdapter] primary channel "${primary.name}" failed ` +
        `(finishReason=${primaryResult.finishReason}, ` +
        `error=${primaryResult.errorMessage ?? '<none>'}); ` +
        `falling back to "${fallback.name}".`
    );

    const fallbackOptions = this.applyStreamingConstraint(
      fallback.supportsStreaming,
      options.adapt
    );
    const fallbackResult = await fallback.adapt({
      rawContent,
      localOldContent,
      options: fallbackOptions,
    });

    if (this.isOk(fallbackResult)) {
      return fallbackResult;
    }

    console.warn(
      `[ContentAdapter] fallback channel "${fallback.name}" also failed ` +
        `(finishReason=${fallbackResult.finishReason}, ` +
        `error=${fallbackResult.errorMessage ?? '<none>'}); ` +
        `caller should apply deterministic B6 fallback.`
    );

    // Return the FALLBACK result (the last attempt) so the caller can
    // inspect finishReason and decide whether to use rawContent or
    // reconstructedMarkdown as the deterministic fallback.
    return fallbackResult;
  }

  /**
   * If the selected channel doesn't support streaming, strip the
   * onProgress/enableStreaming flags to avoid confusing channel
   * implementations (which should already ignore them, but be safe).
   */
  private applyStreamingConstraint(
    supportsStreaming: boolean,
    options: AdaptOptions
  ): AdaptOptions {
    if (supportsStreaming) return options;
    const { onProgress: _drop, enableStreaming: _drop2, ...rest } = options;
    void _drop;
    void _drop2;
    return rest;
  }

  /**
   * A channel call is OK if the model produced non-empty output and
   * stopped normally. Empty output with finishReason='stop' is treated
   * as failure (likely a parse glitch) to give the fallback a chance.
   */
  private isOk(result: AdaptOutput): boolean {
    if (result.finishReason !== 'stop' && result.finishReason !== 'length') {
      return false;
    }
    return result.adaptedMarkdown.trim().length > 0;
  }
}
