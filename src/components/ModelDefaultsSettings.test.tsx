/**
 * ModelDefaultsSettings 组件测试：标准库构建设置状态行的协议警告。
 *
 * 背景（新用户默认模型构建阻断修复）：readiness 对 app-llm 不限协议，
 * 但 Pi 编排构建只接受 openai-completions。当 agent.model.source==='app-llm'
 * 且按 resolveProviderModel 等价回落（显式 providerId > activeProviderId）
 * 解析出的提供商协议非 completions 时，状态行追加警告；completions 与
 * pi-agent-dir 源不出现警告。
 *
 * SSR + hook mock（同 SyncMediaSettingsCard.test.tsx 模式）；保存链路由
 * settingsDraft 既有测试与 server 侧 kb-build-model-precheck.test.ts 覆盖。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const configHook = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useConfig', () => ({ useConfig: configHook }));
import { ModelDefaultsSettings } from './ModelDefaultsSettings';
import type { Config, LlmProviderConfig } from '../types';

function makeProvider(overrides: Partial<LlmProviderConfig> & { id: string }): LlmProviderConfig {
  return {
    name: `Provider ${overrides.id}`,
    enabled: true,
    apiKey: 'fixture-key',
    openAiCompatBaseUrl: 'https://example.invalid/v1',
    defaultModelId: 'm1',
    models: [{ id: 'm1', name: '默认预设', openAiModel: 'fixture-model', enabled: true }],
    ...overrides,
  } as LlmProviderConfig;
}

function makeConfig(options: {
  providers: LlmProviderConfig[];
  activeProviderId?: string;
  agentModel?: Record<string, unknown>;
}): Config {
  return {
    llm: {
      providers: options.providers,
      activeProviderId: options.activeProviderId ?? options.providers[0]?.id,
      activeModelId: 'm1',
      contentAdaptationEnabled: false,
    },
    agent: {
      runtime: { backend: 'pi' },
      model: { source: 'app-llm', thinkingLevel: 'off', contextWindow: 128000, maxTokens: 32768, ...(options.agentModel ?? {}) },
      maxConcurrentProcesses: 3,
      idleTimeoutMinutes: 10,
      workspaces: [],
    },
  } as unknown as Config;
}

function renderCard(config: Config): string {
  configHook.mockReturnValue({ config, updateConfig: vi.fn(), saving: false, loading: false, error: null, saveError: null, loadConfig: vi.fn(), refresh: vi.fn() });
  return renderToStaticMarkup(<ModelDefaultsSettings />);
}

const WARNING_MARKER = '标准库构建仅支持 OpenAI Chat Completions 兼容端点';

beforeEach(() => { configHook.mockReset(); });

describe('标准库构建设置协议警告', () => {
  it('app-llm + openai-responses 协议渲染警告（含协议显示名）', () => {
    const html = renderCard(makeConfig({ providers: [makeProvider({ id: 'p1', protocol: 'openai-responses' })] }));
    expect(html).toContain(WARNING_MARKER);
    expect(html).toContain('当前默认模型协议为 OpenAI Responses');
  });

  it('app-llm + anthropic-messages 协议渲染警告', () => {
    const html = renderCard(makeConfig({ providers: [makeProvider({ id: 'p1', protocol: 'anthropic-messages' })] }));
    expect(html).toContain(WARNING_MARKER);
    expect(html).toContain('当前默认模型协议为 Anthropic');
  });

  it('app-llm + openai-completions 协议不出现警告（协议缺省等价 completions）', () => {
    for (const protocol of ['openai-completions', undefined] as const) {
      const html = renderCard(makeConfig({ providers: [makeProvider({ id: 'p1', protocol: protocol as LlmProviderConfig['protocol'] })] }));
      expect(html).not.toContain(WARNING_MARKER);
    }
  });

  it('agent.model 显式 providerId 指向非 completions 提供商时按覆盖解析告警', () => {
    const html = renderCard(makeConfig({
      providers: [
        makeProvider({ id: 'p1', protocol: 'openai-completions' }),
        makeProvider({ id: 'p2', protocol: 'anthropic-messages' }),
      ],
      agentModel: { providerId: 'p2', modelId: 'm1' },
    }));
    expect(html).toContain(WARNING_MARKER);
    expect(html).toContain('当前默认模型协议为 Anthropic');
  });

  it('pi-agent-dir 源不出现协议警告', () => {
    const html = renderCard(makeConfig({
      providers: [makeProvider({ id: 'p1', protocol: 'openai-responses' })],
      agentModel: { source: 'pi-agent-dir', piModel: 'fixture/model' },
    }));
    expect(html).not.toContain(WARNING_MARKER);
    expect(html).toContain('本地 Pi · fixture/model');
  });

  it('未配置 agent 段时不渲染状态行（无警告面）', () => {
    const html = renderCard({ llm: { providers: [] } } as unknown as Config);
    expect(html).not.toContain('标准库构建设置');
    expect(html).not.toContain(WARNING_MARKER);
  });
});
