/**
 * ContentBackendRegistry - channel registry + fallback resolver (v0.2.0 P3)
 *
 * Implements 03 §4.1.2. Holds both channels (ClaudeCliChannel primary,
 * DirectChannel fallback) constructed from a single `ChannelConfig`.
 *
 * Fallback contract:
 *   - getFallback(tried) returns the OTHER channel iff `fallbackOnFailure`
 *     is enabled AND the other channel is registered.
 *   - Only single-layer fallback is supported (no chained retries).
 *
 * Construction is cheap; rebuild on config change is the expected
 * refresh path (e.g. when the user flips primaryChannel in the UI).
 */

import type { ChannelConfig, ChannelName, ContentBackend } from './content-backend.js';
import { ClaudeCliChannel } from './claude-cli-channel.js';
import { DirectChannel } from './direct-channel.js';
import { OpenCodeCliChannel } from './opencode-cli-channel.js';

export class ContentBackendRegistry {
  private readonly channels = new Map<ChannelName, ContentBackend>();
  private readonly primaryName: ChannelName;
  private readonly fallbackOnFailure: boolean;

  constructor(config: ChannelConfig) {
    // Register the remote channels plus the local OpenCode CLI channel.
    // OpenCode reads provider credentials from its own local config; its
    // process controls live under config.opencode.
    this.register(new DirectChannel(config.llm));
    this.register(new ClaudeCliChannel(config.llm, config.claudeCli));
    this.register(new OpenCodeCliChannel(config.llm, config.opencode));

    this.primaryName = config.primaryChannel;
    this.fallbackOnFailure = config.fallbackOnFailure;
  }

  /**
   * Register a channel. Package-private in spirit; exposed primarily for
   * testing. Production code lets the constructor register both channels.
   */
  register(channel: ContentBackend): void {
    this.channels.set(channel.name, channel);
  }

  /**
   * Look up a channel by name. Falls back to primary when name is
   * undefined. Throws on unknown name (programming error, not transient).
   */
  get(name?: ChannelName): ContentBackend {
    const target = name ?? this.primaryName;
    const channel = this.channels.get(target);
    if (!channel) {
      throw new Error(
        `ContentBackendRegistry: unknown channel "${target}". ` +
          `Registered: ${[...this.channels.keys()].join(', ')}`
      );
    }
    return channel;
  }

  /** Primary channel name (used by orchestrator's default path). */
  get primaryChannelName(): ChannelName {
    return this.primaryName;
  }

  /**
   * Return the fallback channel for the channel just tried, or null if
   * fallback is disabled or no alternative is registered.
   *
   * Only single-layer fallback is supported: claude-cli <-> direct.
   * OpenCode deliberately has no automatic remote fallback: a user who chose
   * local OpenCode must not have document content silently sent to a remote
   * provider after a local CLI error.
   */
  getFallback(tried: ChannelName): ContentBackend | null {
    if (!this.fallbackOnFailure) return null;
    if (tried === 'opencode') return null;
    const fallbackName: ChannelName = tried === 'claude-cli' ? 'direct' : 'claude-cli';
    return this.channels.get(fallbackName) ?? null;
  }
}
