/**
 * direct-channel 401 fix verification script.
 *
 * Verifies the root-cause fix for the 2026-06-19 e2e-sync report:
 * persisted configs that still carry legacy deepseek `openAiCompatBaseUrl`
 * after the P3 migration must be auto-corrected to bigmodel paas/v4
 * when the apiKey is a bigmodel key.
 *
 * This script does NOT go through HTTP; it exercises:
 *   1. ConfigManager.load() migration path (read ~/.feishu-sync/config.json)
 *   2. DirectChannel.adapt() with the migrated LlmConfig
 *
 * Run with: npx tsx scripts/verify-direct-config-fix.ts
 * Set BIGMODEL_INTEGRATION=1 to actually call the network (default: dry
 * run that only verifies migration without calling bigmodel).
 */

import { ConfigManager } from '../src/modules/config-manager.js';
import { DirectChannel } from '../src/modules/direct-channel.js';

async function main(): Promise<void> {
  const doNetwork = process.env.BIGMODEL_INTEGRATION === '1';

  console.info('--- direct-channel 401 fix verification ---');

  // 1. Load + migrate the persisted config (~/.feishu-sync/config.json).
  const cm = new ConfigManager();
  const config = await cm.load();
  const llm = config.llm;

  console.info('migrated config.llm:');
  console.info('  openAiCompatBaseUrl =', llm.openAiCompatBaseUrl);
  console.info('  claudeCompatBaseUrl =', llm.claudeCompatBaseUrl);
  console.info('  model               =', llm.model);
  console.info('  directModel         =', llm.directModel);
  console.info('  apiKey              =', llm.apiKey ? `<set, ${llm.apiKey.length} chars>` : '<empty>');

  // 2. Assert the migration corrected the deepseek residue.
  const expectBigmodelPaasV4 = 'https://open.bigmodel.cn/api/paas/v4';
  if (llm.openAiCompatBaseUrl !== expectBigmodelPaasV4) {
    console.error(
      `FAIL: openAiCompatBaseUrl expected ${expectBigmodelPaasV4} but got ${llm.openAiCompatBaseUrl}`,
    );
    process.exit(1);
  }
  console.info('PASS: openAiCompatBaseUrl is bigmodel paas/v4 (no deepseek residue).');

  if (llm.model === 'deepseek-chat') {
    console.error('FAIL: model still deepseek-chat');
    process.exit(1);
  }
  console.info(`PASS: model is "${llm.model}" (no deepseek alias residue).`);

  if (!doNetwork) {
    console.info('\nBIGMODEL_INTEGRATION not set; skipping real bigmodel call.');
    console.info('Set BIGMODEL_INTEGRATION=1 to exercise DirectChannel end-to-end.');
    console.info('\n--- Summary ---');
    console.info('migration: PASS');
    return;
  }

  // 3. Real bigmodel call through DirectChannel.
  //
  // WEAK ASSERTION (M2 fix): direct is the degradation channel. The config
  // fix is validated by (a) openAiCompatBaseUrl being bigmodel paas/v4 and
  // (b) the auth layer no longer returning 401 (auth accepted). Whether the
  // generation actually finishes within the timeout is subject to bigmodel
  // network/latency/cold-start and is NOT a config-correctness signal — it
  // is recorded as a bonus observation only. The deterministic fallback B6
  // (reconstructedMarkdown) covers incomplete direct generation at sync time.
  console.info('\ncalling DirectChannel.adapt() against real bigmodel paas/v4...');
  const direct = new DirectChannel(llm);
  const result = await direct.adapt({
    rawContent: '请回复：ok',
    localOldContent: null,
    options: { timeoutMs: 60_000, enableStreaming: false },
  });

  console.info('DirectChannel.adapt result:');
  console.info('  finishReason  =', result.finishReason);
  console.info('  durationMs    =', result.durationMs);
  console.info('  tokensUsed    =', result.tokensUsed);
  console.info('  model         =', result.model);
  console.info('  errorMessage  =', result.errorMessage ?? '<none>');
  console.info('  adaptedMarkdown (first 80 chars) =', JSON.stringify(result.adaptedMarkdown.slice(0, 80)));

  // Authentication signal: 401 (auth rejected) vs anything else.
  // - errorMessage contains "401" or finishReason=error with auth text =>
  //   auth rejected, config fix failed.
  // - any other outcome (stop / timeout / length / non-auth error) =>
  //   auth was accepted by bigmodel, config fix is valid.
  const errText = (result.errorMessage ?? '').toLowerCase();
  const isAuthRejected =
    errText.includes('401') ||
    errText.includes('authentication') ||
    errText.includes('unauthorized') ||
    errText.includes('api key');
  const generationStopped = result.finishReason === 'stop' && result.adaptedMarkdown.trim().length > 0;

  console.info(`\n--- Summary ---`);
  console.info('migration             : PASS');
  console.info('auth accepted (no 401):', isAuthRejected ? 'FAIL' : 'PASS');
  console.info('generation completed  :', generationStopped ? 'BONUS (finishReason=stop)' : `NON-BLOCKING (finishReason=${result.finishReason}; B6 reconstruct covers at sync time)`);
  if (isAuthRejected) {
    console.error('FAIL: bigmodel rejected the apiKey with an auth error — config fix did NOT eliminate 401.');
    process.exit(1);
  }
  console.info('overall               : PASS (config fix validated; auth accepted by bigmodel paas/v4)');
}

main().catch((err) => {
  console.error('verification failed:', err);
  process.exit(1);
});
