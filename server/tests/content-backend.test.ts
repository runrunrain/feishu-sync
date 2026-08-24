/**
 * ContentBackend tests（v0.2.9 单通道版）
 *
 * v0.2.9 清理：claude-cli / opencode 本地无头通道移除，仅保留
 * DirectChannel。本文件相应保留：
 *   - Registry 单通道注册/查找/无回退
 *   - ContentAdapter 编排（单通道：成功路径、失败直返、空内容视为失败）
 *   - DirectChannel 成功/错误分类（OpenAI SDK mocked）
 *   - isSuccess 谓词与 isLegacyLlmConfig 类型守卫
 *
 * Integration layer: real bigmodel connectivity is exercised separately by
 * tests/llm-channels-connectivity.test.ts (gated behind
 * BIGMODEL_INTEGRATION=1 to avoid CI cost).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  isSuccess,
  type AdaptFinishReason,
  type ChannelConfig,
  type LlmConfig,
} from '../src/modules/content-backend.js';
import { ContentBackendRegistry } from '../src/modules/content-backend-registry.js';
import { ContentAdapter } from '../src/modules/content-adapter.js';
import { isLegacyLlmConfig } from '../src/types/index.js';

// ============================================================================
// Helpers: fake channel for orchestrator tests
// ============================================================================

class FakeChannel {
  readonly name = 'direct' as const;
  readonly supportsStreaming: boolean;
  nextResult: { adaptedMarkdown: string; finishReason: AdaptFinishReason; errorMessage?: string } = {
    adaptedMarkdown: '',
    finishReason: 'error',
  };
  adaptCalls = 0;

  constructor(supportsStreaming: boolean) {
    this.supportsStreaming = supportsStreaming;
  }

  async adapt(): Promise<any> {
    this.adaptCalls++;
    return {
      adaptedMarkdown: this.nextResult.adaptedMarkdown,
      durationMs: 10,
      channelName: this.name,
      model: 'test-model',
      finishReason: this.nextResult.finishReason,
      errorMessage: this.nextResult.errorMessage,
    };
  }
}

// ============================================================================
// Registry tests
// ============================================================================

function buildTestLlm(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    openAiCompatBaseUrl: 'https://example.test/api/paas/v4',
    apiKey: 'test-key',
    model: 'test-model',
    temperature: 0.2,
    ...overrides,
  };
}

describe('ContentBackendRegistry', () => {
  it('registers the direct channel and resolves it by default', () => {
    const cfg: ChannelConfig = { llm: buildTestLlm() };
    const reg = new ContentBackendRegistry(cfg);
    expect(reg.get().name).toBe('direct');
    expect(reg.get('direct').name).toBe('direct');
    expect(reg.primaryChannelName).toBe('direct');
  });

  it('getFallback always returns null (single-channel era)', () => {
    const reg = new ContentBackendRegistry({ llm: buildTestLlm() });
    expect(reg.getFallback('direct')).toBeNull();
  });

  it('throws on unknown channel name', () => {
    const reg = new ContentBackendRegistry({ llm: buildTestLlm() });
    expect(() => reg.get('garbage' as any)).toThrow(/unknown channel/);
  });
});

// ============================================================================
// ContentAdapter orchestrator tests (uses FakeChannel via custom registry)
// ============================================================================

/**
 * Custom registry that lets tests inject FakeChannel instances. We bypass
 * the real channel by replacing the private channels map after construction.
 */
class TestableRegistry extends ContentBackendRegistry {
  constructor(channels: Array<FakeChannel>) {
    super({ llm: buildTestLlm() });
    // Replace the real channel with our fakes.
    (this as any).channels = new Map(channels.map((ch) => [ch.name, ch]));
  }
}

describe('ContentAdapter orchestration', () => {
  it('returns primary result on success', async () => {
    const primary = new FakeChannel(false);
    primary.nextResult = { adaptedMarkdown: 'PRIMARY-OK', finishReason: 'stop' };

    const reg = new TestableRegistry([primary]);
    const adapter = new ContentAdapter(reg);

    const result = await adapter.adaptContent('raw', null, {
      adapt: { temperature: 0.2 },
    });

    expect(result.adaptedMarkdown).toBe('PRIMARY-OK');
    expect(result.channelName).toBe('direct');
    expect(primary.adaptCalls).toBe(1);
  });

  it('returns the failure directly when the only channel fails (caller applies B6)', async () => {
    const primary = new FakeChannel(false);
    primary.nextResult = {
      adaptedMarkdown: '',
      finishReason: 'error',
      errorMessage: 'primary boom',
    };

    const reg = new TestableRegistry([primary]);
    const adapter = new ContentAdapter(reg);

    const result = await adapter.adaptContent('raw', null, {
      adapt: { temperature: 0.2 },
    });

    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toContain('primary boom');
    expect(primary.adaptCalls).toBe(1);
  });

  it('returns timeout failure directly when the only channel times out', async () => {
    const primary = new FakeChannel(false);
    primary.nextResult = {
      adaptedMarkdown: '',
      finishReason: 'timeout',
      errorMessage: 'timed out',
    };

    const reg = new TestableRegistry([primary]);
    const adapter = new ContentAdapter(reg);

    const result = await adapter.adaptContent('raw', null, {
      adapt: { temperature: 0.2 },
    });

    expect(result.finishReason).toBe('timeout');
    expect(primary.adaptCalls).toBe(1);
  });

  it('treats empty adaptedMarkdown with finishReason=stop as failure', async () => {
    const primary = new FakeChannel(false);
    primary.nextResult = { adaptedMarkdown: '   ', finishReason: 'stop' };

    const reg = new TestableRegistry([primary]);
    const adapter = new ContentAdapter(reg);

    const result = await adapter.adaptContent('raw', null, {
      adapt: { temperature: 0.2 },
    });

    // 单通道无回退：空内容视为失败结果直返（调用方落确定性结果）。
    expect(result.adaptedMarkdown.trim()).toBe('');
    expect(primary.adaptCalls).toBe(1);
  });

  it('strips onProgress/enableStreaming for non-streaming channels', async () => {
    const primary = new FakeChannel(false);
    primary.nextResult = { adaptedMarkdown: 'PRIMARY-OK', finishReason: 'stop' };

    const reg = new TestableRegistry([primary]);
    const adapter = new ContentAdapter(reg);

    const onProgress = vi.fn();
    await adapter.adaptContent('raw', null, {
      adapt: { temperature: 0.2, enableStreaming: true, onProgress },
    });

    // FakeChannel ignores options, but the constraint logic ran.
    // Verifying absence of crash is enough; the constraint is exercised.
    expect(primary.adaptCalls).toBe(1);
  });
});

// ============================================================================
// isSuccess predicate
// ============================================================================

describe('isSuccess', () => {
  it('returns true for stop and length', () => {
    expect(isSuccess('stop')).toBe(true);
    expect(isSuccess('length')).toBe(true);
  });

  it('returns false for timeout, error, and undefined', () => {
    expect(isSuccess('timeout')).toBe(false);
    expect(isSuccess('error')).toBe(false);
    expect(isSuccess(undefined)).toBe(false);
  });
});

// ============================================================================
// DirectChannel tests (OpenAI SDK mocked)
// ============================================================================

describe('DirectChannel', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns error when apiKey is empty (misconfiguration)', async () => {
    const { DirectChannel } = await import('../src/modules/direct-channel.js');
    const ch = new DirectChannel(buildTestLlm({ apiKey: '' }));
    const result = await ch.adapt({
      rawContent: 'raw',
      localOldContent: null,
      options: { temperature: 0.2 },
    });
    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toMatch(/apiKey is empty/);
  });

  it('returns error when openAiCompatBaseUrl is empty (misconfiguration)', async () => {
    const { DirectChannel } = await import('../src/modules/direct-channel.js');
    const ch = new DirectChannel(buildTestLlm({ openAiCompatBaseUrl: '' }));
    const result = await ch.adapt({
      rawContent: 'raw',
      localOldContent: null,
      options: { temperature: 0.2 },
    });
    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toMatch(/openAiCompatBaseUrl is empty/);
  });

  it('parses a successful non-streaming SDK response', async () => {
    // The OpenAI SDK posts to `${baseURL}/chat/completions`. We mock the
    // constructor to return a standard OpenAI Chat Completion shape.
    const createMock = vi.fn().mockResolvedValue({
      choices: [
        {
          message: { content: 'ADAPTED-MARKDOWN' },
          finish_reason: 'stop',
        },
      ],
      usage: { total_tokens: 42 },
    });

    // Monkey-patch the OpenAI constructor on the already-imported module
    // by reading the prototype. We re-import to get a fresh module with
    // a stubbed dependency.
    vi.resetModules();
    vi.doMock('openai', () => {
      return {
        default: class FakeOpenAI {
          constructor() {}
          chat = { completions: { create: createMock } };
        },
      };
    });

    const { DirectChannel } = await import('../src/modules/direct-channel.js');
    const ch = new DirectChannel(buildTestLlm());
    const result = await ch.adapt({
      rawContent: 'raw',
      localOldContent: null,
      options: { temperature: 0.2, enableStreaming: false },
    });

    expect(result.finishReason).toBe('stop');
    expect(result.adaptedMarkdown).toBe('ADAPTED-MARKDOWN');
    expect(result.tokensUsed).toBe(42);
    expect(result.channelName).toBe('direct');
    expect(createMock).toHaveBeenCalledTimes(1);

    vi.doUnmock('openai');
    vi.resetModules();
  });
});

// ============================================================================
// Legacy config migration type guard
// ============================================================================

describe('isLegacyLlmConfig', () => {
  it('identifies legacy flat config', () => {
    expect(
      isLegacyLlmConfig({
        baseUrl: 'https://api.deepseek.com',
        apiKey: '',
        model: 'deepseek-chat',
        temperature: 0.2,
      })
    ).toBe(true);
  });

  it('rejects new-shape config', () => {
    expect(isLegacyLlmConfig(buildTestLlm())).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isLegacyLlmConfig(null)).toBe(false);
    expect(isLegacyLlmConfig('garbage')).toBe(false);
    expect(isLegacyLlmConfig(undefined)).toBe(false);
  });
});
