/**
 * BuildOrchestrationSettings 草稿集成测试（T5a）—— 设置页统一草稿链路：
 * 卡内修改（radio/下拉）只进草稿（api.save 不触发），顶部「保存」统一提交，
 * 且 outbound 携带完整 standardKb 段（服务端对子对象整体替换，需全量）。
 * 模式对齐 AgentBackendSettingsDraft.test.tsx（mock api/client，真草稿 Provider）。
 */

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock('../../api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/client')>(),
  getConfig: api.get,
  saveConfig: api.save,
}));
vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));

import { SettingsDraftProvider, useSettingsDraft } from '../../hooks/settingsDraft';
import { BuildOrchestrationSettings } from './BuildOrchestrationSettings';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Save() {
  const draft = useSettingsDraft()!;
  return <button onClick={() => void draft.save()}>总保存</button>;
}

/** 服务端 GET 形态（normalize 后编排段已物化；providers 供预设下拉）。 */
function serverConfig() {
  return {
    llm: {
      providers: [{
        id: 'vp', name: '示例智谱', enabled: true, apiKey: 'sk-x',
        openAiCompatBaseUrl: 'https://api.example.com/v1', protocol: 'openai-completions',
        defaultModelId: 'glm-t',
        models: [
          { id: 'glm-t', name: 'GLM 文本', openAiModel: 'glm-4', enabled: true },
          { id: 'glm-r', name: 'GLM 推理', openAiModel: 'glm-4-plus', enabled: true, reasoning: true, thinkingLevels: ['off', 'low', 'high'] },
        ],
      }],
      activeProviderId: 'vp', activeModelId: 'glm-t', primaryChannel: 'direct',
      temperature: 0.2, apiKey: 'k', openAiCompatBaseUrl: 'https://x', model: 'm', fallbackOnFailure: false,
    },
    standardKb: {
      outputRoot: '/tmp/standard-kb', retainReleases: 3, buildBatchSize: 10,
      buildBatchWordBudget: 40_000, promptTimeoutMinutes: 15, buildTimeoutMinutes: 180,
      buildParallelism: 2, buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: '' }, plannerEnabled: false },
      reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 2 }, publishMode: 'auto', autoBuildAfterSync: false,
    },
    pollIntervalMinutes: 30, knowledgeBaseRoot: '/tmp/kb', watchedRoots: [], watchedRootUrls: [],
    requiredScopes: [], enableAutoStart: false, enableNotifications: false,
  };
}

it('卡内修改先进草稿，总保存提交完整 standardKb 段（含未变更基础字段）', async () => {
  const config = serverConfig();
  api.get.mockReset().mockResolvedValue(structuredClone(config));
  api.save.mockReset().mockImplementation(async (patch: { standardKb?: Record<string, unknown> }) => ({
    ...config, standardKb: patch.standardKb,
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SettingsDraftProvider><Save /><BuildOrchestrationSettings /></SettingsDraftProvider>));
    const concurrency = container.querySelector('[data-testid="orch-concurrency-select"]') as HTMLSelectElement;
    expect(concurrency.value).toBe('2'); // 未显式设置 → 回落 buildParallelism
    await act(async () => {
      concurrency.value = '4';
      concurrency.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { (container.querySelector('[data-testid="orch-publish-confirm"]') as HTMLInputElement).click(); });
    // 只进草稿：尚未提交
    expect(api.save).not.toHaveBeenCalled();
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === '总保存')!.click();
    });
    expect(api.save).toHaveBeenCalledTimes(1);
    const outbound = api.save.mock.calls[0][0] as { standardKb: Record<string, unknown> };
    expect(Object.keys(outbound)).toEqual(['standardKb']);
    expect(outbound.standardKb.buildConcurrency).toBe(4);
    expect(outbound.standardKb.publishMode).toBe('confirm');
    // 完整段：未变更的基础字段一并携带（服务端整体替换语义）
    expect(outbound.standardKb.outputRoot).toBe('/tmp/standard-kb');
    expect(outbound.standardKb.reviewPolicy).toEqual({ maxAutoRevisions: 2, maxInterfaceRetries: 2 });
    expect(outbound.standardKb.buildParallelism).toBe(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
