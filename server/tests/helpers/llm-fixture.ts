/**
 * 测试辅助：构造 LlmConfig fixture（不含真实 key）。
 */

import type { LlmConfig } from '../src/types/index.js';

export function buildDefaultLlmConfigForTest(): LlmConfig {
  return {
    openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4-flash',
    directModel: 'glm-4-flash',
    temperature: 0.2,
    providers: [
      {
        id: 'bigmodel',
        name: '智谱 GLM',
        enabled: true,
        apiKey: '',
        openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        defaultModelId: 'default',
        models: [{ id: 'default', name: '默认', openAiModel: 'glm-4-flash', enabled: true }],
      },
      {
        id: 'second',
        name: '第二提供商',
        enabled: true,
        apiKey: '',
        openAiCompatBaseUrl: 'https://example.com/v1',
        defaultModelId: 'm2',
        models: [
          { id: 'm2', name: 'GLM 4.6', openAiModel: 'glm-4.6', enabled: true },
          { id: 'm3', name: '禁用', openAiModel: 'glm-x', enabled: false },
        ],
      },
    ],
    activeProviderId: 'bigmodel',
    activeModelId: 'default',
    timeoutMs: 600_000,
    contentAdaptationEnabled: false,
    primaryChannel: 'direct',
    fallbackOnFailure: false,
  };
}
