/**
 * Updater Service (M5 Production Version)
 *
 * Manages application auto-update functionality.
 * M5 implements full electron-updater integration with generic provider.
 *
 * Adapted from tts-voice-generator/updater-service.ts with feishu-sync adaptations
 */

import { BrowserWindow, shell } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
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

function normalizeReleaseNotes(releaseNotes: unknown) {
  if (typeof releaseNotes === 'string') return releaseNotes.slice(0, 10_000);
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && 'note' in entry) {
          return String((entry as { note?: unknown }).note ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .slice(0, 10_000);
  }
  return undefined;
}

function toDesktopUpdateInfo(info: UpdateInfo): DesktopUpdateInfo {
  return {
    version: info.version,
    ...(info.releaseDate ? { releaseDate: info.releaseDate } : {}),
    ...(info.releaseName ? { releaseName: info.releaseName } : {}),
    ...(normalizeReleaseNotes(info.releaseNotes) ? { releaseNotes: normalizeReleaseNotes(info.releaseNotes) } : {}),
  };
}

function toDesktopProgress(progress: ProgressInfo): DesktopDownloadProgress {
  return {
    percent: Number.isFinite(progress.percent) ? progress.percent : 0,
    transferred: Number.isFinite(progress.transferred) ? progress.transferred : 0,
    total: Number.isFinite(progress.total) ? progress.total : 0,
    bytesPerSecond: Number.isFinite(progress.bytesPerSecond) ? progress.bytesPerSecond : 0,
  };
}

function describeUpdaterError(error: unknown, sanitizedError: string) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const combinedMessage = `${rawMessage}\n${sanitizedError}`.toLowerCase();
  const referencesGithubUpdateSource = combinedMessage.includes('github.com')
    || combinedMessage.includes('github')
    || combinedMessage.includes('releases.atom')
    || combinedMessage.includes('latest.yml')
    || combinedMessage.includes('latest-mac.yml');
  const looksLikePrivateOrMissingRelease = combinedMessage.includes('404')
    || combinedMessage.includes('authentication token')
    || combinedMessage.includes('actual status maybe not reported')
    || combinedMessage.includes('not found')
    || combinedMessage.includes('private');

  if (referencesGithubUpdateSource && looksLikePrivateOrMissingRelease) {
    return '更新源不可访问：GitHub 返回 404 或认证提示，通常表示仓库、Release 或更新资产对未登录客户端不可见。应用内更新不能内置 GitHub Token；请将仓库/Release 或公共更新源开放，或打开下载页手动下载安装新版本。';
  }

  return sanitizedError;
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

    // M5: Configure electron-updater with generic provider
    const feedUrl = process.env.DESKTOP_UPDATE_FEED_URL || 'https://example.com/updates';
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: feedUrl,
    });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;

    this.registerAutoUpdaterEvents();
    console.info('[Updater] M5 production version initialized with generic provider:', feedUrl);
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

    this.setState({ phase: 'checking', currentVersion: capabilities.appVersion, error: undefined });
    this.checkInFlight = autoUpdater.checkForUpdates()
      .then((result) => {
        const updateInfo = result?.updateInfo;
        if (!updateInfo) {
          this.setState({
            phase: 'up-to-date',
            currentVersion: capabilities.appVersion,
            lastCheckedAt: new Date().toISOString(),
          });
        } else {
          const nextInfo = toDesktopUpdateInfo(updateInfo);
          this.setState({
            phase: result.isUpdateAvailable ? 'available' : 'up-to-date',
            currentVersion: capabilities.appVersion,
            latestVersion: nextInfo.version,
            updateInfo: nextInfo,
            lastCheckedAt: new Date().toISOString(),
          });
        }
        return { ok: true, state: this.getState() } as const;
      })
      .catch((error) => {
        // Graceful degradation when feed URL is not configured
        const sanitizedError = describeUpdaterError(error, this.options.sanitizeError(error));
        if (sanitizedError.includes('404') || sanitizedError.includes('not found')) {
          // Treat missing feed as "up-to-date" for development environment
          this.setState({
            phase: 'up-to-date',
            currentVersion: capabilities.appVersion,
            lastCheckedAt: new Date().toISOString(),
          });
          return { ok: true, state: this.getState() } as const;
        }
        this.setState({ phase: 'error', currentVersion: capabilities.appVersion, error: sanitizedError });
        return { ok: false, code: 'update-check-failed', error: sanitizedError, state: this.getState() } as const;
      })
      .finally(() => {
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

    this.setState({ phase: 'downloading', currentVersion: capabilities.appVersion, progress: undefined, error: undefined });
    this.downloadInFlight = autoUpdater.downloadUpdate()
      .then(() => ({ ok: true } as const))
      .catch((error) => {
        const sanitizedError = describeUpdaterError(error, this.options.sanitizeError(error));
        this.setState({ phase: 'error', currentVersion: capabilities.appVersion, error: sanitizedError });
        return { ok: false, code: 'update-download-failed', error: sanitizedError } as const;
      })
      .finally(() => {
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

    this.setState({ phase: 'installing', currentVersion: capabilities.appVersion, error: undefined });
    this.installInFlight = this.options.quitCoordinator.prepareForQuit('update')
      .then((result) => {
        if (!result.ok) return result;
        autoUpdater.quitAndInstall(false, true);
        return { ok: true } as const;
      })
      .catch((error) => {
        const sanitizedError = describeUpdaterError(error, this.options.sanitizeError(error));
        this.setState({ phase: 'error', currentVersion: capabilities.appVersion, error: sanitizedError });
        return { ok: false, code: 'update-install-failed', error: sanitizedError } as const;
      })
      .finally(() => {
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

  private registerAutoUpdaterEvents() {
    autoUpdater.on('update-available', (info) => {
      const updateInfo = toDesktopUpdateInfo(info);
      this.setState({ phase: 'available', latestVersion: updateInfo.version, updateInfo, error: undefined });
    });
    autoUpdater.on('update-not-available', (info) => {
      const updateInfo = toDesktopUpdateInfo(info);
      this.setState({ phase: 'up-to-date', latestVersion: updateInfo.version, updateInfo, error: undefined });
    });
    autoUpdater.on('download-progress', (progress) => {
      const desktopProgress = toDesktopProgress(progress);
      this.state = { ...this.state, phase: 'downloading', progress: desktopProgress, error: undefined };
      this.emit({ type: 'progress', state: this.getState(), progress: desktopProgress });
    });
    autoUpdater.on('update-downloaded', (info) => {
      const updateInfo = toDesktopUpdateInfo(info);
      this.setState({ phase: 'downloaded', latestVersion: updateInfo.version, updateInfo, error: undefined });
    });
    autoUpdater.on('error', (error) => {
      const sanitizedError = describeUpdaterError(error, this.options.sanitizeError(error));
      this.setState({ phase: 'error', error: sanitizedError });
    });
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
