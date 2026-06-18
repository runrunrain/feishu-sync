/**
 * P3 LLM channel connectivity integration test (real bigmodel calls).
 *
 * Per Task Contract R4.3 + R2.7-AC2: both channels MUST be verified
 * against the real bigmodel provider before sign-off. This script is
 * intentionally separate from the algorithm-layer vitest suite so it
 * can run on demand (it costs real tokens and hits the network).
 *
 * Run:
 *   cd server
 *   BIGMODEL_INTEGRATION=1 npx tsx scripts/llm-channels-connectivity.ts
 *
 * Env requirements (set by the user's machine, not committed):
 *   ANTHROPIC_API_KEY     bigmodel key (e.g. <id>.<secret>)
 *   ANTHROPIC_BASE_URL    bigmodel Anthropic adapter
 *                        (https://open.bigmodel.cn/api/anthropic)
 *   ANTHROPIC_MODEL       model alias (e.g. glm-4-flash)
 *
 * Verifies:
 *   1. DirectChannel (OpenAI SDK 直连 paas/v4) returns valid output.
 *   2. ClaudeCliChannel (spawn claude -p, env-inject bigmodel) returns
 *      valid output.
 * Both channels share ONE LlmConfig (the env-derived bigmodel key).
 */

import { DirectChannel } from '../src/modules/direct-channel.js';
import { ClaudeCliChannel } from '../src/modules/claude-cli-channel.js';
import type { LlmConfig } from '../src/modules/content-backend.js';

function loadConfigFromEnv(): LlmConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const anthropicBaseUrl =
    process.env.ANTHROPIC_BASE_URL || 'https://open.bigmodel.cn/api/anthropic';
  const model = process.env.ANTHROPIC_MODEL || 'glm-4-flash';
  const openAiBaseUrl = anthropicBaseUrl.replace(
    /\/api\/anthropic\/?$/,
    '/api/paas/v4'
  );

  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set; cannot run integration connectivity test.'
    );
  }

  return {
    openAiCompatBaseUrl: openAiBaseUrl,
    claudeCompatBaseUrl: anthropicBaseUrl,
    apiKey,
    model,
    // bigmodel dual-alias: glm-5.2[1m] is Anthropic-only; the OpenAI
    // paas/v4 endpoint accepts glm-4-flash (free) instead. The two
    // share ONE apiKey; only the alias differs.
    directModel: 'glm-4-flash',
    temperature: 0.2,
    primaryChannel: 'claude-cli',
    fallbackOnFailure: true,
  };
}

async function main() {
  if (process.env.BIGMODEL_INTEGRATION !== '1') {
    console.error(
      'Set BIGMODEL_INTEGRATION=1 to run this real-call connectivity test.'
    );
    process.exit(2);
  }

  const config = loadConfigFromEnv();
  console.log('--- P3 LLM Channel Connectivity Test ---');
  console.log(`openAiCompatBaseUrl: ${config.openAiCompatBaseUrl}`);
  console.log(`claudeCompatBaseUrl: ${config.claudeCompatBaseUrl}`);
  console.log(`model: ${config.model}`);
  console.log(`apiKey: ${config.apiKey.slice(0, 12)}... (redacted)`);
  console.log('');

  const results: Array<{
    channel: string;
    ok: boolean;
    durationMs?: number;
    tokensUsed?: number;
    finishReason?: string;
    errorMessage?: string;
    outputPreview?: string;
  }> = [];

  // --- DirectChannel (OpenAI SDK 直连 paas/v4) ---
  console.log('[1/2] DirectChannel (OpenAI SDK 直连 paas/v4)...');
  const direct = new DirectChannel(config);
  const directStart = Date.now();
  try {
    const directResult = await direct.adapt({
      rawContent: '## 测试表格\n\n| 名称 | 值 |\n| --- | --- |\n| A | 1 |\n| B | 2 |',
      localOldContent: null,
      options: { temperature: 0.2, enableStreaming: false, timeoutMs: 60_000 },
    });
    results.push({
      channel: 'direct',
      ok:
        (directResult.finishReason === 'stop' ||
          directResult.finishReason === 'length') &&
        directResult.adaptedMarkdown.trim().length > 0,
      durationMs: directResult.durationMs,
      tokensUsed: directResult.tokensUsed,
      finishReason: directResult.finishReason,
      errorMessage: directResult.errorMessage,
      outputPreview: directResult.adaptedMarkdown.slice(0, 200),
    });
    console.log(
      `  finishReason=${directResult.finishReason}, ` +
        `duration=${directResult.durationMs}ms, ` +
        `tokens=${directResult.tokensUsed ?? 0}`
    );
    if (directResult.errorMessage) {
      console.log(`  error: ${directResult.errorMessage}`);
    }
  } catch (err) {
    results.push({
      channel: 'direct',
      ok: false,
      durationMs: Date.now() - directStart,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    console.log(
      `  threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  console.log('');

  // --- ClaudeCliChannel (spawn claude -p, env-inject bigmodel) ---
  console.log('[2/2] ClaudeCliChannel (spawn claude -p, env-inject bigmodel)...');
  const claude = new ClaudeCliChannel(config);
  const claudeStart = Date.now();
  try {
    const claudeResult = await claude.adapt({
      rawContent: '## 测试表格\n\n| 名称 | 值 |\n| --- | --- |\n| A | 1 |\n| B | 2 |',
      localOldContent: null,
      options: { temperature: 0.2, timeoutMs: 120_000 },
    });
    results.push({
      channel: 'claude-cli',
      ok:
        (claudeResult.finishReason === 'stop' ||
          claudeResult.finishReason === 'length') &&
        claudeResult.adaptedMarkdown.trim().length > 0,
      durationMs: claudeResult.durationMs,
      tokensUsed: claudeResult.tokensUsed,
      finishReason: claudeResult.finishReason,
      errorMessage: claudeResult.errorMessage,
      outputPreview: claudeResult.adaptedMarkdown.slice(0, 200),
    });
    console.log(
      `  finishReason=${claudeResult.finishReason}, ` +
        `duration=${claudeResult.durationMs}ms, ` +
        `tokens=${claudeResult.tokensUsed ?? 0}`
    );
    if (claudeResult.errorMessage) {
      console.log(`  error: ${claudeResult.errorMessage}`);
    }
  } catch (err) {
    results.push({
      channel: 'claude-cli',
      ok: false,
      durationMs: Date.now() - claudeStart,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    console.log(
      `  threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  console.log('');

  // --- Summary ---
  console.log('--- Summary ---');
  for (const r of results) {
    console.log(
      `${r.channel.padEnd(10)} : ${r.ok ? 'PASS' : 'FAIL'} ` +
        `(${r.durationMs ?? '?'}ms, ${r.tokensUsed ?? 0} tokens, ` +
        `finishReason=${r.finishReason ?? 'throw'})`
    );
    if (!r.ok && r.errorMessage) {
      console.log(`             error: ${r.errorMessage}`);
    }
    if (r.ok && r.outputPreview) {
      console.log(`             output preview: ${r.outputPreview.slice(0, 100).replace(/\n/g, ' ')}`);
    }
  }
  console.log('');

  const allOk = results.every((r) => r.ok);
  console.log(allOk ? 'ALL CHANNELS OK' : 'SOME CHANNELS FAILED');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('Integration test crashed:', err);
  process.exit(1);
});
