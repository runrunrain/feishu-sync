/**
 * LLM Routes - Channel connectivity test (P4-T13 backend).
 *
 *   POST /api/llm/test-channel - Real LLM round-trip with a tiny prompt.
 *
 * Wraps the P3 ContentBackend channels (ClaudeCliChannel + DirectChannel)
 * with a short timeout and returns a structured, stack-scrubbed result.
 * The endpoint NEVER leaks `llm.apiKey`: errors are stringified, the
 * response shape omits the key, and the channel outputs only expose
 * `finishReason`/`durationMs`/`tokensUsed`/`model` to the caller.
 *
 * Contract mirrors src/api/client.ts (洛神 P4-2 ChannelTestRequest /
 * ChannelTestResult). The route accepts the full ChannelTestRequest body
 * (channel + llm + optional claudeCli) and constructs the channel on
 * demand; this lets the UI test a config the user has NOT yet saved
 * (e.g. mid-edit), without persisting anything.
 *
 * Default timeout is 30s. claude-cli cold start (spawn claude + bigmodel
 * upstream round-trip) realistically takes 10-60s, so we cap at 60s and
 * surface timeouts as a structured `success=false` (not a 500).
 */

import { Hono } from 'hono';
import { ClaudeCliChannel } from '../modules/claude-cli-channel.js';
import { DirectChannel } from '../modules/direct-channel.js';
import { isSuccess } from '../modules/content-backend.js';
import type {
  ChannelName,
  LlmConfig,
} from '../modules/content-backend.js';

const llmRoutes = new Hono();

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
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
  claudeCli?: { claudePath?: string; extraArgs?: string[] },
): { channel: ClaudeCliChannel | DirectChannel; model: string } {
  if (name === 'claude-cli') {
    const model = llm.claudeCliModel || llm.model;
    return { channel: new ClaudeCliChannel(llm, claudeCli), model };
  }
  if (name === 'direct') {
    const model = llm.directModel || llm.model;
    return { channel: new DirectChannel(llm), model };
  }
  throw new Error(`unknown channel: ${name}`);
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
  if (channel !== 'claude-cli' && channel !== 'direct') {
    return c.json(
      {
        error: 'invalid_body',
        message: "channel must be 'claude-cli' or 'direct'",
      },
      400,
    );
  }

  const llm = body.llm;
  if (!llm || typeof llm !== 'object') {
    return c.json(
      { error: 'invalid_body', message: 'llm (LlmConfig) is required' },
      400,
    );
  }

  // Validate the minimal LlmConfig shape without echoing it back.
  if (typeof llm.apiKey !== 'string' || llm.apiKey.length === 0) {
    return c.json(
      {
        success: false,
        durationMs: 0,
        model: String(llm.model ?? ''),
        error: 'apiKey is empty (configure llm.apiKey before testing)',
      },
      200, // 200 with success=false so the UI renders a friendly Toast
    );
  }

  // Compose a normalized LlmConfig from the partial body so the channel
  // sees a complete object even if the UI omitted optional fields.
  const llmConfig: LlmConfig = {
    openAiCompatBaseUrl: String(llm.openAiCompatBaseUrl ?? ''),
    claudeCompatBaseUrl: String(llm.claudeCompatBaseUrl ?? ''),
    apiKey: String(llm.apiKey),
    model: String(llm.model ?? ''),
    directModel: typeof llm.directModel === 'string' ? llm.directModel : undefined,
    claudeCliModel:
      typeof llm.claudeCliModel === 'string' ? llm.claudeCliModel : undefined,
    temperature:
      typeof llm.temperature === 'number' ? llm.temperature : 0.2,
  };

  const claudeCli =
    body.claudeCli && typeof body.claudeCli === 'object'
      ? {
          claudePath:
            typeof body.claudeCli.claudePath === 'string'
              ? body.claudeCli.claudePath
              : undefined,
          extraArgs: Array.isArray(body.claudeCli.extraArgs)
            ? body.claudeCli.extraArgs.filter((a: unknown) => typeof a === 'string')
            : [],
        }
      : undefined;

  // Default 30s; honor caller override up to MAX_TIMEOUT_MS.
  const requestedTimeout =
    typeof body.timeoutMs === 'number' ? body.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(500, Math.min(requestedTimeout, MAX_TIMEOUT_MS));

  try {
    const { channel: backend, model } = buildChannel(channel, llmConfig, claudeCli);
    const startedAt = Date.now();

    // Race the channel call against a hard timeout. Channels already
    // implement their own timeoutMs, but we add an outer guard so a
    // hung spawn can never block the request indefinitely.
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
