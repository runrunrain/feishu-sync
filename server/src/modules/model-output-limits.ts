/** Local hints for blank model preset output limits. Explicit preset values win. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/** Exact API model IDs only. Keep entries tied to a vendor model specification. */
export const VERIFIED_MODEL_OUTPUT_LIMITS: Readonly<Record<string, { maxTokens: number; source: string }>> = {
  'gpt-4.1': { maxTokens: 32_768, source: 'https://developers.openai.com/api/docs/models/gpt-4.1' },
  'gpt-4.1-mini': { maxTokens: 32_768, source: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini' },
  'gpt-5.1': { maxTokens: 128_000, source: 'https://developers.openai.com/api/docs/models/gpt-5.1' },
  'gpt-5.2': { maxTokens: 128_000, source: 'https://developers.openai.com/api/docs/models/gpt-5.2' },
  'gpt-5-mini': { maxTokens: 128_000, source: 'https://developers.openai.com/api/docs/models/gpt-5-mini' },
  'claude-sonnet-4-6': { maxTokens: 128_000, source: 'https://platform.claude.com/docs/en/models/sonnet-4-6/overview' },
  'claude-sonnet-5': { maxTokens: 128_000, source: 'https://platform.claude.com/docs/en/models/overview' },
  'claude-haiku-4-5': { maxTokens: 65_536, source: 'https://platform.claude.com/docs/en/models/haiku-4-5/overview' },
  'gemini-2.5-pro': { maxTokens: 65_536, source: 'https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro' },
  'gemini-2.5-flash': { maxTokens: 65_536, source: 'https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash' },
  'gemini-3.1-pro-preview': { maxTokens: 65_536, source: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview' },
};

export function suggestedMaxOutputTokens(modelCode: string): number {
  return VERIFIED_MODEL_OUTPUT_LIMITS[modelCode.trim().toLowerCase()]?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}
