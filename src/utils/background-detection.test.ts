import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeNotificationService } from '../../electron/change-notification-service';

afterEach(() => vi.unstubAllGlobals());

describe('后台检测完成通知', () => {
  it('即使没有正文变更，也通知已打开的界面刷新树归属', async () => {
    const send = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ changed: false, changedDocuments: [], totalNodes: 1 }) })));
    const service = new ChangeNotificationService({
      getWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } } as never),
      getServerUrl: () => 'http://127.0.0.1:12345', getApiToken: () => 'test',
      getWatchedRootUrls: () => ['https://example.feishu.cn/wiki/root'], trayService: () => null, sanitizeError: String,
    });
    await service.manualCheck();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('desktop:change-notification:checked');
  });

  it('检测失败时不广播完成事件', async () => {
    const send = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, statusText: 'error' })));
    const service = new ChangeNotificationService({
      getWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } } as never),
      getServerUrl: () => 'http://127.0.0.1:12345', getApiToken: () => 'test',
      getWatchedRootUrls: () => ['https://example.feishu.cn/wiki/root'], trayService: () => null, sanitizeError: String,
    });
    expect(await service.manualCheck()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('关闭通知仍会检测并刷新界面，重新启用通知后采用最新设置', async () => {
    const send = vi.fn();
    const showNotification = vi.fn();
    let notificationsEnabled = false;
    let roots: string[] = [];
    const refreshSettings = vi.fn(async () => { roots = ['https://example.feishu.cn/wiki/root']; });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ changed: true, changedDocuments: [{ objToken: 'doc', title: '文档', changeType: 'modified' }], totalNodes: 1 }) })));
    const service = new ChangeNotificationService({
      getWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } } as never),
      getServerUrl: () => 'http://127.0.0.1:12345', getApiToken: () => 'test',
      getWatchedRootUrls: () => roots, refreshSettings, notificationsEnabled: () => notificationsEnabled,
      trayService: () => ({ showNotification } as never), sanitizeError: String,
    });
    vi.useFakeTimers();
    try {
      service.start(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshSettings).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
      expect(showNotification).not.toHaveBeenCalled();

      notificationsEnabled = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refreshSettings).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(2);
      expect(showNotification).toHaveBeenCalledOnce();
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });
});
