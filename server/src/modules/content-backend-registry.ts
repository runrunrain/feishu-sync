/**
 * ContentBackendRegistry - 通道注册表（v0.2.9 起：direct 单通道）
 *
 * v0.2.9 清理：claude-cli 与 opencode 两个本地无头 CLI 通道整体移除，
 * 文档整理只保留 DirectChannel（OpenAI 兼容远程端点）。registry 维持
 * ContentAdapter 的既有调用形态（get()/getFallback()），但：
 *   - 只注册 direct 一个通道，primaryName 恒为 'direct'
 *   - getFallback() 恒为 null（无第二通道可回退；整理失败由
 *     sync-engine 的确定性 B6 结果兜底，契约不变）
 */

import type { ChannelConfig, ChannelName, ContentBackend } from './content-backend.js';
import { DirectChannel } from './direct-channel.js';

export class ContentBackendRegistry {
  private readonly channels = new Map<ChannelName, ContentBackend>();

  constructor(config: ChannelConfig) {
    this.register(new DirectChannel(config.llm));
  }

  /**
   * Register a channel. Package-private in spirit; exposed primarily for
   * testing. Production code lets the constructor register the channel.
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

  private get primaryName(): ChannelName {
    return 'direct';
  }

  /**
   * 单通道时代没有可回退的第二通道：恒为 null。整理失败由调用方
   * （sync-engine）落回确定性格式重建结果。
   */
  getFallback(_tried: ChannelName): ContentBackend | null {
    return null;
  }
}
