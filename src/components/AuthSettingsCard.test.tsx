import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, setup } = vi.hoisted(() => ({ auth: vi.fn(), setup: vi.fn() }));
vi.mock('../hooks/useAuthStatus', () => ({ useAuthStatus: auth }));
vi.mock('../hooks/useLarkCliSetup', () => ({ useLarkCliSetup: setup }));
import { AuthSettingsCard } from './AuthSettingsCard';

beforeEach(() => {
  auth.mockReturnValue({
    authStatus: { ready: false, account: { id: 'ou-current', name: '当前账号' }, verified: false, error: 'User token expired' },
    loading: false, ready: false, error: 'User token expired', refresh: vi.fn(),
  });
  setup.mockReturnValue({
    toolStatus: { larkCliInstalled: true, authReady: false, npmAvailable: true },
    authPhase: 'idle', authMode: 'reauthorize', configInitPhase: 'idle', configInitNeeded: false,
    installing: false, startAuth: vi.fn(),
  });
});

describe('AuthSettingsCard reauthentication entry', () => {
  it('shows an enabled reauthentication button next to switching for an expired account', () => {
    const html = renderToStaticMarkup(<AuthSettingsCard />);
    const button = html.match(/<button\b[\s\S]*?<\/button>/g)?.find((item) => item.endsWith('重新认证</button>'));
    expect(button).toBeDefined();
    expect(button).not.toContain(' disabled=');
    expect(html).toContain('切换飞书账号');
    expect(html).toContain('认证已过期');
    expect(html).not.toContain('开始飞书认证');
  });

  it('keeps the entry after a failed switching attempt', () => {
    setup.mockReturnValue({ ...setup(), authPhase: 'failed', authMode: 'switch_account', authError: '发起飞书认证超时' });
    const html = renderToStaticMarkup(<AuthSettingsCard />);
    expect(html).toContain('重新认证');
    expect(html).toContain('发起飞书认证超时');
    expect(html).toContain('重试切换账号');
  });

  it('uses the first-login label when no account is saved', () => {
    auth.mockReturnValue({ ...auth(), authStatus: { ready: false }, error: '未认证' });
    expect(renderToStaticMarkup(<AuthSettingsCard />)).toContain('开始飞书认证');
  });

  it('prevents a second authentication while a flow is active', () => {
    setup.mockReturnValue({ ...setup(), authPhase: 'starting' });
    const html = renderToStaticMarkup(<AuthSettingsCard />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?重新认证<\/button>/);
  });
});
