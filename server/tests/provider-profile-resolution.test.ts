import { describe, expect, it } from 'vitest';
import {
  resolveActiveLlmConfig,
  type LlmConfig,
} from '../src/modules/content-backend.js';

function baseConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    openAiCompatBaseUrl: 'https://legacy.example/openai',
    apiKey: 'legacy-key',
    model: 'legacy-model',
    directModel: 'legacy-direct',
    temperature: 0.2,
    ...overrides,
  };
}

describe('resolveActiveLlmConfig', () => {
  it('uses the selected provider and preset alias', () => {
    const resolved = resolveActiveLlmConfig(baseConfig({
      activeProviderId: 'openai-gateway',
      activeModelId: 'reasoning',
      providers: [
        {
          id: 'glm',
          name: 'GLM',
          enabled: true,
          apiKey: 'glm-key',
          openAiCompatBaseUrl: 'https://glm.example/openai',
          defaultModelId: 'default',
          models: [{
            id: 'default',
            name: 'Default',
            openAiModel: 'glm-direct',
            enabled: true,
          }],
        },
        {
          id: 'openai-gateway',
          name: 'Gateway',
          enabled: true,
          apiKey: 'gateway-key',
          openAiCompatBaseUrl: 'https://gateway.example/v1',
          defaultModelId: 'fast',
          models: [
            {
              id: 'fast',
              name: 'Fast',
              openAiModel: 'fast-direct',
              enabled: true,
            },
            {
              id: 'reasoning',
              name: 'Reasoning',
              openAiModel: 'reasoning-direct',
              enabled: true,
            },
          ],
        },
      ],
    }));

    expect(resolved.apiKey).toBe('gateway-key');
    expect(resolved.openAiCompatBaseUrl).toBe('https://gateway.example/v1');
    expect(resolved.directModel).toBe('reasoning-direct');
    expect(resolved.model).toBe('reasoning-direct');
  });

  it('falls back to a provider default preset and skips disabled providers', () => {
    const resolved = resolveActiveLlmConfig(baseConfig({
      activeProviderId: 'disabled',
      providers: [
        {
          id: 'disabled',
          name: 'Disabled',
          enabled: false,
          apiKey: 'do-not-use',
          openAiCompatBaseUrl: 'https://disabled.example/v1',
          defaultModelId: 'default',
          models: [{
            id: 'default', name: 'Default', openAiModel: 'disabled', enabled: true,
          }],
        },
        {
          id: 'enabled',
          name: 'Enabled',
          enabled: true,
          apiKey: 'enabled-key',
          openAiCompatBaseUrl: 'https://enabled.example/v1',
          defaultModelId: 'default',
          models: [{
            id: 'default', name: 'Default', openAiModel: 'enabled-direct', enabled: true,
          }],
        },
      ],
    }));

    expect(resolved.apiKey).toBe('enabled-key');
    expect(resolved.directModel).toBe('enabled-direct');
  });

  it('retains legacy fields when no provider profile exists', () => {
    const config = baseConfig({ providers: [] });
    expect(resolveActiveLlmConfig(config)).toEqual(config);
  });

  it('uses GLM canonical model IDs instead of an old capacity display suffix', () => {
    const resolved = resolveActiveLlmConfig(baseConfig({
      activeProviderId: 'bigmodel',
      activeModelId: 'glm-5',
      providers: [{
        id: 'bigmodel',
        name: '智谱 GLM',
        enabled: true,
        apiKey: 'test-key',
        openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        defaultModelId: 'glm-5',
        models: [{
          id: 'glm-5',
          name: 'GLM 5.2',
          openAiModel: 'glm-5.2[1m]',
          enabled: true,
        }],
      }],
    }));

    expect(resolved.directModel).toBe('glm-5.2');
    expect(resolved.model).toBe('glm-5.2');
  });
});
