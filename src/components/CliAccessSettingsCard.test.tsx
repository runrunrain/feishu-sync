/**
 * CliAccessSettingsCard 组件测试（S9）
 *
 * 锚定：状态展示（开启/未开启/shim 安装态）、未开启时轮换按钮缺席且
 * shim 按钮禁用、信息不可达时的重试入口。数据 hook 全 mock
 * （AuthSettingsCard.test.tsx 同法：renderToStaticMarkup + hook mock，
 * SSR 不跑 effect）。操作链路（enable/rotate/install）由 server 侧
 * cli-client.test.ts 端到端锚定。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hook = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useCliInfo', () => ({ useCliInfo: hook }));
vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { CliAccessSettingsCard } from './CliAccessSettingsCard';

const BASE_INFO = {
  enabled: true,
  endpointPublished: true,
  endpointFile: '/home/x/.feishu-sync/run/endpoint.json',
  cliAvailable: true,
  cliScript: '/app/server/dist/cli/feishu-sync-cli.cjs',
  shimInstalled: false,
  shimPath: '/home/x/.feishu-sync/bin/feishu-sync',
  command: '/usr/local/bin/node',
  args: ['/app/server/dist/cli/feishu-sync-cli.cjs'],
  env: {},
  pathHint: '将 /home/x/.feishu-sync/bin 加入 PATH',
};

function renderCard(info: typeof BASE_INFO | null, loading = false): string {
  hook.mockReturnValue({ info, loading, reload: vi.fn() });
  return renderToStaticMarkup(<CliAccessSettingsCard />);
}

beforeEach(() => {
  hook.mockReset();
});

describe('CliAccessSettingsCard', () => {
  it('开启态：状态徽标、端点/产物路径、轮换与生成入口', () => {
    const html = renderCard({ ...BASE_INFO });
    expect(html).toContain('已开启');
    expect(html).toContain('endpoint.json');
    expect(html).toContain('feishu-sync-cli.cjs');
    expect(html).toContain('轮换令牌');
    expect(html).toContain('生成 feishu-sync 命令');
  });

  it('未开启：关闭态文案、无轮换按钮、shim 按钮禁用', () => {
    const html = renderCard({ ...BASE_INFO, enabled: false, endpointPublished: false });
    expect(html).toContain('未开启');
    expect(html).not.toContain('轮换令牌');
    const shimButton = html.match(/<button[\s\S]*?(?:生成 feishu-sync 命令|重新生成 shim)[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(shimButton).toContain('disabled');
    // 引导文案含关闭即失效语义
    expect(html).toContain('0600');
  });

  it('shim 已安装：路径与 PATH 提示可见', () => {
    const html = renderCard({ ...BASE_INFO, shimInstalled: true });
    expect(html).toContain('shim 已安装');
    expect(html).toContain(BASE_INFO.shimPath);
    expect(html).toContain('PATH');
    expect(html).toContain('重新生成 shim');
  });

  it('CLI 产物缺失：给出提示', () => {
    const html = renderCard({ ...BASE_INFO, cliAvailable: false });
    expect(html).toContain('CLI 打包产物缺失');
  });

  it('信息不可达：状态不可用 + 重试', () => {
    const html = renderCard(null);
    expect(html).toContain('状态不可用');
    expect(html).toContain('重试');
  });

  it('加载中：占位文案', () => {
    const html = renderCard(null, true);
    expect(html).toContain('读取状态');
  });
});
