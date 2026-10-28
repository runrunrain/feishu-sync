/**
 * FeishuWriteSettingsCard 组件测试（S13）
 *
 * SSR + hook 全 mock（CliAccessSettingsCard.test.tsx 同法）：锚定开关
 * 状态、写入权限徽标与授权入口分支。操作链路（config PUT / device flow）
 * 由 server 侧测试与真机浏览器验证覆盖。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const configHook = vi.hoisted(() => vi.fn());
const authHook = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useConfig', () => ({ useConfig: configHook }));
vi.mock('../hooks/useAuthStatus', () => ({ useAuthStatus: authHook }));
vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { FeishuWriteSettingsCard } from './FeishuWriteSettingsCard';

function renderCard(opts: {
  enabled?: boolean;
  configNull?: boolean;
  writeGranted?: boolean;
  authLoading?: boolean;
}): string {
  configHook.mockReturnValue({
    config: opts.configNull ? null : { feishuWrite: { enabled: opts.enabled ?? false } },
    updateConfig: vi.fn(),
  });
  authHook.mockReturnValue({
    authStatus: { ready: true, writeScopesGranted: opts.writeGranted ?? false },
    loading: opts.authLoading ?? false,
    refresh: vi.fn(),
  });
  return renderToStaticMarkup(<FeishuWriteSettingsCard />);
}

beforeEach(() => {
  configHook.mockReset();
  authHook.mockReset();
});

describe('FeishuWriteSettingsCard', () => {
  it('开关与说明文案渲染；未授权时显示「授权写入权限」主入口', () => {
    const html = renderCard({ enabled: false, writeGranted: false });
    expect(html).toContain('允许写回飞书');
    expect(html).toContain('docx:document:write_only');
    expect(html).toContain('未授权');
    expect(html).toContain('授权写入权限');
    // 未授权引导：说明未授权时写回会被拒
    expect(html).toContain('写回飞书」会被云端拒绝');
  });

  it('已开启 + 已授权：开关开启态、成功徽标、入口降级为重新授权', () => {
    const html = renderCard({ enabled: true, writeGranted: true });
    expect(html).toContain('已授权');
    expect(html).toContain('重新授权写入权限');
    expect(html).not.toContain('会被云端拒绝');
    // Toggle 开启态由 bg-seal 类表达（关闭态为 border 包裹）
    expect(html).toMatch(/relative inline-flex[^>]*bg-seal/);
  });

  it('配置未加载：开关保持关闭默认值，权限状态仍可检测', () => {
    const html = renderCard({ configNull: true, writeGranted: false });
    expect(html).toContain('未授权');
    expect(html).toContain('授权写入权限');
  });

  it('权限检测中：徽标 loading 文案', () => {
    const html = renderCard({ authLoading: true });
    expect(html).toContain('检测中…');
  });
});
