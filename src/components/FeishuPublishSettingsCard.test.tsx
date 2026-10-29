/**
 * FeishuPublishSettingsCard 组件测试（P1-S9）
 *
 * SSR + hook/API 全 mock（FeishuWriteSettingsCard.test.tsx 同法）：锚定
 * 开关状态、发布根展示（已校验/未配置）、写权限依赖提示与粘贴输入入口。
 * 保存/校验链路（PUT target 的双向校验错误文案）由真机浏览器验收覆盖。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const configHook = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useConfig', () => ({ useConfig: configHook }));
vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { FeishuPublishSettingsCard } from './FeishuPublishSettingsCard';

function renderCard(opts: {
  enabled?: boolean;
  target?: { kind: 'drive_folder' | 'wiki_node'; token: string; label: string } | null;
  feishuWriteEnabled?: boolean;
  configNull?: boolean;
}): string {
  configHook.mockReturnValue({
    config: opts.configNull
      ? null
      : {
        feishuPublish: {
          enabled: opts.enabled ?? false,
          target: opts.target ?? null,
        },
        feishuWrite: { enabled: opts.feishuWriteEnabled ?? false },
      },
    updateConfig: vi.fn(),
    refresh: vi.fn(),
  });
  return renderToStaticMarkup(<FeishuPublishSettingsCard />);
}

beforeEach(() => {
  configHook.mockReset();
});

describe('FeishuPublishSettingsCard', () => {
  it('默认关：开关关闭、发布根未配置提示与粘贴入口', () => {
    const html = renderCard({ enabled: false, target: null });
    expect(html).toContain('允许发布到飞书');
    expect(html).toContain('未配置');
    expect(html).toContain('发布根必须位于所有监听（同步）目录之外');
    expect(html).toContain('publish-target-url');
    expect(html).not.toContain('校验并保存');
  });

  it('已配置发布根：展示 kind/label/token 与清除入口', () => {
    const html = renderCard({
      enabled: true,
      target: { kind: 'drive_folder', token: 'fldmockTarget0123', label: '知识库发布根' },
      feishuWriteEnabled: true,
    });
    expect(html).toContain('已校验');
    expect(html).toContain('Drive 文件夹');
    expect(html).toContain('知识库发布根');
    expect(html).toContain('fldmockTarget0123');
    expect(html).toContain('清除发布根');
    // 飞书写入已开：不显示依赖提示
    expect(html).not.toContain('反向发布依赖');
  });

  it('飞书写入未开：显示依赖提示', () => {
    const html = renderCard({ enabled: true, feishuWriteEnabled: false });
    expect(html).toContain('反向发布依赖「飞书写入」开关与写权限');
  });

  it('配置未加载：开关关闭默认值 + 未配置态', () => {
    const html = renderCard({ configNull: true });
    expect(html).toContain('允许发布到飞书');
    expect(html).toContain('未配置');
  });
});
