/**
 * Verify: /api/llm/test-channel uses 30s default timeout (no longer 3s).
 *
 * Boots a standalone buildServer on port 3099, then POSTs a test-channel
 * request with a body that has NO timeoutMs field (so the route applies
 * DEFAULT_TIMEOUT_MS). We assert the route handler accepts the request
 * and either:
 *   - returns success=true (channel actually worked), or
 *   - returns success=false with a provider error (NOT a "timeout after 3000ms"
 *     style error — that would indicate the 3s default is still in place).
 *
 * Key assertion: the response error must NOT contain "timeout after 3000ms"
 * or any sub-30s timeout signature.
 *
 * Usage: npx tsx scripts/verify-channel-test-timeout.ts
 */
import { buildServer, startServer } from '../src/index.js';

const PORT = 3099;
const TOKEN = 'verify-channel-test-timeout-token';

interface TestResult {
  success: boolean;
  durationMs: number;
  model: string;
  error?: string;
  finishReason?: string;
  tokensUsed?: number;
}

async function main() {
  console.info('[verify] starting buildServer on port', PORT);
  const started = await startServer({
    desktopMode: true,
    desktopToken: TOKEN,
    corsDevMode: true,
    port: PORT,
    hostname: '127.0.0.1',
  });
  console.info('[verify] server up at', started.url);

  // Read config to obtain the real llm + claudeCli config the user has saved.
  // We hit /api/config (auth-protected) using our token.
  const cfgRes = await fetch(`${started.url}/api/config`, {
    headers: { 'X-Desktop-Token': TOKEN },
  });
  if (!cfgRes.ok) {
    console.error('[verify] config fetch failed:', cfgRes.status, await cfgRes.text());
    await started.close();
    process.exit(2);
  }
  const cfg: any = await cfgRes.json();
  const llm = cfg.llm;
  const claudeCli = cfg.claudeCli;
  if (!llm || typeof llm.apiKey !== 'string' || llm.apiKey.length === 0) {
    console.error('[verify] no llm.apiKey in saved config; aborting');
    await started.close();
    process.exit(3);
  }
  console.info('[verify] got llm config (apiKey len=', llm.apiKey.length, ')');

  const channels: Array<'claude-cli' | 'direct'> = ['claude-cli', 'direct'];
  const results: Record<string, TestResult & { observedTimeoutSignature: boolean }> = {};

  for (const ch of channels) {
    console.info('\n[verify] === testing channel:', ch, '===');
    const t0 = Date.now();
    const r = await fetch(`${started.url}/api/llm/test-channel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Desktop-Token': TOKEN,
      },
      body: JSON.stringify({ channel: ch, llm, claudeCli }),
    });
    const elapsed = Date.now() - t0;
    const body = (await r.json()) as TestResult;
    console.info('[verify] status', r.status, 'elapsed', elapsed, 'ms');
    console.info('[verify] body', JSON.stringify(body, null, 2));

    // Detect 3s-timeout signature: error mentions "timeout after 3000ms"
    // or elapsed < 3500ms with a timeout error.
    const err = body.error ?? '';
    const has3sSig =
      err.includes('timeout after 3000ms') ||
      err.includes('timeout after 3000 ms') ||
      (/timeout/i.test(err) && elapsed < 3500);

    results[ch] = { ...body, observedTimeoutSignature: has3sSig };

    if (has3sSig) {
      console.error('[verify] FAIL:', ch, 'still shows 3s timeout signature');
    } else {
      console.info('[verify] PASS:', ch, 'no 3s-timeout signature (good)');
    }
  }

  await started.close();
  console.info('\n[verify] server closed');

  // Final verdict.
  const claudeFail = results['claude-cli']?.observedTimeoutSignature === true;
  const directFail = results['direct']?.observedTimeoutSignature === true;
  if (claudeFail || directFail) {
    console.error('\n[verify] OVERALL FAIL: at least one channel still shows 3s timeout');
    process.exit(1);
  }
  console.info('\n[verify] OVERALL PASS: no 3s-timeout signature on either channel');
  process.exit(0);
}

main().catch((err) => {
  console.error('[verify] unexpected error:', err);
  process.exit(99);
});
