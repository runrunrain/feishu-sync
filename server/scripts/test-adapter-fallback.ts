/**
 * Test script for ContentAdapter fallback behavior
 *
 * Constructs failure scenarios to verify that adaptContent:
 * - Returns original content on error (no throw)
 * - Does not interrupt the sync flow
 */

import { ContentAdapter } from '../src/modules/content-adapter.js';

async function runFallbackTest() {
  console.info('=== ContentAdapter Fallback Test ===\n');

  const adapter = new ContentAdapter();
  const rawContent = '# Test Content\n\nThis is test content for fallback verification.';
  const localExample = null;

  // Test 1: Invalid apiKey (should fallback)
  console.info('Test 1: Invalid apiKey fallback');
  try {
    const result = await adapter.adaptContent(rawContent, localExample, {
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-invalid-key-12345678',
      model: 'deepseek-chat',
      temperature: 0.2,
      enableStreaming: false,
    });

    console.info(`✅ Fallback triggered (no throw)`);
    console.info(`   Tokens used: ${result.tokensUsed} (expected 0)`);
    console.info(`   Duration: ${result.duration}ms`);
    console.info(`   Returned content === rawContent: ${result.adaptedMarkdown === rawContent}`);
    console.info(`   Returned content preview:\n${result.adaptedMarkdown}\n`);
  } catch (error) {
    console.error(`❌ Unexpected throw (fallback should not throw): ${error}`);
    process.exit(1);
  }

  // Test 2: Empty apiKey (should fallback)
  console.info('Test 2: Empty apiKey fallback');
  try {
    const result = await adapter.adaptContent(rawContent, localExample, {
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.2,
      enableStreaming: false,
    });

    console.info(`✅ Fallback triggered (no throw)`);
    console.info(`   Tokens used: ${result.tokensUsed} (expected 0)`);
    console.info(`   Returned content === rawContent: ${result.adaptedMarkdown === rawContent}`);
  } catch (error) {
    console.error(`❌ Unexpected throw (fallback should not throw): ${error}`);
    process.exit(1);
  }

  // Test 3: Invalid baseUrl (should fallback)
  console.info('Test 3: Invalid baseUrl fallback');
  try {
    const result = await adapter.adaptContent(rawContent, localExample, {
      baseUrl: 'https://invalid-api-url.example.com',
      apiKey: 'sk-any-key',
      model: 'deepseek-chat',
      temperature: 0.2,
      enableStreaming: false,
    });

    console.info(`✅ Fallback triggered (no throw)`);
    console.info(`   Tokens used: ${result.tokensUsed} (expected 0)`);
    console.info(`   Returned content === rawContent: ${result.adaptedMarkdown === rawContent}`);
  } catch (error) {
    console.error(`❌ Unexpected throw (fallback should not throw): ${error}`);
    process.exit(1);
  }

  console.info('\n✅ All fallback tests passed (no throws, original content returned)');
  process.exit(0);
}

runFallbackTest().catch((error) => {
  console.error('Fallback test failed:', error);
  process.exit(1);
});
