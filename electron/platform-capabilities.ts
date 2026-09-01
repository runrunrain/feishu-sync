/**
 * Platform Capabilities
 *
 * Detects platform capabilities for update, tray, and system integration features.
 *
 * Adapted from tts-voice-generator/platform-capabilities.ts
 */

import { app } from 'electron';
import type { DesktopPlatformCapabilities } from './contracts.js';

const DEFAULT_GITHUB_REPOSITORY = 'runrunrain/feishu-sync';

function resolveGitHubRepository() {
  const rawRepository = process.env.GITHUB_REPOSITORY?.trim() || DEFAULT_GITHUB_REPOSITORY;
  const [owner, repo] = rawRepository.split('/').map((part) => part.trim());
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    const [defaultOwner, defaultRepo] = DEFAULT_GITHUB_REPOSITORY.split('/');
    return { owner: defaultOwner, repo: defaultRepo };
  }
  return { owner, repo };
}

export function getReleasePageUrl() {
  const { owner, repo } = resolveGitHubRepository();
  return `https://github.com/${owner}/${repo}/releases/latest`;
}

/**
 * electron-updater generic provider 的运行时 feed 地址。
 *
 * 与 electron-builder.config.cjs 的 resolveUpdateFeedUrl 保持同一解析规则：
 *   1. 显式 DESKTOP_UPDATE_FEED_URL 覆盖（自建更新源/内网镜像）；
 *   2. 缺省指向 GitHub Releases 最新版的稳定下载入口
 *      https://github.com/<owner>/<repo>/releases/latest/download/，
 *      该路径 302 到最新（非 draft、非 prerelease）release 的同名资产，
 *      与 release.yml 上传的 latest.yml / latest-mac.yml 及安装包配套。
 *
 * 构建侧差异：builder 在非法覆盖时直接抛错（打包应当尽早失败）；
 * 运行时非法配置不应导致应用启动崩溃，这里回退到 GitHub 缺省地址
 * 并告警（此前该处是 example.com 占位符，应用内更新从未真正可用）。
 */
export function getUpdateFeedUrl() {
  const { owner, repo } = resolveGitHubRepository();
  const defaultFeedUrl = `https://github.com/${owner}/${repo}/releases/latest/download/`;
  const configured = process.env.DESKTOP_UPDATE_FEED_URL?.trim();
  if (!configured) return defaultFeedUrl;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'https:') throw new Error('必须使用 https://');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('不允许携带凭据、查询串或片段');
    }
    return parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
  } catch (error) {
    console.warn(
      '[PlatformCapabilities] Invalid DESKTOP_UPDATE_FEED_URL, falling back to GitHub releases feed:',
      error instanceof Error ? error.message : error,
    );
    return defaultFeedUrl;
  }
}

function isSupportedDesktopPlatform(platform: NodeJS.Platform) {
  return platform === 'darwin' || platform === 'win32';
}

function resolveInstallUnsupportedReason(platform: NodeJS.Platform, packaged: boolean) {
  if (!packaged) {
    return '应用内更新仅在已打包安装的桌面应用中可用。';
  }
  if (!isSupportedDesktopPlatform(platform)) {
    return '当前平台暂不支持应用内更新安装。';
  }
  if (platform === 'darwin' && process.env.FEISHU_SYNC_ENABLE_MAC_AUTO_UPDATE !== 'true') {
    return 'macOS 自动安装需要签名和公证；当前构建仅支持检查更新和打开下载页。';
  }
  return undefined;
}

export function getDesktopPlatformCapabilities(): DesktopPlatformCapabilities {
  const platform = process.platform;
  const packaged = app.isPackaged;
  const platformSupported = isSupportedDesktopPlatform(platform);
  const updateInstallUnsupportedReason = resolveInstallUnsupportedReason(platform, packaged);
  const updateCheckSupported = packaged && platformSupported;
  const updateInstallSupported = updateCheckSupported && !updateInstallUnsupportedReason;

  return {
    platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    packaged,
    systemTraySupported: platformSupported,
    hideOnCloseSupported: platformSupported,
    backgroundResidentSupported: platformSupported,
    singleInstanceSupported: platformSupported,
    updateCheckSupported,
    updateDownloadSupported: updateCheckSupported,
    updateInstallSupported,
    ...(updateInstallUnsupportedReason ? { updateInstallUnsupportedReason } : {}),
    updateProvider: 'generic',
    releasePageUrl: getReleasePageUrl(),
  };
}

export function isTrustedReleasePageUrl(url: string) {
  const releasePageUrl = new URL(getReleasePageUrl());
  const candidate = new URL(url);
  return candidate.protocol === 'https:'
    && candidate.hostname === 'github.com'
    && candidate.pathname === releasePageUrl.pathname;
}
