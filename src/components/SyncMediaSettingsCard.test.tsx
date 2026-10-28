/**
 * SyncMediaSettingsCard 组件测试（P2-S3）
 *
 * SSR + hook 全 mock（FeishuWriteSettingsCard.test.tsx 同法）：锚定两个
 * 开关的渲染与缺省态、slidesScreenshot 的 scope 提示分支、whiteboardExport
 * 的 svgTimeoutMs 高级项显隐。保存链路（config PUT / auth-status）由
 * server 侧测试与真机浏览器验证覆盖。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const configHook = vi.hoisted(() => vi.fn());
const authHook = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useConfig', () => ({ useConfig: configHook }));
vi.mock('../hooks/useAuthStatus', () => ({ useAuthStatus: authHook }));
vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import {
  SLIDES_SCREENSHOT_SCOPE,
  SyncMediaSettingsCard,
  describeSvgTimeoutInput,
} from './SyncMediaSettingsCard';
import type { Config } from '../types';

function makeConfig(sync?: Config['sync']): Config {
  return {
    llm: {} as Config['llm'],
    pollIntervalMinutes: 30,
    knowledgeBaseRoot: '/tmp/kb',
    watchedRoots: [],
    watchedRootUrls: [],
    requiredScopes: [],
    enableAutoStart: false,
    enableNotifications: false,
    ...(sync ? { sync } : {}),
  } as Config;
}

function renderCard(opts: {
  sync?: Config['sync'];
  authLoading?: boolean;
  granted?: string[];
  missing?: string[];
  noOptionalScopes?: boolean;
}): string {
  configHook.mockReturnValue({
    config: makeConfig(opts.sync),
    updateConfig: vi.fn(),
    saving: false,
    loading: false,
    error: null,
    saveError: null,
    loadConfig: vi.fn(),
    refresh: vi.fn(),
  });
  authHook.mockReturnValue({
    authStatus: opts.noOptionalScopes
      ? { ready: true }
      : {
          ready: true,
          optionalScopes: {
            granted: opts.granted ?? [],
            missing: opts.missing ?? [SLIDES_SCREENSHOT_SCOPE],
          },
        },
    loading: opts.authLoading ?? false,
    error: null,
    ready: true,
    refresh: vi.fn(),
    check: vi.fn(),
  });
  return renderToStaticMarkup(<SyncMediaSettingsCard />);
}

beforeEach(() => {
  configHook.mockReset();
  authHook.mockReset();
});

describe('SyncMediaSettingsCard 渲染与缺省态', () => {
  it('两开关与说明文案；无 sync 段时白板导出缺省开启、截图缺省关闭', () => {
    const html = renderCard({ granted: [], missing: [] });
    expect(html).toContain('同步媒体选项');
    expect(html).toContain('幻灯片整页截图');
    expect(html).toContain('白板矢量导出');
    expect(html).toContain('不会阻断文档同步');
    // 白板开关开启态由 bg-seal 表达；截图关闭态为 border 包裹。
    expect(html).toMatch(/relative inline-flex[^>]*bg-seal/);
    expect(html).toContain('.wb.svg');
  });

  it('旧配置缺 whiteboardExport 段时 svgTimeoutMs 高级项仍显示（缺省开启）', () => {
    const html = renderCard({ sync: { slidesScreenshot: { enabled: false } }, granted: [], missing: [] });
    expect(html).toContain('data-testid="whiteboard-svg-timeout-input"');
  });

  it('关闭白板导出后 svgTimeoutMs 高级项隐藏', () => {
    const html = renderCard({
      sync: { whiteboardExport: { enabled: false } },
      granted: [],
      missing: [],
    });
    expect(html).toContain('白板矢量导出');
    expect(html).not.toContain('data-testid="whiteboard-svg-timeout-input"');
  });
});

describe('slidesScreenshot scope 提示态（P1-S5 契约）', () => {
  it('开启且未授权：显示权限行 + 「需在飞书认证时授权」引导文案', () => {
    const html = renderCard({
      sync: { slidesScreenshot: { enabled: true } },
      granted: [],
      missing: [SLIDES_SCREENSHOT_SCOPE],
    });
    expect(html).toContain('截图权限');
    expect(html).toContain(SLIDES_SCREENSHOT_SCOPE);
    expect(html).toContain('未授权');
    expect(html).toContain('data-testid="slides-scope-hint"');
    expect(html).toContain('飞书认证');
    expect(html).toContain('自动跳过截图');
  });

  it('已授权：徽标为已授权，无引导警示条', () => {
    const html = renderCard({
      sync: { slidesScreenshot: { enabled: true } },
      granted: [SLIDES_SCREENSHOT_SCOPE],
      missing: [],
    });
    expect(html).toContain('已授权');
    expect(html).not.toContain('data-testid="slides-scope-hint"');
  });

  it('未开启时不显示授权引导（开关关闭态无警示）', () => {
    const html = renderCard({
      sync: { slidesScreenshot: { enabled: false } },
      granted: [],
      missing: [SLIDES_SCREENSHOT_SCOPE],
    });
    expect(html).toContain('未授权');
    expect(html).not.toContain('data-testid="slides-scope-hint"');
  });

  it('auth-status 无 optionalScopes 字段（旧 server）：不渲染权限行，防御', () => {
    const html = renderCard({ sync: { slidesScreenshot: { enabled: true } }, noOptionalScopes: true });
    expect(html).not.toContain('data-testid="slides-scope-badge"');
    expect(html).not.toContain('data-testid="slides-scope-hint"');
  });
});

describe('describeSvgTimeoutInput 纯函数', () => {
  it('留空：有现值提示保留，无现值提示默认 30 秒', () => {
    expect(describeSvgTimeoutInput('', true).text).toContain('保留现值');
    expect(describeSvgTimeoutInput('', false).text).toContain('30000');
    expect(describeSvgTimeoutInput('', false).level).toBe('hint');
  });

  it('非法输入（非整数/非正数）为 error', () => {
    expect(describeSvgTimeoutInput('abc', false).level).toBe('error');
    expect(describeSvgTimeoutInput('-100', false).level).toBe('error');
    expect(describeSvgTimeoutInput('0', false).level).toBe('error');
    expect(describeSvgTimeoutInput('3000.5', false).level).toBe('error');
  });

  it('合法正整数为 hint 并说明仅影响客户端等待上限', () => {
    const feedback = describeSvgTimeoutInput('60000', false);
    expect(feedback.level).toBe('hint');
    expect(feedback.text).toContain('等待上限');
  });
});
