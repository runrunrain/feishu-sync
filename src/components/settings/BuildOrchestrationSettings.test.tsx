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
const apiRuntime = vi.hoisted(() => ({ getKbBuildRuntimeStatus: vi.fn(), installKbBuildRuntime: vi.fn() }));
vi.mock('../../hooks/useConfig', () => ({ useConfig: useConfigMock }));
vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock('../../api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/client')>(),
  getKbBuildRuntimeStatus: apiRuntime.getKbBuildRuntimeStatus,
  installKbBuildRuntime: apiRuntime.installKbBuildRuntime,
}));

import {
  BuildOrchestrationSettings,
  extractConfigFieldErrors,
  resolveBuildConcurrencyClient,
  splitInstallErrorMessage,
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

beforeEach(() => {
  updateConfig.mockClear();
  // v2 运行宿主默认「未接线 503」（旧用例不受影响：如实展示说明行）。
  apiRuntime.getKbBuildRuntimeStatus.mockReset().mockRejectedValue(new APIError('构建运行宿主未接线（服务端未完成集成）', 503, { error: 'build_runtime_unavailable' }));
  apiRuntime.installKbBuildRuntime.mockReset();
});
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

describe('Pi 编排固定入口', () => {
  it('设置卡不显示编排模式选择，也不提示废弃模式', () => {
    const container = setup(makeConfig());
    expect(container.querySelector('[data-testid="orch-mode-section"]')).toBeNull();
    expect(container.querySelector('[name="kb-orchestration-mode"]')).toBeNull();
    expect(container.textContent).not.toContain('标准流水');
    expect(container.textContent).not.toContain('Claude 原生');
  });

  it.each(['legacy', 'claude-native'] as const)('旧配置 %s 改其他构建设置时强制写 Pi', async (mode) => {
    const container = setup(makeConfig({ standardKb: makeStandardKb({ orchestrationMode: mode }) }));
    await changeSelect(container, 'orch-concurrency-select', '4');
    expect(lastPayload().standardKb.buildConcurrency).toBe(4);
    expect(lastPayload().standardKb.orchestrationMode).toBe('pi-amagi');
  });
});

describe('v2 运行宿主状态与安装（真实 GET/POST /api/kb/build-runtime*）', () => {
  const makeStatus = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    orchestrationMode: 'legacy',
    runtime: { nodePath: '/usr/local/bin/node', nodeVersion: null, piCliPath: '/usr/local/bin/pi', piVersion: '1.4.0' },
    amagi: { pinnedVersion: '2.21.31', installed: true, version: '2.21.31', installDir: '/data/agent/runtime-packages/amagi-pi@2.21.31', contentHash: 'abc123', layout: null },
    probe: {
      staticOk: true, fullyVerified: false,
      checks: [
        { id: 'extension-load', title: '扩展加载', kind: 'static', state: 'pass', detail: '' },
        { id: 'cancel', title: '取消残留', kind: 'measured', state: 'not-measured', detail: '待实测' },
      ],
    },
    error: null,
    ...over,
  });

  it('503 未接线：如实展示说明行，不渲染安装入口，不声称可用', async () => {
    const container = setup(makeConfig());
    await act(async () => {});
    expect(container.querySelector('[data-testid="orch-runtime-unwired"]')?.textContent)
      .toContain('未接线');
    expect(container.querySelector('[data-testid="orch-runtime-install"]')).toBeNull();
  });

  it('正常状态：Pi/amagi 固定版本/已安装回显；staticOk 与 fullyVerified 分开呈现不混清', async () => {
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(makeStatus());
    const container = setup(makeConfig());
    await act(async () => {});
    const facts = container.querySelector('[data-testid="orch-runtime-facts"]');
    expect(facts?.textContent).toContain('1.4.0');
    expect(facts?.textContent).toContain('2.21.31');
    expect(facts?.textContent).toContain('已安装');
    expect(facts?.textContent).toContain('静态检查通过');
    expect(facts?.textContent).toContain('完整验证未达'); // 不把 staticOk 冒充 fullyVerified
    await act(async () => { (container.querySelector('[data-testid="orch-runtime-checks-toggle"]') as HTMLElement).click(); });
    const checks = container.querySelector('[data-testid="orch-runtime-checks"]');
    expect(checks?.textContent).toContain('扩展加载');
    expect(checks?.textContent).toContain('未实测'); // 实测项如实标注
  });

  it('未安装：安装入口可见；安装成功后刷新状态并提示完整启用另需实测验收', async () => {
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(makeStatus({
      amagi: { pinnedVersion: '2.21.31', installed: false, version: null, installDir: null, contentHash: null, layout: null },
    }));
    apiRuntime.installKbBuildRuntime.mockResolvedValue({ installed: true, fresh: true, version: '2.21.31', installDir: '/data/x', contentHash: 'abc' });
    const container = setup(makeConfig());
    await act(async () => {});
    const btn = container.querySelector('[data-testid="orch-runtime-install-btn"]') as HTMLButtonElement;
    expect(btn.textContent).toContain('安装 amagi-pi 2.21.31');
    await act(async () => { btn.click(); });
    expect(apiRuntime.installKbBuildRuntime).toHaveBeenCalledWith({});
    // 安装成功后重拉状态。
    expect(apiRuntime.getKbBuildRuntimeStatus).toHaveBeenCalledTimes(2);
  });

  it('sourceDir 透传：手输绝对路径随安装请求携带；失败如实展示服务端消息', async () => {
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(makeStatus());
    apiRuntime.installKbBuildRuntime.mockRejectedValue(new APIError('sourceDir 必须是指向本地 amagi-pi 包根的绝对路径', 400, { error: 'invalid_request' }));
    const container = setup(makeConfig());
    await act(async () => {});
    const input = container.querySelector('[data-testid="orch-runtime-source-dir"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '/Users/x/amagi-pi');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (container.querySelector('[data-testid="orch-runtime-install-btn"]') as HTMLElement).click(); });
    expect(apiRuntime.installKbBuildRuntime).toHaveBeenCalledWith({ sourceDir: '/Users/x/amagi-pi' });
    expect(container.querySelector('[data-testid="orch-runtime-install-error"]')?.textContent)
      .toContain('sourceDir 必须是指向本地 amagi-pi 包根的绝对路径');
  });

  it('探测失败（非 503）：如实展示错误行', async () => {
    apiRuntime.getKbBuildRuntimeStatus.mockRejectedValue(new APIError('探测执行失败', 500, { error: 'build_runtime_probe_failed' }));
    const container = setup(makeConfig());
    await act(async () => {});
    expect(container.querySelector('[data-testid="orch-runtime-error"]')?.textContent).toContain('探测执行失败');
  });

  it('可信提醒：插件为受信 Node 代码非 OS 沙箱；安装可用 ≠ 验收全过', async () => {
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(makeStatus());
    const container = setup(makeConfig());
    await act(async () => {});
    const text = container.querySelector('[data-testid="orch-runtime-install"]')?.textContent ?? '';
    expect(text).toContain('不是 OS 沙箱');
    expect(text).toContain('不等于质量/恢复/性能验收全部通过');
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

// ---------------------------------------------------------------------------
// plugin-install-fix：构建固定版本 vs 全局/应用候选的诚实呈现；默认安装来源、
// 目录选择桥接、错误折叠与刷新清错。splitInstallErrorMessage 导出锚定。
// ---------------------------------------------------------------------------

describe('plugin-install-fix 安装检测与默认来源', () => {
  const COMMIT = '929000ecbd8725e72b191493345d6abeef51c147';
  // 上一 describe 的 makeStatus 是块级作用域；此处独立组一个完整状态工厂。
  const makeLocalStatus = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    orchestrationMode: 'legacy',
    runtime: { nodePath: '/usr/local/bin/node', nodeVersion: null, piCliPath: '/usr/local/bin/pi', piVersion: '1.4.0' },
    probe: { staticOk: true, fullyVerified: false, checks: [] },
    error: null,
    ...over,
  });
  const amagiBase = (over: Record<string, unknown> = {}) => ({
    pinnedVersion: '2.21.31', installed: true, version: '2.21.31',
    installDir: '/data/agent/runtime-packages/amagi-pi@2.21.31', contentHash: 'abc123', layout: 'source',
    installState: 'installed', installDetail: null,
    gitSource: `git:github.com/runrunrain/amagi-pi@${COMMIT}`,
    commit: COMMIT, repoUrl: 'https://github.com/runrunrain/amagi-pi.git',
    candidates: [], discoveryIssues: [],
    ...over,
  });
  const statusWith = (amagiOver: Record<string, unknown>, over: Record<string, unknown> = {}) => makeLocalStatus({
    amagi: amagiBase(amagiOver),
    ...over,
  });

  it('服务端仍选择回退版时，如实标出未采用的全局候选', async () => {
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(statusWith({
      candidates: [{ origin: 'global-pi-home', source: '/Users/x/amagi-pi', sourceType: 'local', packagePath: '/Users/x/amagi-pi', version: '2.21.36', matchesPin: false }],
    }));
    const container = setup(makeConfig());
    await act(async () => {});
    const block = container.querySelector('[data-testid="orch-runtime-candidates"]');
    expect(block?.textContent).toContain('全局 Pi');
    expect(block?.textContent).toContain('2.21.36');
    expect(block?.textContent).toContain('本地目录');
    expect(block?.textContent).toContain('未被选为新构建版本');
    // 构建专用固定版本仍是 31 已装，不被 36 冒充
    expect(container.querySelector('[data-testid="orch-runtime-facts"]')?.textContent).toContain('已安装 2.21.31');
  });

  it('较新本地版被选中后，显示下一次构建自动采用并冻结', async () => {
    const source = '/Users/x/amagi-pi';
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(statusWith({
      pinnedVersion: '2.21.36', selectedSource: source,
      installed: false, version: null, installDir: null, contentHash: null, installState: 'missing',
      candidates: [{ origin: 'global-pi-home', source, sourceType: 'local', packagePath: source, version: '2.21.36', matchesPin: false }],
    }));
    const container = setup(makeConfig());
    await act(async () => {});
    expect(container.querySelector('[data-testid="orch-runtime-facts"]')?.textContent).toContain('新构建优选 2.21.36');
    expect(container.querySelector('[data-testid="orch-runtime-candidates"]')?.textContent).toContain('下一次构建自动采用并冻结');
    expect(container.querySelector('[data-testid="orch-runtime-install-btn"]')?.textContent).toContain('已配置版本');
  });

  it('较新 Git 版被选中时，同样标出下一次构建自动采用', async () => {
    const source = '/Users/x/.pi/agent/git/github.com/runrunrain/amagi-pi';
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(statusWith({
      pinnedVersion: '2.21.37', selectedSource: source,
      installed: false, version: null, installDir: null, contentHash: null, installState: 'missing',
      candidates: [{ origin: 'global-pi-home', source: 'git:github.com/runrunrain/amagi-pi@ref', sourceType: 'git', packagePath: source, version: '2.21.37', matchesPin: false }],
    }));
    const container = setup(makeConfig());
    await act(async () => {});
    expect(container.querySelector('[data-testid="orch-runtime-candidates"]')?.textContent).toContain('下一次构建自动采用并冻结');
    expect(container.querySelector('[data-testid="orch-runtime-install-btn"]')?.textContent).toContain('已配置版本');
  });

  it('发现异常（unavailable/error）单独表达，不谎称未安装', async () => {
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(statusWith({
      candidates: [],
      discoveryIssues: [{ origin: 'app-pi-home', status: 'unavailable', detail: 'Pi 运行时或包管理 SDK 不可用', settingsErrors: [] }],
    }));
    const container = setup(makeConfig());
    await act(async () => {});
    const issues = container.querySelector('[data-testid="orch-runtime-discovery-issues"]');
    expect(issues?.textContent).toContain('应用插件目录候选检测不可用');
    expect(issues?.textContent).toContain('不代表未安装');
  });

  it('已装 → 按钮为「校验构建版本」；未装 → 默认官方 Git 标签与提示', async () => {
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(statusWith({}));
    const installed = setup(makeConfig());
    await act(async () => {});
    expect((installed.querySelector('[data-testid="orch-runtime-install-btn"]') as HTMLElement).textContent).toContain('校验构建版本 2.21.31');
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(statusWith({
      installed: false, version: null, installDir: null, contentHash: null, layout: null, installState: 'missing',
    }));
    const fresh = setup(makeConfig());
    await act(async () => {});
    const btn = fresh.querySelector('[data-testid="orch-runtime-install-btn"]') as HTMLElement;
    expect(btn.textContent).toContain('安装 amagi-pi 2.21.31');
    expect(btn.textContent).toContain('官方 Git');
    expect(fresh.querySelector('[data-testid="orch-runtime-install-hint"]')?.textContent).toContain('不回退 npm/latest');
  });

  it('精确匹配 pin 的本地候选 → 推荐来源可见，「用作安装来源」回填目录', async () => {
    const path36 = '/Users/x/amagi-pi-31';
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(statusWith({
      installed: false, version: null, installDir: null, contentHash: null, layout: null, installState: 'missing',
      candidates: [{ origin: 'global-pi-home', source: path36, sourceType: 'local', packagePath: path36, version: '2.21.31', matchesPin: true }],
    }));
    apiRuntime.installKbBuildRuntime.mockResolvedValue({ installed: true, fresh: true, version: '2.21.31', installDir: '/d', contentHash: 'h', layout: 'source', dependenciesIncluded: false });
    const container = setup(makeConfig());
    await act(async () => {});
    expect(container.querySelector('[data-testid="orch-runtime-candidates"]')?.textContent).toContain('与固定版本一致');
    await act(async () => { (container.querySelector('[data-testid="orch-runtime-candidate-adopt"]') as HTMLElement).click(); });
    expect((container.querySelector('[data-testid="orch-runtime-source-dir"]') as HTMLInputElement).value).toBe(path36);
    await act(async () => { (container.querySelector('[data-testid="orch-runtime-install-btn"]') as HTMLElement).click(); });
    expect(apiRuntime.installKbBuildRuntime).toHaveBeenCalledWith({ sourceDir: path36 });
  });

  it('desktop.selectDirectory：选中回填；取消（null）保持；无桥不渲染按钮仍可手填', async () => {
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(statusWith({}));
    const desktop = { selectDirectory: vi.fn() };
    (window as unknown as { desktop: unknown }).desktop = desktop;
    try {
      desktop.selectDirectory.mockResolvedValue('/chosen/amagi-pi');
      const container = setup(makeConfig());
      await act(async () => {});
      await act(async () => { (container.querySelector('[data-testid="orch-runtime-source-dir-pick"]') as HTMLElement).click(); });
      expect((container.querySelector('[data-testid="orch-runtime-source-dir"]') as HTMLInputElement).value).toBe('/chosen/amagi-pi');

      desktop.selectDirectory.mockResolvedValue(null); // 用户取消
      await act(async () => { (container.querySelector('[data-testid="orch-runtime-source-dir-pick"]') as HTMLElement).click(); });
      expect((container.querySelector('[data-testid="orch-runtime-source-dir"]') as HTMLInputElement).value).toBe('/chosen/amagi-pi');
    } finally {
      delete (window as unknown as { desktop: unknown }).desktop;
    }
    // 无桥（浏览器）：无按钮，手填可用
    const container2 = setup(makeConfig());
    await act(async () => {});
    expect(container2.querySelector('[data-testid="orch-runtime-source-dir-pick"]')).toBeNull();
    const input = container2.querySelector('[data-testid="orch-runtime-source-dir"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '/manual/amagi-pi');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('/manual/amagi-pi');
  });

  it('长错误折叠：主提示可读，详情默认收起、点击展开', async () => {
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(statusWith({}));
    apiRuntime.installKbBuildRuntime.mockRejectedValue(new APIError(
      'amagi_install_failed: Git 获取失败（需本机可用 git 与网络；也可改填本地 amagi-pi 目录安装）\nstderr: fatal: could not read from remote repository\n长详细输出…',
      400,
      { error: 'amagi_install_failed' },
    ));
    const container = setup(makeConfig());
    await act(async () => {});
    await act(async () => { (container.querySelector('[data-testid="orch-runtime-install-btn"]') as HTMLElement).click(); });
    const error = container.querySelector('[data-testid="orch-runtime-install-error"]');
    expect(error?.textContent).toContain('Git 获取失败');
    expect(container.querySelector('[data-testid="orch-runtime-install-error-detail"]')).toBeNull(); // 默认折叠
    await act(async () => { (container.querySelector('[data-testid="orch-runtime-install-error-toggle"]') as HTMLElement).click(); });
    const detail = container.querySelector('[data-testid="orch-runtime-install-error-detail"]');
    expect(detail?.textContent).toContain('fatal: could not read from remote repository');
  });

  it('刷新清除旧错误（成功状态到达后不残留）', async () => {
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(statusWith({}));
    apiRuntime.installKbBuildRuntime.mockRejectedValue(new APIError('amagi_install_failed: 一次失败', 400, { error: 'amagi_install_failed' }));
    const container = setup(makeConfig());
    await act(async () => {});
    await act(async () => { (container.querySelector('[data-testid="orch-runtime-install-btn"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="orch-runtime-install-error"]')).not.toBeNull();
    apiRuntime.installKbBuildRuntime.mockResolvedValue({ installed: true, fresh: false, version: '2.21.31', installDir: '/d', contentHash: 'h', layout: 'source', dependenciesIncluded: true });
    await act(async () => { (container.querySelector('[data-testid="orch-runtime-refresh"]') as HTMLElement).click(); });
    await act(async () => {});
    expect(container.querySelector('[data-testid="orch-runtime-install-error"]')).toBeNull();
  });

  it('splitInstallErrorMessage：单行短消息无详情；多行/超长消息拆分', () => {
    expect(splitInstallErrorMessage('短错误')).toEqual({ main: '短错误', detail: null });
    const multi = splitInstallErrorMessage('第一行主因\nstderr: 详细');
    expect(multi.main).toBe('第一行主因');
    expect(multi.detail).toBe('stderr: 详细');
    const long = splitInstallErrorMessage('x'.repeat(300));
    expect(long.main.length).toBeLessThanOrEqual(181);
    expect(long.main.endsWith('…')).toBe(true);
    expect(long.detail).toBe('x'.repeat(300));
    expect(splitInstallErrorMessage('  ')).toEqual({ main: '安装失败（未知错误）', detail: null });
  });

  it('安装前挂起GET不能清掉其后新安装错误，显式刷新才清错', async () => {
    let resolveOld!: (value: unknown) => void;
    apiRuntime.getKbBuildRuntimeStatus.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    apiRuntime.installKbBuildRuntime.mockRejectedValue(new APIError('本轮安装失败：保留原因', 400));
    const container = setup(makeConfig());
    await act(async () => {});
    await act(async () => { (container.querySelector('[data-testid="orch-runtime-install-btn"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="orch-runtime-install-error"]')?.textContent).toContain('本轮安装失败：保留原因');
    await act(async () => { resolveOld(statusWith({ installed: false, installState: 'missing' })); });
    expect(container.querySelector('[data-testid="orch-runtime-install-error"]')?.textContent).toContain('本轮安装失败：保留原因');
    apiRuntime.getKbBuildRuntimeStatus.mockResolvedValue(statusWith({}));
    await act(async () => { (container.querySelector('[data-testid="orch-runtime-refresh"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="orch-runtime-install-error"]')).toBeNull();
  });

  it('latest-request-wins：安装成功的新 GET 之后，先前加载/手刷的旧 GET 迟到返回不回写旧状态', async () => {
    // 手动挂起两个 GET：旧（未装）与新（已装）；旧响应后到，不得覆盖新状态。
    const deferreds: Array<(value: unknown) => void> = [];
    apiRuntime.getKbBuildRuntimeStatus.mockImplementation(() => new Promise((resolve) => { deferreds.push(resolve); }));
    apiRuntime.installKbBuildRuntime.mockResolvedValue({ installed: true, fresh: true, version: '2.21.31', installDir: '/d', contentHash: 'h', layout: 'source', dependenciesIncluded: true });
    const container = setup(makeConfig());
    await act(async () => {});
    expect(deferreds).toHaveLength(1); // 挂载加载（旧请求，保持挂起）
    // 挂起期间用户直接点安装（安装区不依赖探测结果渲染）
    await act(async () => { (container.querySelector('[data-testid="orch-runtime-install-btn"]') as HTMLElement).click(); });
    expect(deferreds).toHaveLength(2); // 安装成功 → onInstalled 发起新 GET
    await act(async () => { deferreds[1](statusWith({})); }); // 新请求先完成：已装
    expect((container.querySelector('[data-testid="orch-runtime-install-btn"]') as HTMLElement).textContent).toContain('校验构建版本');
    expect(container.querySelector('[data-testid="orch-runtime-facts"]')?.textContent).toContain('已安装 2.21.31');
    // 旧请求（挂载加载）此时才返回「未装」：迟到响应必须丢弃，不得回写
    await act(async () => { deferreds[0](statusWith({ installed: false, version: null, installDir: null, contentHash: null, layout: null, installState: 'missing' })); });
    expect((container.querySelector('[data-testid="orch-runtime-install-btn"]') as HTMLElement).textContent).toContain('校验构建版本');
    expect(container.querySelector('[data-testid="orch-runtime-facts"]')?.textContent).toContain('已安装 2.21.31');
  });
});
