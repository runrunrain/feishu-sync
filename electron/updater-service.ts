/**
 * Updater Service (Skeleton M0 Version)
 *
 * Manages application auto-update functionality.
 * M0 provides skeleton structure; M5 will implement full electron-updater integration.
 *
 * Adapted from tts-voice-generator/updater-service.ts with M0 skeleton implementation
 */

import { BrowserWindow, shell } from 'electron';
import type {
  DesktopActionResult,
  DesktopDownloadProgress,
  DesktopPlatformCapabilities,
  DesktopUpdateCheckResult,
  DesktopUpdateEvent,
  DesktopUpdateInfo,
  DesktopUpdateState,
} from './contracts.js';
import type { QuitCoordinator } from './quit-coordinator.js';
import { getReleasePageUrl, isTrustedReleasePageUrl } from './platform-capabilities.js';

type DesktopUpdaterServiceOptions = {
  getWindow: () => BrowserWindow | null;
  getCapabilities: () => DesktopPlatformCapabilities;
  quitCoordinator: QuitCoordinator;
  sanitizeError: (error: unknown) => string;
};

function toDesktopUpdateInfo(version: string): DesktopUpdateInfo {
  // M0: Stub implementation - M5 will parse real UpdateInfo from electron-updater
  return {
    version,
    releaseDate: undefined,
    releaseName: undefined,
    releaseNotes: undefined,
  };
}

export class DesktopUpdaterService {
  private state: DesktopUpdateState;
  private checkInFlight: Promise<DesktopUpdateCheckResult> | null = null;
  private downloadInFlight: Promise<DesktopActionResult> | null = null;
  private installInFlight: Promise<DesktopActionResult> | null = null;

  constructor(private readonly options: DesktopUpdaterServiceOptions) {
    const capabilities = this.options.getCapabilities();
    this.state = {
      phase: capabilities.updateCheckSupported ? 'idle' : 'unsupported',
      currentVersion: capabilities.appVersion,
      ...(capabilities.updateCheckSupported ? {} : { error: capabilities.updateInstallUnsupportedReason ?? '应用内更新仅在桌面安装包中可用。' }),
    };
    // M0: Skip electron-updater initialization - M5 will add autoUpdater config
    console.info('[Updater] M0 skeleton initialized. M5 will add electron-updater integration.');
  }

  getState() {
    return { ...this.state };
  }

  async check(): Promise<DesktopUpdateCheckResult> {
    const capabilities = this.options.getCapabilities();
    if (!capabilities.updateCheckSupported) {
      const error = capabilities.updateInstallUnsupportedReason ?? '应用内更新仅在已打包安装的桌面应用中可用。';
      this.setState({ phase: 'unsupported', currentVersion: capabilities.appVersion, error });
      return { ok: false, code: 'update-unsupported', error, state: this.getState() };
    }
    if (this.checkInFlight) return this.checkInFlight;
    if (this.state.phase === 'downloading' || this.state.phase === 'installing') {
      return { ok: true, state: this.getState() };
    }

    // M0: Stub implementation - returns "up-to-date" without checking
    this.setState({ phase: 'checking', currentVersion: capabilities.appVersion, error: undefined });
    this.checkInFlight = (async () => {
      // Simulate check delay
      await new Promise(resolve => setTimeout(resolve, 500));
      this.setState({
        phase: 'up-to-date',
        currentVersion: capabilities.appVersion,
        lastCheckedAt: new Date().toISOString(),
      });
      return { ok: true, state: this.getState() } as const;
    })().finally(() => {
      this.checkInFlight = null;
    });

    return this.checkInFlight;
  }

  async download(): Promise<DesktopActionResult> {
    const capabilities = this.options.getCapabilities();
    if (!capabilities.updateDownloadSupported) {
      return { ok: false, code: 'update-download-unsupported', error: '当前环境不支持应用内下载更新。' };
    }
    if (this.downloadInFlight) return this.downloadInFlight;
    if (this.state.phase === 'downloaded') return { ok: true };
    if (this.state.phase !== 'available') {
      return { ok: false, code: 'update-not-available', error: '请先检查并确认存在可下载更新。' };
    }

    // M0: Stub implementation - M5 will call autoUpdater.downloadUpdate()
    this.setState({ phase: 'downloading', currentVersion: capabilities.appVersion, progress: undefined, error: undefined });
    this.downloadInFlight = (async () => {
      // Simulate download delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      this.setState({ phase: 'error', currentVersion: capabilities.appVersion, error: 'M0: Download stub - M5 will implement real download' });
      return { ok: false, code: 'update-download-stub', error: 'M0: Download stub - M5 will implement real download' } as const;
    })().finally(() => {
      this.downloadInFlight = null;
    });

    return this.downloadInFlight;
  }

  async installAndRestart(): Promise<DesktopActionResult> {
    const capabilities = this.options.getCapabilities();
    if (!capabilities.updateInstallSupported) {
      return {
        ok: false,
        code: 'update-install-unsupported',
        error: capabilities.updateInstallUnsupportedReason ?? '当前环境不支持自动安装更新。',
      };
    }
    if (this.installInFlight) return this.installInFlight;
    if (this.state.phase !== 'downloaded') {
      return { ok: false, code: 'update-not-downloaded', error: '更新尚未下载完成，不能安装并重启。' };
    }

    // M0: Stub implementation - M5 will call quitCoordinator.prepareForQuit and autoUpdater.quitAndInstall
    this.setState({ phase: 'installing', currentVersion: capabilities.appVersion, error: undefined });
    this.installInFlight = (async () => {
      // Simulate install delay
      await new Promise(resolve => setTimeout(resolve, 500));
      this.setState({ phase: 'error', currentVersion: capabilities.appVersion, error: 'M0: Install stub - M5 will implement real install' });
      return { ok: false, code: 'update-install-stub', error: 'M0: Install stub - M5 will implement real install' } as const;
    })().finally(() => {
      this.installInFlight = null;
    });

    return this.installInFlight;
  }

  async openReleasePage(): Promise<DesktopActionResult> {
    const releasePageUrl = getReleasePageUrl();
    if (!isTrustedReleasePageUrl(releasePageUrl)) {
      return { ok: false, code: 'untrusted-release-url', error: 'Release 页面地址未通过安全校验。' };
    }
    const result = await shell.openExternal(releasePageUrl);
    return result ? { ok: false, code: 'open-release-page-failed', error: this.options.sanitizeError(result) } : { ok: true };
  }

  private setState(nextState: Partial<DesktopUpdateState>) {
    this.state = { ...this.state, ...nextState };
    this.emit({ type: 'state', state: this.getState() });
  }

  private emit(event: DesktopUpdateEvent) {
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send('desktop:update:event', event);
  }
}
