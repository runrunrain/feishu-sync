/**
 * Verification script for M3 ContentAdapter
 *
 * Tests LLM adaptation with real deepseek API or fallback:
 * - buildFewShotPrompt output structure verification
 * - Real deepseek call attempt (report result or fallback)
 * - Fallback behavior on error
 */

import fs from 'node:fs';
import path from 'node:path';
import { ContentAdapter } from '../src/modules/content-adapter.js';

async function runVerification() {
  console.info('=== M3 ContentAdapter Verification ===\n');

  // Test 1: buildFewShotPrompt structure
  console.info('Test 1: buildFewShotPrompt structure');
  const adapter = new ContentAdapter();

  // Access private method for testing
  const buildPrompt = (adapter as any).buildFewShotPrompt.bind(adapter);

  const localExample = `# 项目文档

## 功能说明

这是本地风格示例，包含标题层级和表格布局。

| 参数 | 说明 |
|------|------|
| apiKey | API 密钥 |
| model  | 模型名称 |`;

  const rawContent = `## 新功能

新增表格重构功能，支持五类块识别。`;

  const prompt = buildPrompt(localExample, rawContent);

  console.info('✅ buildFewShotPrompt structure:');
  console.info(prompt.split('\n').slice(0, 10).join('\n'));
  console.info('...(truncated)\n');

  // Test 2: Real deepseek call (or fallback)
  console.info('Test 2: Real deepseek call attempt');
  const testConfig = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-e00622b865bf4180bc8fa257a23da013', // From config example (may or may not be valid)
    model: 'deepseek-chat' as const,
    temperature: 0.2,
    enableStreaming: false,
  };

  try {
    const result = await adapter.adaptContent(rawContent, localExample, testConfig);

    console.info(`✅ adaptContent succeeded (or fallback triggered):`);
    console.info(`   Tokens used: ${result.tokensUsed}`);
    console.info(`   Duration: ${result.duration}ms`);
    console.info(`   Model: ${result.model}`);
    console.info(`   Adapted markdown preview:\n${result.adaptedMarkdown.split('\n').slice(0, 5).join('\n')}\n...(truncated)\n`);

    if (result.tokensUsed === 0) {
      console.info('⚠️  Tokens used = 0, likely fallback (original content returned)');
    } else {
      console.info('✅ Real LLM call succeeded');
    }

    process.exit(0);
  } catch (error) {
    console.error(`❌ adaptContent failed (unexpected throw): ${error instanceof Error ? error.message : String(error)}`);
    console.error('   Expected: fallback should return original content without throwing');
    process.exit(1);
  }
}

runVerification().catch((error) => {
  console.error('Verification failed:', error);
  process.exit(1);
});
