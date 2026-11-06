// @vitest-environment jsdom
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
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hook = vi.hoisted(() => vi.fn());
const updateSkill = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useCliInfo', () => ({ useCliInfo: hook }));
vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock('../api/client', async (original) => ({ ...await original<typeof import('../api/client')>(), updateCliSkill: updateSkill }));
import { CliAccessSettingsCard } from './CliAccessSettingsCard';
import type { CliInfoDto } from '../types/cli';

const BASE_INFO: CliInfoDto = {
  enabled: true,
  endpointPublished: true,
  endpointFile: '/home/x/.feishu-sync/run/endpoint.json',
  cliAvailable: true,
  cliScript: '/app/server/dist/cli/feishu-sync-cli.cjs',
  shimInstalled: false,
  shimPath: '/home/x/.feishu-sync/bin/feishu-sync',
  shim: { path: '/home/x/.feishu-sync/bin/feishu-sync', state: 'not_installed' },
  skillAvailable: true,
  skillTargets: [
    { target: 'agents', path: '/home/x/.agents/skills/feishu-sync/SKILL.md', state: 'installed' },
    { target: 'claude', path: '/home/x/.claude/skills/feishu-sync/SKILL.md', state: 'not_installed' },
    { target: 'codex', path: '/home/x/.codex/skills/feishu-sync/SKILL.md', state: 'not_installed' },
  ],
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
  updateSkill.mockReset();
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    expect(html).toContain('令牌立即失效');
  });

  it('shim 已安装：路径与 PATH 提示可见', () => {
    const html = renderCard({ ...BASE_INFO, shimInstalled: true, shim: { ...BASE_INFO.shim, state: 'installed' } });
    expect(html).toContain('shim 已安装');
    expect(html).toContain(BASE_INFO.shimPath);
    expect(html).toContain('PATH');
    expect(html).toContain('重新生成 shim');
  });

  it('在同一页展示 Skill 默认目标、其它目标和管理动作', () => {
    const html = renderCard(BASE_INFO);
    expect(html).toContain('/.agents/skills/feishu-sync/SKILL.md');
    expect(html).toContain('Claude Code（用户级）');
    expect(html).toContain('Codex（用户级）');
    expect(html).toContain('重新安装');
    expect(html).toContain('清理');
  });

  it('选择 Codex 后只安装和清理所选目标', async () => {
    let nextInfo = structuredClone(BASE_INFO);
    const reload = vi.fn();
    hook.mockImplementation(() => {
      const [info, setInfo] = useState(nextInfo);
      return { info, loading: false, reload: async () => { reload(); setInfo(nextInfo); } };
    });
    updateSkill.mockImplementation(async (target, install) => {
      nextInfo = structuredClone(nextInfo);
      const status = nextInfo.skillTargets.find(item => item.target === target)!;
      status.state = install ? 'installed' : 'not_installed';
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    const button = (label: string) => [...container.querySelectorAll('section[aria-label="Agent CLI Skill"] button')]
      .find(item => item.textContent?.trim() === label) as HTMLButtonElement;
    try {
      await act(async () => root.render(<CliAccessSettingsCard />));
      const select = container.querySelector<HTMLSelectElement>('[aria-label="Skill 安装目标"]')!;
      await act(async () => {
        select.value = 'codex';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(container.textContent).toContain('/.codex/skills/feishu-sync/SKILL.md');
      await act(async () => button('安装').click());
      await act(async () => button('清理').click());
      expect(updateSkill.mock.calls).toEqual([['codex', true], ['codex', false]]);
      expect(reload).toHaveBeenCalledTimes(2);
      expect(nextInfo.skillTargets[0].state).toBe('installed');
    } finally { act(() => root.unmount()); }
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
