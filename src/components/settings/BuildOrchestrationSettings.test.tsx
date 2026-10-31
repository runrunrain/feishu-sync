/**
 * BuildOrchestrationSettings 组件测试（T5a）—— jsdom 交互锚定：
 * 表单渲染/默认值（未配置编排字段时按后端缺省展示）、变更提交 payload
 * 形状（整体替换语义：integrator 键省略=跟随撰写、thinking 'off' 不落盘）、
 * 后端校验错误 details/消息映射到表单项、导出纯函数（并发回落/轻校验/
 * 错误提取）。useConfig 与 Toast 全 mock（AgentSettingsCard.test.tsx 同法）；
 * 草稿模式集成见 BuildOrchestrationSettings.draft.test.tsx。
 */

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useConfigMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useConfig', () => ({ useConfig: useConfigMock }));
vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));

import {
  BuildOrchestrationSettings,
  extractConfigFieldErrors,
  resolveBuildConcurrencyClient,
  validateBuildOrchestrationInput,
} from './BuildOrchestrationSettings';
import { APIError } from '../../api/client';
import type { Config, StandardKbConfig } from '../../types';

const PROVIDERS = [
  {
    id: 'vp',
    name: '示例智谱',
    enabled: true,
    apiKey: 'sk-x',
    openAiCompatBaseUrl: 'https://api.example.com/v1',
    protocol: 'openai-completions' as const,
    defaultModelId: 'glm-t',
    models: [
      { id: 'glm-t', name: 'GLM 文本', openAiModel: 'glm-4', enabled: true },
      { id: 'glm-r', name: 'GLM 推理', openAiModel: 'glm-4-plus', enabled: true, reasoning: true, thinkingLevels: ['off', 'low', 'high'] as Array<'off' | 'low' | 'high'> },
      { id: 'glm-off', name: 'GLM 停用', openAiModel: 'glm-4x', enabled: false },
    ],
  },
];

function makeStandardKb(over: Partial<StandardKbConfig> = {}): StandardKbConfig {
  return {
    outputRoot: '/tmp/standard-kb',
    retainReleases: 3,
    buildBatchSize: 10,
    promptTimeoutMinutes: 15,
    buildTimeoutMinutes: 180,
    buildParallelism: 2,
    buildBatchWordBudget: 40_000,
    autoBuildAfterSync: false,
    ...over,
  } as StandardKbConfig;
}

function makeConfig(over: { llm?: Partial<Config['llm']>; standardKb?: StandardKbConfig } = {}): Config {
  return {
    llm: {
      providers: PROVIDERS,
      activeProviderId: 'vp',
      activeModelId: 'glm-t',
      primaryChannel: 'direct',
      temperature: 0.2,
      apiKey: 'k',
      openAiCompatBaseUrl: 'https://x',
      model: 'm',
      fallbackOnFailure: false,
      ...over.llm,
    },
    standardKb: over.standardKb ?? makeStandardKb(),
    pollIntervalMinutes: 30,
    knowledgeBaseRoot: '/tmp/kb',
    watchedRoots: [],
    watchedRootUrls: [],
    requiredScopes: [],
    enableAutoStart: false,
    enableNotifications: false,
  } as Config;
}

const updateConfig = vi.fn(async (updates: unknown) => updates);
const lastPayload = () => updateConfig.mock.calls[updateConfig.mock.calls.length - 1][0] as { standardKb: StandardKbConfig };

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function setup(config: Config | null): HTMLElement {
  useConfigMock.mockReturnValue({ config, updateConfig, loading: false, error: null, saving: false, saveError: null, loadConfig: vi.fn(), refresh: vi.fn() });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => { root.render(<BuildOrchestrationSettings />); });
  return container;
}

function selectEl(container: HTMLElement, testid: string): HTMLSelectElement {
  return container.querySelector(`[data-testid="${testid}"]`) as HTMLSelectElement;
}
function radioEl(container: HTMLElement, testid: string): HTMLInputElement {
  return container.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement;
}

async function changeSelect(container: HTMLElement, testid: string, value: string) {
  const select = selectEl(container, testid);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function clickRadio(container: HTMLElement, testid: string) {
  await act(async () => { radioEl(container, testid).click(); });
}

beforeEach(() => { updateConfig.mockClear(); });
afterEach(() => {
  while (mounted.length) {
    const { root, container } = mounted.pop()!;
    act(() => { root.unmount(); });
    container.remove();
  }
});

describe('渲染与默认值（未配置编排字段 = 后端缺省行为展示）', () => {
  it('角色模型三行：跟随活跃预设（writer）/跟随活跃预设（启用编排流水，reviewer）/跟随撰写；思考档位默认关闭', () => {
    const container = setup(makeConfig());
    expect(container.innerHTML).toContain('构建编排');
    expect(container.innerHTML).toContain('跟随活跃预设（当前：示例智谱 / GLM 文本）');
    // diting F04：reviewer 空值 = 跟随活跃预设且启用编排流水，不再被误读为关闭流水
    expect(container.innerHTML).toContain('跟随活跃预设（启用编排流水；当前：示例智谱 / GLM 文本）');
    expect(container.innerHTML).toContain('跟随撰写模型（不单独设置）');
    for (const role of ['writer', 'reviewer', 'integrator']) {
      expect(selectEl(container, `orch-${role}-preset`).value).toBe('');
      expect(selectEl(container, `orch-${role}-thinking`).value).toBe('off');
    }
  });

  it('构建并发回落构建并行数、修订/重试默认 2、发布方式默认自动', () => {
    const container = setup(makeConfig());
    expect(selectEl(container, 'orch-concurrency-select').value).toBe('2');
    expect(container.innerHTML).toContain('未显式设置时按「构建并行数」2 生效');
    expect(selectEl(container, 'orch-revisions-select').value).toBe('2');
    expect(selectEl(container, 'orch-retries-select').value).toBe('2');
    expect(radioEl(container, 'orch-publish-auto').checked).toBe(true);
    expect(radioEl(container, 'orch-publish-confirm').checked).toBe(false);
    expect(container.innerHTML).toContain('未显式设置时的后端缺省行为');
  });

  it('显式配置后回显：并发 4、confirm、writer/integrator 具体预设与档位', () => {
    const container = setup(makeConfig({
      standardKb: makeStandardKb({
        buildConcurrency: 4,
        publishMode: 'confirm',
        reviewPolicy: { maxAutoRevisions: 3, maxInterfaceRetries: 0 },
        buildRoles: {
          writer: { modelPresetId: 'glm-r', providerId: 'vp', thinking: 'high' },
          reviewer: { modelPresetId: 'glm-t' },
          integrator: { modelPresetId: 'glm-t', providerId: 'vp' },
          plannerEnabled: true,
        },
      }),
    }));
    expect(selectEl(container, 'orch-concurrency-select').value).toBe('4');
    expect(radioEl(container, 'orch-publish-confirm').checked).toBe(true);
    expect(selectEl(container, 'orch-revisions-select').value).toBe('3');
    expect(selectEl(container, 'orch-retries-select').value).toBe('0');
    expect(selectEl(container, 'orch-writer-preset').value).toBe('vp::glm-r');
    expect(selectEl(container, 'orch-writer-thinking').value).toBe('high');
    expect(selectEl(container, 'orch-integrator-preset').value).toBe('vp::glm-t');
  });
});

describe('变更提交 payload 形状（PUT standardKb 段整体替换语义）', () => {
  it('writer 选择具体预设：写 modelPresetId+providerId，不写 thinking（off），保留 reviewer/plannerEnabled，无 integrator 键', async () => {
    const container = setup(makeConfig({
      standardKb: makeStandardKb({
        buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: 'glm-t', providerId: 'vp' }, plannerEnabled: true },
      }),
    }));
    await changeSelect(container, 'orch-writer-preset', 'vp::glm-r');
    const payload = lastPayload().standardKb;
    expect(payload.buildRoles).toEqual({
      writer: { modelPresetId: 'glm-r', providerId: 'vp' },
      reviewer: { modelPresetId: 'glm-t', providerId: 'vp' },
      plannerEnabled: true,
    });
    expect('integrator' in (payload.buildRoles ?? {})).toBe(false);
    expect(payload.outputRoot).toBe('/tmp/standard-kb');
    expect(payload.buildConcurrency).toBeUndefined();
  });

  it('integrator 选「跟随撰写」：payload 省略 integrator 键（整体替换移除旧覆盖）', async () => {
    const container = setup(makeConfig({
      standardKb: makeStandardKb({
        buildRoles: {
          writer: { modelPresetId: 'glm-t', providerId: 'vp' },
          reviewer: { modelPresetId: 'glm-t' },
          integrator: { modelPresetId: 'glm-r', providerId: 'vp', thinking: 'low' },
          plannerEnabled: false,
        },
      }),
    }));
    await changeSelect(container, 'orch-integrator-preset', '');
    const roles = lastPayload().standardKb.buildRoles!;
    expect('integrator' in roles).toBe(false);
    expect(roles.writer).toEqual({ modelPresetId: 'glm-t', providerId: 'vp' });
  });

  it('思考档位：选 high 写入；回落关闭时不写 thinking 键', async () => {
    const container = setup(makeConfig({
      standardKb: makeStandardKb({ buildRoles: { writer: { modelPresetId: 'glm-r', providerId: 'vp' }, reviewer: { modelPresetId: '' } } }),
    }));
    await changeSelect(container, 'orch-writer-thinking', 'high');
    expect(lastPayload().standardKb.buildRoles!.writer.thinking).toBe('high');
    await changeSelect(container, 'orch-writer-thinking', 'off');
    expect('thinking' in lastPayload().standardKb.buildRoles!.writer).toBe(false);
  });

  it('构建并发：只改目标字段，其余段保留', async () => {
    const container = setup(makeConfig());
    await changeSelect(container, 'orch-concurrency-select', '4');
    const payload = lastPayload().standardKb;
    expect(payload.buildConcurrency).toBe(4);
    // 基础配置未携带的可选段保持缺省（无变更不落盘；服务端浅合并保留现值）
    expect(payload.buildRoles).toBeUndefined();
    expect(payload.reviewPolicy).toBeUndefined();
  });

  it('审查预算：每次变更基于当前已保存配置计算（mock 静态 config，不叠加）', async () => {
    const container = setup(makeConfig());
    await changeSelect(container, 'orch-revisions-select', '3');
    expect(lastPayload().standardKb.reviewPolicy).toEqual({ maxAutoRevisions: 3, maxInterfaceRetries: 2 });
    await changeSelect(container, 'orch-retries-select', '0');
    expect(lastPayload().standardKb.reviewPolicy).toEqual({ maxAutoRevisions: 2, maxInterfaceRetries: 0 });
  });

  it('发布方式：选待确认写入 confirm；已是 auto 时再点 auto 不触发保存', async () => {
    const container = setup(makeConfig());
    await clickRadio(container, 'orch-publish-confirm');
    expect(lastPayload().standardKb.publishMode).toBe('confirm');
    const containerAuto = setup(makeConfig({ standardKb: makeStandardKb({ publishMode: 'auto' }) }));
    const calls = updateConfig.mock.calls.length;
    await clickRadio(containerAuto, 'orch-publish-auto');
    expect(updateConfig.mock.calls.length).toBe(calls);
  });
});

describe('校验错误展示', () => {
  it('后端 400 message（config_validation_failed）映射到对应表单项', async () => {
    updateConfig.mockRejectedValueOnce(new APIError(
      '配置校验失败：standardKb.buildConcurrency(out_of_range), standardKb.publishMode(invalid_value)',
      400,
      { error: 'config_validation_failed', message: '配置校验失败：standardKb.buildConcurrency(out_of_range), standardKb.publishMode(invalid_value)' },
    ));
    const container = setup(makeConfig());
    await changeSelect(container, 'orch-concurrency-select', '4');
    const alerts = [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
    expect(alerts.join('\n')).toContain('standardKb.buildConcurrency');
    expect(alerts.join('\n')).toContain('standardKb.publishMode');
  });

  it('APIError.response.details 数组形态优先映射', async () => {
    updateConfig.mockRejectedValueOnce(new APIError('配置校验失败', 400, {
      error: 'config_validation_failed',
      details: [{ field: 'standardKb.reviewPolicy.maxAutoRevisions', code: 'out_of_range' }],
    }));
    const container = setup(makeConfig());
    await changeSelect(container, 'orch-revisions-select', '2');
    expect(container.textContent).toContain('standardKb.reviewPolicy.maxAutoRevisions(out_of_range)');
  });

  it('引用的预设已删除/停用：前端轻校验内联告警 + 下拉不可用占位', () => {
    const container = setup(makeConfig({
      standardKb: makeStandardKb({
        buildRoles: { writer: { modelPresetId: 'gone', providerId: 'vp' }, reviewer: { modelPresetId: 'glm-off' } },
      }),
    }));
    expect(selectEl(container, 'orch-writer-preset').value).toBe('__missing__');
    expect(container.querySelector('[data-testid="orch-writer-error"]')?.textContent).toContain('不存在或未启用');
    // glm-off 已停用：同样视为不可引用
    expect(selectEl(container, 'orch-reviewer-preset').value).toBe('__missing__');
    expect(container.querySelector('[data-testid="orch-reviewer-error"]')?.textContent).toContain('不存在或未启用');
  });
});

describe('纯函数', () => {
  it('resolveBuildConcurrencyClient：显式优先/回落 buildParallelism/统一钳 1..8', () => {
    expect(resolveBuildConcurrencyClient({ buildConcurrency: 4, buildParallelism: 2 })).toBe(4);
    expect(resolveBuildConcurrencyClient({ buildParallelism: 3 })).toBe(3);
    expect(resolveBuildConcurrencyClient({})).toBe(2);
    expect(resolveBuildConcurrencyClient(undefined)).toBe(2);
    expect(resolveBuildConcurrencyClient({ buildConcurrency: 99 })).toBe(8);
    expect(resolveBuildConcurrencyClient({ buildConcurrency: 0 })).toBe(1);
    expect(resolveBuildConcurrencyClient({ buildParallelism: 99 })).toBe(8);
  });

  it('validateBuildOrchestrationInput：范围/枚举/预设引用；合法输入零 issue', () => {
    const presets = [{ providerId: 'vp', presetId: 'glm-t' }];
    expect(validateBuildOrchestrationInput({ standardKb: { buildConcurrency: 4, buildRoles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: 'glm-t' } }, reviewPolicy: { maxAutoRevisions: 2, maxInterfaceRetries: 0 }, publishMode: 'auto' }, presets })).toEqual([]);
    expect(validateBuildOrchestrationInput({ standardKb: { buildConcurrency: 9 }, presets })[0].field).toBe('standardKb.buildConcurrency');
    expect(validateBuildOrchestrationInput({ standardKb: { reviewPolicy: { maxAutoRevisions: 0 } }, presets })[0].field).toBe('standardKb.reviewPolicy.maxAutoRevisions');
    expect(validateBuildOrchestrationInput({ standardKb: { reviewPolicy: { maxInterfaceRetries: 6 } }, presets })[0].field).toBe('standardKb.reviewPolicy.maxInterfaceRetries');
    expect(validateBuildOrchestrationInput({ standardKb: { publishMode: 'both' as 'auto' }, presets })[0].field).toBe('standardKb.publishMode');
    const gonePreset = validateBuildOrchestrationInput({ standardKb: { buildRoles: { writer: { modelPresetId: 'gone' }, reviewer: { modelPresetId: '' } } }, presets });
    expect(gonePreset[0].field).toBe('standardKb.buildRoles.writer.modelPresetId');
    expect(validateBuildOrchestrationInput({ standardKb: { buildRoles: { writer: { modelPresetId: 'glm-t', thinking: 'ultra' as 'high' }, reviewer: { modelPresetId: '' } } }, presets })[0].field).toBe('standardKb.buildRoles.writer.thinking');
  });

  it('extractConfigFieldErrors：message 解析只回收 standardKb.*；details 数组优先', () => {
    expect(extractConfigFieldErrors(new Error('配置校验失败：standardKb.buildConcurrency(out_of_range), agent.model.source(invalid_value)')))
      .toEqual({ 'standardKb.buildConcurrency': 'standardKb.buildConcurrency(out_of_range)' });
    expect(extractConfigFieldErrors('配置校验失败：standardKb.reviewPolicy.maxAutoRevisions(out_of_range), standardKb.publishMode(invalid_value)')).toEqual({
      'standardKb.reviewPolicy.maxAutoRevisions': 'standardKb.reviewPolicy.maxAutoRevisions(out_of_range)',
      'standardKb.publishMode': 'standardKb.publishMode(invalid_value)',
    });
    const withDetails = new Error('配置校验失败');
    (withDetails as unknown as { response: unknown }).response = { details: [{ field: 'standardKb.buildRoles.writer', code: 'invalid_type' }] };
    expect(extractConfigFieldErrors(withDetails)).toEqual({ 'standardKb.buildRoles.writer': 'standardKb.buildRoles.writer(invalid_type)' });
    expect(extractConfigFieldErrors('无关错误')).toEqual({});
    expect(extractConfigFieldErrors(null)).toEqual({});
  });
});
