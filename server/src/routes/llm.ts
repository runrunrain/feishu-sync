/**
 * LLM Routes - Channel connectivity test (P4-T13 backend).
 *
 *   POST /api/llm/test-channel - Real LLM round-trip with a tiny prompt.
 *
 * v0.2.9 清理：claude-cli / opencode 本地无头通道移除，仅保留
 * DirectChannel（OpenAI 兼容远程端点）。请求体 channel 只接受 'direct'。
 *
 * The endpoint NEVER leaks `llm.apiKey`: errors are stringified, the
 * response shape omits the key, and the channel outputs only expose
 * `finishReason`/`durationMs`/`tokensUsed`/`model` to the caller.
 *
 * A real model round-trip may spend several minutes in a provider queue or
 * reasoning pass. Channel checks use the same configured per-document
 * tolerance as sync work (10 minutes by default), bounded at fifteen minutes.
 * Timeouts are always returned as structured `success=false`, never as a 500.
 */

import { Hono } from 'hono';
import { DirectChannel } from '../modules/direct-channel.js';
import { isSuccess, resolveActiveLlmConfig } from '../modules/content-backend.js';
import type {
  ChannelName,
  ContentBackend,
  LlmConfig,
} from '../modules/content-backend.js';

const llmRoutes = new Hono();

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const TEST_PROMPT = '请回复：ok';

/**
 * Scrub an unknown value to a short, stack-free error string. We never
 * let raw Error.stack or provider response bodies reach the API caller
 * (they may contain echo'd apiKey fragments in some 4xx bodies).
 */
function scrubError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

/**
 * Pick the channel implementation by name. We construct a fresh instance
 * per request because the body may carry an in-progress (unsaved) config
 * the user is testing; caching would bleed one request's secret into the
 * next. Channel construction is cheap (P3 verified).
 */
function buildChannel(
  name: ChannelName,
  llm: LlmConfig,
): { channel: ContentBackend; model: string } {
  const effectiveLlm = resolveActiveLlmConfig(llm);
  if (name === 'direct') {
    const model = effectiveLlm.directModel || effectiveLlm.model;
    return { channel: new DirectChannel(llm), model };
  }
  throw new Error(`unknown channel: ${name}`);
}

/**
 * Config GET intentionally masks a saved API key as `***`. The Settings UI
 * can still test an edited endpoint/model while that mask is present: only
 * the mask sentinel is replaced with the persisted secret, and the secret is
 * never returned or logged. A real user-entered key always wins.
 */
async function restoreMaskedLlmSecrets(
  rawLlm: Record<string, unknown>,
  configManager: any,
): Promise<Record<string, unknown>> {
  const rawProviders = Array.isArray(rawLlm.providers) ? rawLlm.providers : undefined;
  const needsSavedSecret = rawLlm.apiKey === '***'
    || rawProviders?.some((provider) => (
      !!provider
      && typeof provider === 'object'
      && (provider as { apiKey?: unknown }).apiKey === '***'
    ));
  if (!needsSavedSecret || typeof configManager?.load !== 'function') return rawLlm;

  try {
    const config = await configManager.load();
    const savedLlm = config?.llm;
    const savedProviders = Array.isArray(savedLlm?.providers) ? savedLlm.providers : [];
    const providers = rawProviders?.map((provider) => {
      if (!provider || typeof provider !== 'object') return provider;
      const candidate = provider as Record<string, unknown>;
      if (candidate.apiKey !== '***') return candidate;
      const id = typeof candidate.id === 'string' ? candidate.id : '';
      const saved = savedProviders.find((item: { id?: unknown }) => item.id === id);
      return {
        ...candidate,
        apiKey: typeof saved?.apiKey === 'string' ? saved.apiKey : '',
      };
    });
    return {
      ...rawLlm,
      apiKey: rawLlm.apiKey === '***' && typeof savedLlm?.apiKey === 'string'
        ? savedLlm.apiKey
        : rawLlm.apiKey,
      ...(providers ? { providers } : {}),
    };
  } catch {
    // A connectivity test should return its normal friendly configuration
    // error rather than expose a ConfigManager stack trace to the renderer.
    return rawLlm;
  }
}

llmRoutes.post('/api/llm/test-channel', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'invalid_body', message: 'expected an object' }, 400);
  }

  const channel: ChannelName | undefined = body.channel;
  if (channel !== 'direct') {
    return c.json(
      {
        error: 'invalid_body',
        message: "channel must be 'direct'（claude-cli / opencode 通道已移除）",
      },
      400,
    );
  }

  const rawLlm = body.llm;
  if (!rawLlm || typeof rawLlm !== 'object') {
    return c.json(
      { error: 'invalid_body', message: 'llm (LlmConfig) is required' },
      400,
    );
  }

  const llm = await restoreMaskedLlmSecrets(rawLlm as Record<string, unknown>, (c as any).configManager);

  // Compose a normalized LlmConfig from the partial body so the channel
  // sees a complete object even if the UI omitted optional fields.
  const llmConfig: LlmConfig = {
    openAiCompatBaseUrl: String(llm.openAiCompatBaseUrl ?? ''),
    apiKey: typeof llm.apiKey === 'string' ? llm.apiKey : '',
    model: String(llm.model ?? ''),
    directModel: typeof llm.directModel === 'string' ? llm.directModel : undefined,
    temperature:
      typeof llm.temperature === 'number' ? llm.temperature : 0.2,
    timeoutMs: typeof llm.timeoutMs === 'number' ? llm.timeoutMs : undefined,
    providers: Array.isArray(llm.providers)
      ? llm.providers as LlmConfig['providers']
      : undefined,
    activeProviderId: typeof llm.activeProviderId === 'string'
      ? llm.activeProviderId
      : undefined,
    activeModelId: typeof llm.activeModelId === 'string'
      ? llm.activeModelId
      : undefined,
  };
  const effectiveLlm = resolveActiveLlmConfig(llmConfig);

  // Validate the effective config, not just the legacy flat fields. A
  // selected provider can have its own masked API key which was restored
  // above only for this in-memory test request.
  if (effectiveLlm.apiKey.length === 0) {
    return c.json(
      {
        success: false,
        durationMs: 0,
        model: effectiveLlm.model,
        error: rawLlm.apiKey === '***'
          ? '已保存的 API Key 为空，请先在模型提供商中填写并保存'
          : 'API Key 为空，请先在模型提供商中填写后再测试',
      },
      200,
    );
  }

  // Treat connectivity testing as a real small model job, rather than a
  // browser-style ping. Respect the saved per-document tolerance and allow
  // an explicit one-off override.
  const requestedTimeout =
    typeof body.timeoutMs === 'number'
      ? body.timeoutMs
      : typeof llmConfig.timeoutMs === 'number'
        ? llmConfig.timeoutMs
        : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(500, Math.min(requestedTimeout, MAX_TIMEOUT_MS));

  try {
    const { channel: backend, model } = buildChannel(channel, llmConfig);
    const startedAt = Date.now();

    // Race the channel call against a hard timeout. Channels already
    // implement their own timeoutMs, but we add an outer guard so a
    // hung request can never block the route indefinitely.
    const result = await Promise.race([
      backend.adapt({
        rawContent: TEST_PROMPT,
        localOldContent: null,
        options: { timeoutMs, enableStreaming: false },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`timeout after ${timeoutMs}ms`)),
          timeoutMs + 500, // grace window so the channel's own timeout fires first
        ),
      ),
    ]);

    const durationMs = Date.now() - startedAt;
    const success = isSuccess(result.finishReason) && (result.adaptedMarkdown ?? '').trim().length > 0;

    return c.json({
      success,
      durationMs,
      tokensUsed: result.tokensUsed,
      model: result.model || model,
      finishReason: result.finishReason,
      // Surface a one-line error only on failure; scrub any stack/key echo.
      ...(success ? {} : { error: scrubError(result.errorMessage || `finishReason=${result.finishReason}`) }),
    });
  } catch (err) {
    const durationMs = 0; // unknown; channel did not return
    return c.json({
      success: false,
      durationMs,
      model: String(llmConfig.model ?? ''),
      error: scrubError(err),
    });
  }
});

export { llmRoutes };
