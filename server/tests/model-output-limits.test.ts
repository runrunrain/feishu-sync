import { describe, expect, it } from 'vitest';
import { providerModelParameters } from '../src/modules/model-selection.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, suggestedMaxOutputTokens, VERIFIED_MODEL_OUTPUT_LIMITS } from '../src/modules/model-output-limits.js';
import { DEFAULT_AGENT_MODEL_CONFIG } from '../src/types/agent-knowledge.js';

describe('blank preset output limits', () => {
  it('uses an exact verified model ID, otherwise 32768', () => {
    expect(DEFAULT_AGENT_MODEL_CONFIG.maxTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(suggestedMaxOutputTokens('gemini-2.5-flash')).toBe(65_536);
    expect(suggestedMaxOutputTokens('gpt-5.2')).toBe(128_000);
    expect(suggestedMaxOutputTokens('claude-haiku-4-5')).toBe(65_536);
    expect(suggestedMaxOutputTokens('claude-sonnet-5')).toBe(128_000);
    expect(suggestedMaxOutputTokens('glm-5.3')).toBe(131_072);
    expect(suggestedMaxOutputTokens('glm-5.3-flash')).toBe(131_072);
    expect(suggestedMaxOutputTokens('gpt-5.2-proxy')).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(Object.values(VERIFIED_MODEL_OUTPUT_LIMITS).every((entry) => entry.source.startsWith('https://'))).toBe(true);
  });

  it('preserves explicit limits and clamps defaults to the context window', () => {
    expect(providerModelParameters({ openAiModel: 'gemini-2.5-pro', contextWindow: 200_000 }).maxTokens).toBe(65_536);
    expect(providerModelParameters({ openAiModel: 'gemini-2.5-pro', contextWindow: 200_000, maxTokens: 12_000 }).maxTokens).toBe(12_000);
    expect(providerModelParameters({ openAiModel: 'unknown', contextWindow: 16_000 }).maxTokens).toBe(16_000);
    expect(providerModelParameters({ openAiModel: 'gemini-2.5-pro', contextWindow: 200_000 }, { maxTokens: 8_192 }).maxTokens).toBe(8_192);
  });
});
