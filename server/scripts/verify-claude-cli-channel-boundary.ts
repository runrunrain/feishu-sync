/**
 * Boundary prompt verification for spawn EINVAL fix + v020-r2 stdin hardening.
 *
 * Validates ClaudeCliChannel.adapt() end-to-end against real bigmodel
 * when the prompt contains markdown special characters (newlines, pipe
 * table delimiters, quotes, backticks, dollar signs). The prompt is
 * delivered via STDIN (not argv), so cmd.exe metacharacters are inert
 * even when spawn runs with shell:true on the .cmd fallback path.
 *
 * Run standalone with real provider env:
 *   cd server && npx tsx scripts/verify-claude-cli-channel-boundary.ts
 *
 * To exercise the .cmd + shell:true fallback explicitly, unset the
 * launcher-injected env before running:
 *   cmd /c "set CLAUDE_CODE_EXECPATH= && npx tsx scripts/verify-claude-cli-channel-boundary.ts"
 */

import { ClaudeCliChannel } from '../src/modules/claude-cli-channel.js';
import type { LlmConfig } from '../src/modules/content-backend.js';

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    console.log('SKIP: ANTHROPIC_API_KEY not set');
    return;
  }

  const llm: LlmConfig = {
    openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    claudeCompatBaseUrl: process.env.ANTHROPIC_BASE_URL || 'https://open.bigmodel.cn/api/anthropic',
    apiKey,
    model: process.env.ANTHROPIC_MODEL || 'glm-5.2[1m]',
    temperature: 0.2,
    primaryChannel: 'claude-cli',
    fallbackOnFailure: true,
  };

  // Prompt intentionally contains newlines, pipe table chars, quotes,
  // backticks, dollar signs, and cmd.exe metacharacters (&, <, >) —
  // verifies stdin delivery preserves every byte regardless of the
  // spawn path (.exe direct or .cmd + shell:true fallback).
  const rawContent =
    '# 测试\n\n包含 | 表格 | 分隔符\n| A | B |\n|---|---|\n| 1 | 2 |\n\n含双引号 "和单引号\'\n含反引号 `code` 和美元 $HOME 和管道符 | 与大于 > 小于 < 和 & 符号';

  const ch = new ClaudeCliChannel(llm);
  const out = await ch.adapt({
    rawContent,
    localOldContent: null,
    options: { temperature: 0.2, timeoutMs: 300_000 },
  });

  console.log('finishReason    :', out.finishReason);
  console.log('durationMs      :', out.durationMs);
  console.log('tokensUsed      :', out.tokensUsed);
  console.log('errorMessage    :', out.errorMessage);
  console.log('adaptedMarkdown :');
  console.log('--- begin ---');
  console.log(out.adaptedMarkdown.slice(0, 800));
  console.log('--- end ---');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
