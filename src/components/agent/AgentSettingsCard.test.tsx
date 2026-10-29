/**
 * AgentSettingsCard 组件测试（S5）—— renderToStaticMarkup 锚定：
 * 图片理解段（开关/提供商/模型下拉 + supportsImages 标记与置灰/测试按钮
 * 可用条件）、构建并行数下拉（1..6 + 后台配额提示）。数据 hook 与 vision
 * API 全 mock（CliAccessSettingsCard.test.tsx 同法：SSR 不跑 effect，
 * 状态展示细节由导出的纯函数 describeVisionStatus/describeVisionTestResult
 * 单测锚定）；点击保存链路由 server 侧 agent-config / vision 路由测试锚定，
 * 真机浏览器验证见 S5-report。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useConfigMock = vi.hoisted(() => vi.fn());
const useAgentStatusMock = vi.hoisted(() => vi.fn());
const visionStatusMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useConfig', () => ({ useConfig: useConfigMock }));
vi.mock('../../hooks/useAgentStatus', () => ({ useAgentStatus: useAgentStatusMock }));
vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, getAgentVisionStatus: visionStatusMock };
});

import {
  AgentKbSettingsCard,
  AgentRuntimeSettingsCard,
  canTestVision,
  clampBuildBatchWordBudget,
  describeBuildBatchWordBudgetInput,
  describeVisionStatus,
  describeVisionTestResult,
} from './AgentSettingsCard';
import type { AgentVisionStatusDto, AgentVisionTestResult } from '../../types/agent';
import type { Config } from '../../types';

const PROVIDERS = [
  {
    id: 'vp',
    name: '示例智谱',
    enabled: true,
    apiKey: 'sk-x',
    openAiCompatBaseUrl: 'https://api.example.com/v1',
    protocol: 'openai-completions' as const,
    defaultModelId: 'glm-v',
    models: [
      { id: 'glm-v', name: 'GLM 视觉', openAiModel: 'glm-4v', enabled: true, supportsImages: true },
      { id: 'glm-t', name: 'GLM 文本', openAiModel: 'glm-4', enabled: true, supportsImages: false },
      { id: 'glm-x', name: 'GLM 未标注', openAiModel: 'glm-4x', enabled: true },
    ],
  },
];

function makeConfig(over: { agent?: Partial<Config['agent']>; llm?: Partial<Config['llm']>; standardKb?: Partial<NonNullable<Config['standardKb']>> } = {}): Config {
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
    agent: {
      runtime: {},
      model: { source: 'app-llm', providerId: 'vp', modelId: 'glm-t', thinkingLevel: 'off', contextWindow: 128000, maxTokens: 8192 },
      vision: { enabled: true, providerId: 'vp', modelId: 'glm-v', concurrency: 3, maxImageBytes: 5_242_880, maxImagesPerBuild: 300, timeoutMs: 120_000 },
      maxConcurrentProcesses: 3,
      idleTimeoutMinutes: 10,
      workspaces: [],
      ...over.agent,
    },
    standardKb: {
      outputRoot: '/tmp/standard-kb',
      retainReleases: 3,
      buildBatchSize: 10,
      buildBatchWordBudget: 40000,
      promptTimeoutMinutes: 15,
      buildTimeoutMinutes: 180,
      buildParallelism: 2,
      autoBuildAfterSync: false,
      ...over.standardKb,
    },
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

function setup(config: Config | null) {
  useConfigMock.mockReturnValue({ config, updateConfig, loading: false, error: null, saving: false, saveError: null, loadConfig: vi.fn(), refresh: vi.fn() });
  useAgentStatusMock.mockReturnValue({ status: null, loading: false, unreachable: false, error: null, rechecking: false, recheck: vi.fn(), refresh: vi.fn() });
}

function option(html: string, value: string): string {
  const matches = html.match(new RegExp(`<option[^>]*value="${value}"[^>]*>[\\s\\S]*?</option>`, 'g')) ?? [];
  // 同页存在文本模型下拉与识图模型下拉同名 value：取最后一个（识图段在后）。
  return matches[matches.length - 1] ?? '';
}

function element(html: string, tag: string, testid: string): string {
  return html.match(new RegExp(`<${tag}[^>]*data-testid="${testid}"[^>]*>[\\s\\S]*?</${tag}>`))?.[0]
    ?? html.match(new RegExp(`<${tag}[^>]*data-testid="${testid}"[^>]*/?>`))?.[0]
    ?? '';
}

beforeEach(() => {
  useConfigMock.mockReset();
  useAgentStatusMock.mockReset();
  visionStatusMock.mockReset();
});

describe('Agent 基座选择', () => {
  it('Claude Code 显示应用提供商，并标明原 Pi 选择不可用', () => {
    const anthropic = { ...PROVIDERS[0], id: 'anthropic', name: '兼容 Anthropic', protocol: 'anthropic-messages' as const };
    const agent = makeConfig().agent!;
    setup(makeConfig({ agent: { ...agent, runtime: { backend: 'claude-code' },
      model: { ...agent.model, source: 'pi-agent-dir', piModel: 'pi/model' } }, llm: { providers: [...PROVIDERS, anthropic] } }));
    const html = renderToStaticMarkup(<AgentRuntimeSettingsCard />);
    expect(html).toContain('应用基础能力的 Agent 基座');
    expect(html).toContain('新会话可单独选择');
    expect(html).toContain('Claude Code 路径覆盖');
    expect(html).toContain('pi 路径覆盖');
    expect(html).toContain('更新 Pi');
    expect(html).toContain('更新 Claude Code');
    expect(html).toContain('预设上下文窗口用于自动压缩');
    expect(html).not.toContain('本地 Agent 配置（Pi）');
    const providerSelect = html.match(/<select[^>]*aria-label="选择提供商"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? '';
    expect(providerSelect).toContain('兼容 Anthropic');
    expect(providerSelect).toContain('原提供商不可用或协议不兼容');
    expect(providerSelect).not.toContain('示例智谱');
    expect(html).not.toContain('aria-label="pi 模型"');
  });

  it('Pi 基座仍可选择本地 Agent 配置', () => {
    setup(makeConfig());
    expect(renderToStaticMarkup(<AgentRuntimeSettingsCard />)).toContain('本地 Agent 配置（Pi）');
  });

  it('Claude Code accepts an Anthropic endpoint on an OpenAI-default provider', () => {
    const dual = { ...PROVIDERS[0], protocolBaseUrls: { 'anthropic-messages': 'https://example.com/anthropic' } };
    setup(makeConfig({ agent: { ...makeConfig().agent!, runtime: { backend: 'claude-code' } }, llm: { providers: [dual] } }));
    const html = renderToStaticMarkup(<AgentRuntimeSettingsCard />);
    const select = html.match(/<select[^>]*aria-label="选择提供商"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? '';
    expect(select).toContain('示例智谱');
    expect(select).not.toContain('协议不兼容');
  });
});

describe('AgentRuntimeSettingsCard 图片理解段（S2/S5）', () => {
  it('启用态：段标题、已勾选开关、测试按钮可用、发送端点提示', () => {
    setup(makeConfig());
    const html = renderToStaticMarkup(<AgentRuntimeSettingsCard />);
    expect(html).toContain('data-testid="vision-section"');
    expect(html).toContain('图片理解');
    const toggle = element(html, 'input', 'vision-enabled-toggle');
    expect(toggle).toContain('checked');
    expect(toggle).not.toContain('disabled=""');
    const testButton = element(html, 'button', 'vision-test-button');
    expect(testButton).toContain('测试识图');
    expect(testButton).not.toContain('disabled=""');
    expect(html).toContain('图片发送到所选端点');
  });

  it('模型下拉：supportsImages 标注与置灰，未标注不置灰', () => {
    setup(makeConfig());
    const html = renderToStaticMarkup(<AgentRuntimeSettingsCard />);
    const vision = option(html, 'glm-v');
    expect(vision).toContain('支持图片');
    expect(vision).not.toContain('disabled');
    const text = option(html, 'glm-t');
    expect(text).toContain('disabled');
    expect(text).toContain('不支持图片');
    const unmarked = option(html, 'glm-x');
    expect(unmarked).not.toContain('不支持图片');
    expect(unmarked).not.toContain('disabled');
  });

  it('禁用且未显式选择时：开关未勾选、测试按钮禁用（服务端会拒 400 vision_unconfigured）', () => {
    setup(makeConfig({ agent: { vision: { enabled: false, concurrency: 3, maxImageBytes: 5_242_880, maxImagesPerBuild: 300, timeoutMs: 120_000 } }, llm: { activeProviderId: '' } }));
    const html = renderToStaticMarkup(<AgentRuntimeSettingsCard />);
    const toggle = element(html, 'input', 'vision-enabled-toggle');
    expect(toggle).not.toContain('checked');
    const testButton = element(html, 'button', 'vision-test-button');
    expect(testButton).toContain('disabled=""');
  });

  it('禁用但已显式选模型：测试按钮可用（启用前试测）', () => {
    setup(makeConfig({ agent: { vision: { enabled: false, providerId: 'vp', modelId: 'glm-v', concurrency: 3, maxImageBytes: 5_242_880, maxImagesPerBuild: 300, timeoutMs: 120_000 } } }));
    const html = renderToStaticMarkup(<AgentRuntimeSettingsCard />);
    const testButton = element(html, 'button', 'vision-test-button');
    expect(testButton).not.toContain('disabled=""');
  });

  it('无可用提供商：开关禁用 + 引导文案', () => {
    setup(makeConfig({ llm: { providers: [] } }));
    const html = renderToStaticMarkup(<AgentRuntimeSettingsCard />);
    const toggle = element(html, 'input', 'vision-enabled-toggle');
    expect(toggle).toContain('disabled=""');
    expect(html).toContain('尚无可用提供商');
  });

  it('状态行初始为读取中（SSR 不跑 effect）；请求失败呈现不可达文案', async () => {
    setup(makeConfig());
    const html = renderToStaticMarkup(<AgentRuntimeSettingsCard />);
    expect(html).toContain('data-testid="vision-status"');
    expect(html).toContain('正在读取图片理解状态');
    // 模拟 effect 内请求失败（真机路径）：getAgentVisionStatus reject → 状态 null
    visionStatusMock.mockRejectedValue(new Error('unreachable'));
    await expect(visionStatusMock()).rejects.toThrow('unreachable');
  });
});

describe('AgentKbSettingsCard 构建并行数（S4/S5）', () => {
  it('1..6 下拉、当前值选中、后台配额提示', () => {
    setup(makeConfig());
    const html = renderToStaticMarkup(<AgentKbSettingsCard />);
    expect(html).toContain('构建并行数');
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const opt = option(html, String(n));
      expect(opt.length, `option ${n}`).toBeGreaterThan(0);
    }
    expect(option(html, '2')).toContain('selected');
    expect(option(html, '1')).toContain('单进程，行为与旧版一致');
    expect(html).toContain('data-testid="build-parallelism-hint"');
    expect(html).toContain('maxConcurrentProcesses');
  });

  it('旧配置缺 buildParallelism 时缺省显示 2（服务端归一默认）', () => {
    const config = makeConfig();
    delete (config.standardKb as Partial<NonNullable<Config['standardKb']>>).buildParallelism;
    setup(config);
    const html = renderToStaticMarkup(<AgentKbSettingsCard />);
    expect(option(html, '2')).toContain('selected');
  });
});

describe('AgentKbSettingsCard 每批字数预算（P2-S3）', () => {
  it('数字输入 + 「0 = 按源数分批」说明；保存由设置页统一处理', () => {
    setup(makeConfig());
    const html = renderToStaticMarkup(<AgentKbSettingsCard />);
    expect(html).toContain('每批字数预算');
    // SSR 不跑 effect，输入框为空：显示输入错误。
    const input = element(html, 'input', 'build-word-budget-input');
    expect(input.length).toBeGreaterThan(0);
    expect(element(html, 'button', 'build-word-budget-save')).toBe('');
    expect(html).toContain('data-testid="build-word-budget-feedback"');
    expect(html).toContain('请输入数字（0 或 4000–400000）');
    expect(html).toContain('0 = 按源数分批');
    expect(html).toContain('4000–400000');
    expect(html).toContain('有效字数');
  });

  it('clampBuildBatchWordBudget 对齐 server 链制语义', () => {
    // 非数字/空 → 缺省 40000；≤0 → 0；(0,4000) → 4000；>400000 → 400000；区间内 floor。
    expect(clampBuildBatchWordBudget('abc')).toBe(40000);
    expect(clampBuildBatchWordBudget('')).toBe(40000);
    expect(clampBuildBatchWordBudget(' 12000 ')).toBe(12000);
    expect(clampBuildBatchWordBudget(0)).toBe(0);
    expect(clampBuildBatchWordBudget(-5)).toBe(0);
    expect(clampBuildBatchWordBudget('0')).toBe(0);
    expect(clampBuildBatchWordBudget(2000)).toBe(4000);
    expect(clampBuildBatchWordBudget('3999.7')).toBe(4000);
    expect(clampBuildBatchWordBudget(4000)).toBe(4000);
    expect(clampBuildBatchWordBudget('40000')).toBe(40000);
    expect(clampBuildBatchWordBudget('40500.9')).toBe(40500);
    expect(clampBuildBatchWordBudget(400000)).toBe(400000);
    expect(clampBuildBatchWordBudget(999999)).toBe(400000);
  });

  it('describeBuildBatchWordBudgetInput 输入即时反馈分级', () => {
    // 空 → error（阻断保存）
    expect(describeBuildBatchWordBudgetInput('')?.level).toBe('error');
    // 非数字 → error
    expect(describeBuildBatchWordBudgetInput('abc')?.level).toBe('error');
    expect(describeBuildBatchWordBudgetInput('abc')?.text).toContain('40000');
    // 0 / 负数 → hint（按源数分批）
    expect(describeBuildBatchWordBudgetInput('0')).toMatchObject({ level: 'hint' });
    expect(describeBuildBatchWordBudgetInput('0')?.text).toContain('按源数分批');
    expect(describeBuildBatchWordBudgetInput('-3')?.level).toBe('hint');
    // 越界 → warn，提示链制后生效值
    expect(describeBuildBatchWordBudgetInput('2000')).toMatchObject({ level: 'warn' });
    expect(describeBuildBatchWordBudgetInput('2000')?.text).toContain('4000');
    expect(describeBuildBatchWordBudgetInput('500000')).toMatchObject({ level: 'warn' });
    expect(describeBuildBatchWordBudgetInput('500000')?.text).toContain('400000');
    // 合法区间 → hint（不 warn）
    expect(describeBuildBatchWordBudgetInput('4000')?.level).toBe('hint');
    expect(describeBuildBatchWordBudgetInput('40000')?.level).toBe('hint');
    expect(describeBuildBatchWordBudgetInput('400000')?.level).toBe('hint');
    // 区间内小数仅取整，不提示越界
    expect(describeBuildBatchWordBudgetInput('40500.9')?.level).toBe('hint');
  });
});

describe('图片理解纯函数', () => {
  it('describeVisionStatus 三态', () => {
    const ready: AgentVisionStatusDto = { enabled: true, state: 'ready', provider: 'vp', model: 'glm-4v', message: '', cachedCount: 7 };
    expect(describeVisionStatus(ready)).toContain('图片描述通道可用');
    expect(describeVisionStatus(ready)).toContain('glm-4v');
    expect(describeVisionStatus(ready)).toContain('7');
    const invalid: AgentVisionStatusDto = { enabled: true, state: 'invalid', provider: 'vp', model: null, message: '引用的预设已删除', cachedCount: 0 };
    expect(describeVisionStatus(invalid)).toContain('配置无效');
    expect(describeVisionStatus(invalid)).toContain('引用的预设已删除');
    const disabled: AgentVisionStatusDto = { enabled: false, state: 'disabled', provider: null, model: null, message: '', cachedCount: 0 };
    expect(describeVisionStatus(disabled)).toBe('未启用');
  });

  it('describeVisionTestResult 成功/失败', () => {
    const ok: AgentVisionTestResult = { ok: true, finishReason: 'stop', model: 'glm-4v', latencyMs: 812, sample: '识图测试' };
    expect(describeVisionTestResult(ok)).toBe('测试通过 · glm-4v · 812ms');
    const fail: AgentVisionTestResult = { ok: false, finishReason: 'error', model: 'glm-4v', latencyMs: 0, sample: '', error: { code: 'vision_failed', message: '远程端点 401' } };
    expect(describeVisionTestResult(fail)).toBe('测试失败（vision_failed）：远程端点 401');
  });

  it('canTestVision 真值表', () => {
    expect(canTestVision(false, '', '')).toBe(false);
    expect(canTestVision(true, '', '')).toBe(true);
    expect(canTestVision(false, 'vp', '')).toBe(true);
    expect(canTestVision(false, '', 'glm-v')).toBe(true);
  });
});
