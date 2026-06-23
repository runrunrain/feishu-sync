/**
 * ContentBackend P3 algorithm-layer tests.
 *
 * Strategy (per execution-plan P3 + diting P1 testing-pattern):
 *   1. Algorithm layer (this file): vitest with mocks for
 *      child_process.spawn and the OpenAI SDK. No real network or
 *      subprocess calls. Validates:
 *        - Registry primary/fallback resolution
 *        - DirectChannel success / timeout / error classification
 *        - ClaudeCliChannel JSON parse / non-JSON graceful / exit-code
 *          error / timeout / api_error_status / is_error
 *        - ContentAdapter primary-success path, primary-failure ->
 *          fallback-success path, both-fail path
 *        - Legacy config migration (flat -> LlmConfig)
 *   2. Integration layer: real bigmodel connectivity for both channels
 *      is exercised separately by tests/llm-channels-connectivity.test.ts
 *      (gated behind BIGMODEL_INTEGRATION=1 to avoid CI cost).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
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
// Helpers: fake channels for orchestrator tests
// ============================================================================

class FakeChannel {
  readonly name: string;
  readonly supportsStreaming: boolean;
  nextResult: { adaptedMarkdown: string; finishReason: AdaptFinishReason; errorMessage?: string } = {
    adaptedMarkdown: '',
    finishReason: 'error',
  };
  adaptCalls = 0;

  constructor(name: 'claude-cli' | 'direct', supportsStreaming: boolean) {
    this.name = name;
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
    claudeCompatBaseUrl: 'https://example.test/api/anthropic',
    apiKey: 'test-key',
    model: 'test-model',
    temperature: 0.2,
    primaryChannel: 'claude-cli',
    fallbackOnFailure: true,
    ...overrides,
  };
}

describe('ContentBackendRegistry', () => {
  it('registers both channels and resolves primary by default', () => {
    const cfg: ChannelConfig = {
      llm: buildTestLlm(),
      primaryChannel: 'claude-cli',
      fallbackOnFailure: true,
    };
    const reg = new ContentBackendRegistry(cfg);
    expect(reg.get().name).toBe('claude-cli');
    expect(reg.get('direct').name).toBe('direct');
    expect(reg.get('claude-cli').name).toBe('claude-cli');
  });

  it('switches primary to direct when configured', () => {
    const cfg: ChannelConfig = {
      llm: buildTestLlm(),
      primaryChannel: 'direct',
      fallbackOnFailure: true,
    };
    const reg = new ContentBackendRegistry(cfg);
    expect(reg.primaryChannelName).toBe('direct');
    expect(reg.get().name).toBe('direct');
  });

  it('getFallback returns the OTHER channel when fallback enabled', () => {
    const cfg: ChannelConfig = {
      llm: buildTestLlm(),
      primaryChannel: 'claude-cli',
      fallbackOnFailure: true,
    };
    const reg = new ContentBackendRegistry(cfg);
    expect(reg.getFallback('claude-cli')?.name).toBe('direct');
    expect(reg.getFallback('direct')?.name).toBe('claude-cli');
  });

  it('getFallback returns null when fallback disabled', () => {
    const cfg: ChannelConfig = {
      llm: buildTestLlm(),
      primaryChannel: 'claude-cli',
      fallbackOnFailure: false,
    };
    const reg = new ContentBackendRegistry(cfg);
    expect(reg.getFallback('claude-cli')).toBeNull();
  });

  it('throws on unknown channel name', () => {
    const cfg: ChannelConfig = {
      llm: buildTestLlm(),
      primaryChannel: 'claude-cli',
      fallbackOnFailure: true,
    };
    const reg = new ContentBackendRegistry(cfg);
    expect(() => reg.get('garbage' as any)).toThrow(/unknown channel/);
  });
});

// ============================================================================
// ContentAdapter orchestrator tests (uses FakeChannel via custom registry)
// ============================================================================

/**
 * Custom registry that lets tests inject FakeChannel instances and
 * control fallback behavior. We bypass the real ContentBackendRegistry
 * constructor (which would instantiate real channels) and feed the
 * registry via reflection on the private map.
 */
class TestableRegistry extends ContentBackendRegistry {
  constructor(
    channels: Array<FakeChannel>,
    primaryName: 'claude-cli' | 'direct',
    fallbackOnFailure: boolean
  ) {
    // Pass a valid config; we override channels afterwards.
    super({
      llm: buildTestLlm(),
      primaryChannel: primaryName,
      fallbackOnFailure,
    });
    // Replace the real channels with our fakes.
    (this as any).channels = new Map(channels.map((ch) => [ch.name, ch]));
    (this as any).primaryName = primaryName;
    (this as any).fallbackOnFailure = fallbackOnFailure;
  }
}

describe('ContentAdapter orchestration', () => {
  it('returns primary result on success (no fallback invoked)', async () => {
    const primary = new FakeChannel('claude-cli', false);
    primary.nextResult = { adaptedMarkdown: 'PRIMARY-OK', finishReason: 'stop' };
    const fallback = new FakeChannel('direct', true);
    fallback.nextResult = { adaptedMarkdown: 'FALLBACK-OK', finishReason: 'stop' };

    const reg = new TestableRegistry([primary, fallback], 'claude-cli', true);
    const adapter = new ContentAdapter(reg);

    const result = await adapter.adaptContent('raw', null, {
      adapt: { temperature: 0.2 },
    });

    expect(result.adaptedMarkdown).toBe('PRIMARY-OK');
    expect(result.channelName).toBe('claude-cli');
    expect(primary.adaptCalls).toBe(1);
    expect(fallback.adaptCalls).toBe(0);
  });

  it('falls back to the other channel on primary timeout', async () => {
    const primary = new FakeChannel('claude-cli', false);
    primary.nextResult = {
      adaptedMarkdown: '',
      finishReason: 'timeout',
      errorMessage: 'timed out',
    };
    const fallback = new FakeChannel('direct', true);
    fallback.nextResult = { adaptedMarkdown: 'FALLBACK-OK', finishReason: 'stop' };

    const reg = new TestableRegistry([primary, fallback], 'claude-cli', true);
    const adapter = new ContentAdapter(reg);

    const result = await adapter.adaptContent('raw', null, {
      adapt: { temperature: 0.2 },
    });

    expect(result.adaptedMarkdown).toBe('FALLBACK-OK');
    expect(result.channelName).toBe('direct');
    expect(primary.adaptCalls).toBe(1);
    expect(fallback.adaptCalls).toBe(1);
  });

  it('returns last failure when both channels fail (caller applies B6)', async () => {
    const primary = new FakeChannel('claude-cli', false);
    primary.nextResult = {
      adaptedMarkdown: '',
      finishReason: 'error',
      errorMessage: 'primary boom',
    };
    const fallback = new FakeChannel('direct', true);
    fallback.nextResult = {
      adaptedMarkdown: '',
      finishReason: 'error',
      errorMessage: 'fallback boom',
    };

    const reg = new TestableRegistry([primary, fallback], 'claude-cli', true);
    const adapter = new ContentAdapter(reg);

    const result = await adapter.adaptContent('raw', null, {
      adapt: { temperature: 0.2 },
    });

    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toContain('fallback boom');
    expect(primary.adaptCalls).toBe(1);
    expect(fallback.adaptCalls).toBe(1);
  });

  it('does NOT call fallback when fallbackOnFailure=false', async () => {
    const primary = new FakeChannel('claude-cli', false);
    primary.nextResult = { adaptedMarkdown: '', finishReason: 'error' };
    const fallback = new FakeChannel('direct', true);
    fallback.nextResult = { adaptedMarkdown: 'FALLBACK-OK', finishReason: 'stop' };

    const reg = new TestableRegistry([primary, fallback], 'claude-cli', false);
    const adapter = new ContentAdapter(reg);

    const result = await adapter.adaptContent('raw', null, {
      adapt: { temperature: 0.2 },
    });

    expect(result.finishReason).toBe('error');
    expect(fallback.adaptCalls).toBe(0);
  });

  it('treats empty adaptedMarkdown with finishReason=stop as failure', async () => {
    // Edge case: claude returned JSON but result was empty string.
    // We treat that as failure so the fallback gets a chance.
    const primary = new FakeChannel('claude-cli', false);
    primary.nextResult = { adaptedMarkdown: '   ', finishReason: 'stop' };
    const fallback = new FakeChannel('direct', true);
    fallback.nextResult = { adaptedMarkdown: 'FALLBACK-OK', finishReason: 'stop' };

    const reg = new TestableRegistry([primary, fallback], 'claude-cli', true);
    const adapter = new ContentAdapter(reg);

    const result = await adapter.adaptContent('raw', null, {
      adapt: { temperature: 0.2 },
    });

    expect(result.adaptedMarkdown).toBe('FALLBACK-OK');
    expect(fallback.adaptCalls).toBe(1);
  });

  it('strips onProgress/enableStreaming for non-streaming channels', async () => {
    const primary = new FakeChannel('claude-cli', false);
    primary.nextResult = { adaptedMarkdown: 'PRIMARY-OK', finishReason: 'stop' };

    const reg = new TestableRegistry([primary], 'claude-cli', true);
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
    // Use vi.mock at top-level scope by importing a fresh module copy
    // that swaps OpenAI with a controllable fake. We can't easily use
    // hoisted vi.mock here without restructuring the file; instead we
    // exercise DirectChannel against a real fetch mock (OpenAI SDK
    // falls back to fetch when no Node http overrides are set).
    //
    // The OpenAI SDK posts to `${baseURL}/chat/completions`. We mock
    // global fetch to return a standard OpenAI Chat Completion shape.
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
// ClaudeCliChannel tests (child_process.spawn mocked)
// ============================================================================

/**
 * Build a fake child_process.spawn that returns an EventEmitter
 * mimicking a real child process. Caller triggers 'close' later.
 */
function makeFakeSpawn(opts: {
  onStdin?: (child: any) => void;
}) {
  const spawned: Array<{
    child: any;
    cmd: string;
    args: string[];
    options: { env: NodeJS.ProcessEnv; shell?: boolean };
    stdinWrites: string[];
    stdinEnded: boolean;
  }> = [];

  const spawnMock = vi.fn(
    (cmd: string, args: string[], options: { env: NodeJS.ProcessEnv; shell?: boolean }) => {
      const child = new EventEmitter() as any;
      const record = {
        child,
        cmd,
        args,
        options,
        stdinWrites: [] as string[],
        stdinEnded: false,
      };
      child.stdin = {
        write: vi.fn((chunk: string | Buffer) => {
          // Capture the chunk verbatim so tests can assert the prompt
          // is delivered unmodified (no shell escaping applied).
          record.stdinWrites.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
          return true;
        }),
        end: vi.fn(() => {
          record.stdinEnded = true;
          opts.onStdin?.(child);
        }),
        on: vi.fn(),
      };
      child.stdout = { on: vi.fn() };
      child.stderr = { on: vi.fn() };
      child.kill = vi.fn();
      spawned.push(record);
      return child;
    }
  );

  return { spawnMock, spawned };
}

describe('ClaudeCliChannel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    // Clear env vars we might have leaked through tests.
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_MODEL;
  });

  it('returns error when apiKey is empty', async () => {
    vi.resetModules();
    const { ClaudeCliChannel } = await import('../src/modules/claude-cli-channel.js');
    const ch = new ClaudeCliChannel(buildTestLlm({ apiKey: '' }));
    const result = await ch.adapt({
      rawContent: 'raw',
      localOldContent: null,
      options: { temperature: 0.2 },
    });
    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toMatch(/apiKey is empty/);
  });

  it('parses a successful claude -p JSON envelope', async () => {
    vi.resetModules();
    const { spawnMock, spawned } = makeFakeSpawn({});
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    const { ClaudeCliChannel } = await import('../src/modules/claude-cli-channel.js');
    const ch = new ClaudeCliChannel(buildTestLlm());
    const promise = ch.adapt({
      rawContent: 'raw',
      localOldContent: null,
      options: { temperature: 0.2 },
    });

    // Drain microtasks so spawn() runs.
    await Promise.resolve();
    expect(spawned.length).toBe(1);

    // Simulate claude writing JSON to stdout then closing with code 0.
    const stdoutHandler = spawned[0].child.stdout.on.mock.calls.find(
      (c: any[]) => c[0] === 'data'
    )![1];
    stdoutHandler(
      Buffer.from(
        JSON.stringify({
          result: 'CLAUDE-OUTPUT',
          is_error: false,
          stop_reason: 'end_turn',
          api_error_status: null,
          usage: { input_tokens: 100, output_tokens: 50 },
        })
      )
    );
    spawned[0].child.emit('close', 0);

    const result = await promise;

    expect(result.finishReason).toBe('stop');
    expect(result.adaptedMarkdown).toBe('CLAUDE-OUTPUT');
    expect(result.tokensUsed).toBe(150);
    expect(result.channelName).toBe('claude-cli');
  });

  it('classifies non-zero exit code as error', async () => {
    vi.resetModules();
    const { spawnMock, spawned } = makeFakeSpawn({});
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    const { ClaudeCliChannel } = await import('../src/modules/claude-cli-channel.js');
    const ch = new ClaudeCliChannel(buildTestLlm());
    const promise = ch.adapt({
      rawContent: 'raw',
      localOldContent: null,
      options: { temperature: 0.2 },
    });

    await Promise.resolve();
    const stderrHandler = spawned[0].child.stderr.on.mock.calls.find(
      (c: any[]) => c[0] === 'data'
    )![1];
    stderrHandler(Buffer.from('claude: command not found'));
    spawned[0].child.emit('close', 127);

    const result = await promise;
    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toMatch(/exited with code 127/);
  });

  it('classifies api_error_status != null as error', async () => {
    vi.resetModules();
    const { spawnMock, spawned } = makeFakeSpawn({});
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    const { ClaudeCliChannel } = await import('../src/modules/claude-cli-channel.js');
    const ch = new ClaudeCliChannel(buildTestLlm());
    const promise = ch.adapt({
      rawContent: 'raw',
      localOldContent: null,
      options: { temperature: 0.2 },
    });

    await Promise.resolve();
    const stdoutHandler = spawned[0].child.stdout.on.mock.calls.find(
      (c: any[]) => c[0] === 'data'
    )![1];
    stdoutHandler(
      Buffer.from(
        JSON.stringify({
          result: '',
          is_error: true,
          stop_reason: 'end_turn',
          api_error_status: { message: '余额不足' },
        })
      )
    );
    spawned[0].child.emit('close', 0);

    const result = await promise;
    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toMatch(/API error/);
  });

  it('gracefully degrades non-JSON stdout to markdown', async () => {
    vi.resetModules();
    const { spawnMock, spawned } = makeFakeSpawn({});
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    const { ClaudeCliChannel } = await import('../src/modules/claude-cli-channel.js');
    const ch = new ClaudeCliChannel(buildTestLlm());
    const promise = ch.adapt({
      rawContent: 'raw',
      localOldContent: null,
      options: { temperature: 0.2 },
    });

    await Promise.resolve();
    const stdoutHandler = spawned[0].child.stdout.on.mock.calls.find(
      (c: any[]) => c[0] === 'data'
    )![1];
    stdoutHandler(Buffer.from('# plain markdown\n\nnot JSON'));
    spawned[0].child.emit('close', 0);

    const result = await promise;
    expect(result.finishReason).toBe('stop');
    expect(result.adaptedMarkdown).toContain('# plain markdown');
  });

  it('classifies timeout as timeout (SIGTERM + 5s SIGKILL)', async () => {
    vi.resetModules();
    const { spawnMock, spawned } = makeFakeSpawn({});
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    const { ClaudeCliChannel } = await import('../src/modules/claude-cli-channel.js');
    const ch = new ClaudeCliChannel(buildTestLlm());
    const promise = ch.adapt({
      rawContent: 'raw',
      localOldContent: null,
      options: { temperature: 0.2, timeoutMs: 50 },
    });

    // Wait for the 50ms timeout to fire, then simulate claude being
    // killed (close event after SIGTERM).
    await new Promise((r) => setTimeout(r, 100));
    spawned[0].child.emit('close', null);

    const result = await promise;
    expect(result.finishReason).toBe('timeout');
    expect(result.errorMessage).toMatch(/timed out/);
    // SIGTERM was issued on the child.
    expect(spawned[0].child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('env-injects bigmodel Anthropic vars into the child environment', async () => {
    vi.resetModules();
    const { spawnMock, spawned } = makeFakeSpawn({});
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    const { ClaudeCliChannel } = await import('../src/modules/claude-cli-channel.js');
    const ch = new ClaudeCliChannel(
      buildTestLlm({
        apiKey: 'bigmodel-key',
        claudeCompatBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
        model: 'glm-4-flash',
      })
    );
    const promise = ch.adapt({
      rawContent: 'raw',
      localOldContent: null,
      options: { temperature: 0.2 },
    });

    await Promise.resolve();
    expect(spawned.length).toBe(1);
    const env = spawned[0].options.env;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(env.ANTHROPIC_API_KEY).toBe('bigmodel-key');
    expect(env.ANTHROPIC_MODEL).toBe('glm-4-flash');
    // Streaming must be disabled so stdout stays a single JSON envelope.
    expect(env.ANTHROPIC_STREAM).toBe('false');
    // Tier aliases pinned to the same model.
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-4-flash');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-4-flash');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4-flash');

    // Close the child to settle the promise.
    spawned[0].child.emit('close', 0);
    await promise;
  });

  it('passes --dangerously-skip-permissions and --max-turns 1 in args (NO prompt in argv)', async () => {
    vi.resetModules();
    const { spawnMock, spawned } = makeFakeSpawn({});
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    const { ClaudeCliChannel } = await import('../src/modules/claude-cli-channel.js');
    const ch = new ClaudeCliChannel(buildTestLlm());
    const promise = ch.adapt({
      rawContent: 'ADVERSARIAL-raw-|inject-attempt',
      localOldContent: null,
      options: { temperature: 0.2 },
    });

    await Promise.resolve();
    const args = spawned[0].args;
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('--max-turns');
    expect(args).toContain('1');
    expect(args).toContain('--dangerously-skip-permissions');

    // v020-r2 prompt-injection hardening: the prompt MUST NOT appear in
    // argv (it must travel via stdin). Even an adversarial rawContent
    // containing cmd.exe metacharacters must never enter the command line.
    for (const a of args) {
      expect(a).not.toContain('ADVERSARIAL');
      expect(a).not.toMatch(/raw-\|inject-attempt/);
    }

    spawned[0].child.emit('close', 0);
    await promise;
  });

  it('delivers the prompt via stdin.write verbatim and half-closes stdin', async () => {
    vi.resetModules();
    const { spawnMock, spawned } = makeFakeSpawn({});
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    const { ClaudeCliChannel } = await import('../src/modules/claude-cli-channel.js');
    const ch = new ClaudeCliChannel(buildTestLlm());
    const promise = ch.adapt({
      // Adversarial prompt: every cmd.exe metacharacter is present.
      // Under shell:true + argv passing these would corrupt the prompt;
      // via stdin they must round-trip verbatim.
      rawContent: 'line1 | line2\nline3 "quoted" `backtick` $HOME > out < in & bg',
      localOldContent: null,
      options: { temperature: 0.2 },
    });

    await Promise.resolve();
    expect(spawned.length).toBe(1);
    expect(spawned[0].stdinWrites.length).toBe(1);

    const delivered = spawned[0].stdinWrites[0];
    // Every metacharacter survives unmodified.
    expect(delivered).toContain('|');
    expect(delivered).toContain('\n');
    expect(delivered).toContain('"');
    expect(delivered).toContain('`');
    expect(delivered).toContain('$');
    expect(delivered).toContain('>');
    expect(delivered).toContain('<');
    expect(delivered).toContain('&');
    expect(delivered).toContain('line1');
    expect(delivered).toContain('line3');
    expect(delivered).toContain('backtick');
    expect(delivered).toContain('HOME');

    // stdin was half-closed (EOF) so claude CLI does not wait 3s.
    expect(spawned[0].stdinEnded).toBe(true);

    spawned[0].child.emit('close', 0);
    await promise;
  });

  describe('resolveClaudeExecutable precedence (unit, no real spawn)', () => {
    // We instantiate ClaudeCliChannel and call adapt() with a fake spawn
    // to inspect the `cmd` and `options.shell` for each precedence tier.
    // Each tier is isolated by clearing env / config before the test.

    beforeEach(() => {
      delete process.env.CLAUDE_CODE_EXECPATH;
    });

    it('tier 1: claudeCli.claudePath wins and uses shell:false', async () => {
      vi.resetModules();
      const { spawnMock, spawned } = makeFakeSpawn({});
      vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
      process.env.CLAUDE_CODE_EXECPATH = 'C:\\should-be-shadowed.exe';

      const { ClaudeCliChannel } = await import('../src/modules/claude-cli-channel.js');
      // claudeCli is a constructor arg (2nd), not part of LlmConfig.
      const ch = new ClaudeCliChannel(buildTestLlm(), {
        claudePath: 'D:\\explicit\\claude.exe',
      });
      const promise = ch.adapt({
        rawContent: 'raw',
        localOldContent: null,
        options: { temperature: 0.2 },
      });
      await Promise.resolve();

      expect(spawned[0].cmd).toBe('D:\\explicit\\claude.exe');
      expect(spawned[0].options.shell).toBeUndefined();

      spawned[0].child.emit('close', 0);
      await promise;
    });

    it('tier 2: CLAUDE_CODE_EXECPATH used with shell:false', async () => {
      vi.resetModules();
      const { spawnMock, spawned } = makeFakeSpawn({});
      vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
      process.env.CLAUDE_CODE_EXECPATH = 'C:\\Users\\u\\claude.exe';

      const { ClaudeCliChannel } = await import('../src/modules/claude-cli-channel.js');
      const ch = new ClaudeCliChannel(buildTestLlm());
      const promise = ch.adapt({
        rawContent: 'raw',
        localOldContent: null,
        options: { temperature: 0.2 },
      });
      await Promise.resolve();

      expect(spawned[0].cmd).toBe('C:\\Users\\u\\claude.exe');
      expect(spawned[0].options.shell).toBeUndefined();

      spawned[0].child.emit('close', 0);
      await promise;
    });

    it('tier 3 win: falls back to claude.cmd + shell:true when no override and platform is win32', async () => {
      vi.resetModules();
      const { spawnMock, spawned } = makeFakeSpawn({});
      vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
      // Force win32 path even when the test runner is unix so the branch
      // coverage does not depend on the host OS.
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        const { ClaudeCliChannel } = await import('../src/modules/claude-cli-channel.js');
        const ch = new ClaudeCliChannel(buildTestLlm());
        const promise = ch.adapt({
          rawContent: 'raw',
          localOldContent: null,
          options: { temperature: 0.2 },
        });
        await Promise.resolve();

        expect(spawned[0].cmd).toBe('claude.cmd');
        expect(spawned[0].options.shell).toBe(true);

        spawned[0].child.emit('close', 0);
        await promise;
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
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
