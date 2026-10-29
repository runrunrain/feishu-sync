/** Shared provider/preset resolution for Agent, standard KB and source adaptation. */
import type { LlmConfig, LlmProtocol } from '../types/index.js';
export interface ModelSelection { providerId?: string; modelId?: string; contextWindow?: number; maxTokens?: number; thinkingLevel?: import('../types/agent-knowledge.js').AgentThinkingLevel }
export interface ResolvedProviderModel {
  providerId: string; providerName: string; presetId: string; openAiModel: string;
  baseUrl: string; apiKey: string; protocol: LlmProtocol;
  contextWindow?: number; maxTokens?: number; reasoning?: boolean;
  thinkingLevels?: import('../types/agent-knowledge.js').AgentThinkingLevel[];
}
export function resolveProviderModel(llm: Pick<LlmConfig, 'providers' | 'activeProviderId' | 'activeModelId'>, selection: ModelSelection = {}, requiredProtocol?: LlmProtocol): ResolvedProviderModel | null {
  const providers = (llm.providers ?? []).filter((p) => p.enabled);
  const explicitProvider = selection.providerId?.trim();
  const provider = explicitProvider ? providers.find((p) => p.id === explicitProvider)
    : providers.find((p) => p.id === llm.activeProviderId) ?? providers[0];
  if (!provider) return null;
  const protocol = requiredProtocol ?? provider.protocol ?? 'openai-completions';
  const baseUrl = provider.protocolBaseUrls?.[protocol]?.trim() || (protocol === (provider.protocol ?? 'openai-completions') ? provider.openAiCompatBaseUrl.trim() : '');
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(protocol)) return null;
  const models = provider.models.filter((m) => m.enabled && m.openAiModel.trim());
  const explicitModel = selection.modelId?.trim();
  const preset = explicitModel ? models.find((m) => m.id === explicitModel)
    : models.find((m) => m.id === (provider.id === llm.activeProviderId ? llm.activeModelId : ''))
      ?? models.find((m) => m.id === provider.defaultModelId) ?? models[0];
  if (!preset) return null;
  const id = preset.openAiModel.trim();
  return { providerId: provider.id, providerName: provider.name, presetId: preset.id,
    openAiModel: /^glm-/i.test(id) ? id.replace(/\s*\[[^\]]+\]$/, '') : id,
    baseUrl, apiKey: provider.apiKey.trim(), protocol,
    contextWindow: preset.contextWindow, maxTokens: preset.maxTokens, reasoning: preset.reasoning, thinkingLevels: preset.thinkingLevels };
}

export function providerModelParameters(model: Pick<ResolvedProviderModel, 'contextWindow' | 'maxTokens' | 'reasoning'>, defaults: ModelSelection = {}) {
  const contextWindow = model.contextWindow ?? defaults.contextWindow ?? 128000;
  return { contextWindow, maxTokens: Math.min(model.maxTokens ?? defaults.maxTokens ?? 8192, contextWindow), reasoning: model.reasoning ?? false };
}
