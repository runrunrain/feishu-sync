/**
 * useDesktopUpdate - 桌面版本检查与更新全局状态 Hook（2026-09 对齐 electron/contracts.ts）
 *
 * 功能：
 *   - 统一管理 Electron 状态机（phase: idle/checking/available/downloading/downloaded/up-to-date/error/unsupported）
 *   - 自动获取真实应用版本（capabilities.appVersion / updateState.currentVersion / __APP_VERSION__）
 *   - 模块级单例状态广播：总览页、顶部栏、设置卡片共享同一状态，任意位置触发检查/更新，全界面同步响应
 *   - 导出结构化 versionTip（由 src/utils/versionTip 驱动），提供精准的版本号对比与多状态提示
 *   - 兼容保留 useDesktopUpdateBadge()，供 TopBar 徽标使用
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { appLogger } from '../utils/appLogger';
import { generateVersionTip, type VersionTip } from '../utils/versionTip';
import type {
  DesktopActionResult,
  DesktopDownloadProgress,
  DesktopPlatformCapabilities,
  DesktopUpdateCheckResult,
  DesktopUpdateEvent,
  DesktopUpdatePhase,
  DesktopUpdateState,
} from '../types';

// 构建时由 vite 注入（package.json version），浏览器及开发环境兜底。
declare const __APP_VERSION__: string;

export interface DesktopUpdateContextValue {
  /** 当前版本号（形如 'v0.3.7'） */
  currentVersion: string;
  /** 最新版本号（形如 'v0.3.8' 或 null） */
  latestVersion: string | null;
  /** 当前更新阶段 */
  phase: DesktopUpdatePhase;
  /** 完整更新状态快照 */
  updateState: DesktopUpdateState | null;
  /** 桌面平台能力 */
  capabilities: DesktopPlatformCapabilities | null;
  /** 下载进度信息 */
  progress?: DesktopDownloadProgress;
  /** 错误信息 */
  error?: string;
  /** 是否正在执行检查操作 */
  isChecking: boolean;
  /** 是否正在执行下载操作 */
  isDownloading: boolean;
  /** 是否正在执行安装操作 */
  isInstalling: boolean;
  /** 是否在支持更新的桌面环境下运行 */
  isSupported: boolean;
  /** 基于版本号对比与更新阶段计算的提示信息 */
  versionTip: VersionTip;
  /** 手动触发检查更新 */
  checkUpdate: () => Promise<DesktopUpdateCheckResult | null>;
  /** 手动触发下载更新包 */
  downloadUpdate: () => Promise<DesktopActionResult | null>;
  /** 手动触发安装并重启 */
  installAndRestart: () => Promise<DesktopActionResult | null>;
  /** 在系统默认浏览器中打开外部发布页 */
  openReleasePage: () => Promise<void>;
}

// 模块级单例共享状态，保证多组件协同无时差
interface SharedUpdateStore {
  updateState: DesktopUpdateState | null;
  capabilities: DesktopPlatformCapabilities | null;
  isChecking: boolean;
  isDownloading: boolean;
  isInstalling: boolean;
  initialized: boolean;
}

const sharedStore: SharedUpdateStore = {
  updateState: null,
  capabilities: null,
  isChecking: false,
  isDownloading: false,
  isInstalling: false,
  initialized: false,
};

type StoreListener = () => void;
const listeners = new Set<StoreListener>();

function emitStoreChange() {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      appLogger.error('useDesktopUpdate', 'store listener error', err);
    }
  }
}

function isDesktopAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.desktop);
}

function isUpdateApiAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.desktop) &&
    Boolean(window.desktop?.update) &&
    typeof window.desktop?.update?.getState === 'function'
  );
}

// 单例事件订阅与初始化守卫
let ipcSubscribed = false;

function ensureGlobalUpdateSubscription() {
  if (ipcSubscribed) return;
  if (!isUpdateApiAvailable()) return;

  ipcSubscribed = true;
  const updateApi = window.desktop!.update;

  // 1. 初始化拉取能力和当前状态
  if (typeof window.desktop!.getPlatformCapabilities === 'function') {
    window.desktop!
      .getPlatformCapabilities()
      .then((caps) => {
        sharedStore.capabilities = caps;
        emitStoreChange();
      })
      .catch((err) => {
        appLogger.warn('useDesktopUpdate', 'getPlatformCapabilities failed (non-fatal)', err);
      });
  }

  updateApi
    .getState()
    .then((state) => {
      sharedStore.updateState = state;
      sharedStore.initialized = true;
      emitStoreChange();
    })
    .catch((err) => {
      appLogger.warn('useDesktopUpdate', 'getState failed (non-fatal)', err);
    });

  // 2. 监听主进程广播事件
  updateApi.onEvent((event: DesktopUpdateEvent) => {
    sharedStore.updateState = event.state;
    if (event.type === 'progress') {
      sharedStore.isDownloading = true;
    } else if (event.state.phase !== 'downloading') {
      sharedStore.isDownloading = false;
    }
    if (event.state.phase !== 'checking') {
      sharedStore.isChecking = false;
    }
    if (event.state.phase !== 'installing') {
      sharedStore.isInstalling = false;
    }
    emitStoreChange();
  });
}

/**
 * 核心 Hook：返回全功能的桌面更新状态机与操作函数
 */
export function useDesktopUpdate(): DesktopUpdateContextValue {
  const [, setTick] = useState(0);

  useEffect(() => {
    ensureGlobalUpdateSubscription();
    const handleStoreChange = () => setTick((t) => t + 1);
    listeners.add(handleStoreChange);
    return () => {
      listeners.delete(handleStoreChange);
    };
  }, []);

  const { updateState, capabilities, isChecking, isDownloading, isInstalling } = sharedStore;

  const fallbackVersion =
    typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__ ? __APP_VERSION__ : '0.0.0';

  const rawCurrentVersion =
    capabilities?.appVersion || updateState?.currentVersion || fallbackVersion;

  const currentVersion = rawCurrentVersion.startsWith('v')
    ? rawCurrentVersion
    : `v${rawCurrentVersion}`;

  const rawLatestVersion = updateState?.latestVersion;
  const latestVersion = rawLatestVersion
    ? rawLatestVersion.startsWith('v')
      ? rawLatestVersion
      : `v${rawLatestVersion}`
    : null;

  const phase: DesktopUpdatePhase = updateState?.phase ?? (isUpdateApiAvailable() ? 'idle' : 'unsupported');
  const progress = updateState?.progress;
  const error = updateState?.error;
  const isSupported = capabilities?.updateCheckSupported ?? isUpdateApiAvailable();

  const versionTip = useMemo(() => {
    return generateVersionTip({
      currentVersion,
      latestVersion,
      phase,
      progress,
      error,
      isChecking,
    });
  }, [currentVersion, latestVersion, phase, progress, error, isChecking]);

  const checkUpdate = useCallback(async (): Promise<DesktopUpdateCheckResult | null> => {
    if (!isUpdateApiAvailable()) {
      return null;
    }
    sharedStore.isChecking = true;
    emitStoreChange();

    try {
      const result = await window.desktop!.update.check();
      if (result.ok) {
        sharedStore.updateState = result.state;
      }
      return result;
    } catch (err) {
      appLogger.error('useDesktopUpdate', 'checkUpdate error', err);
      return null;
    } finally {
      sharedStore.isChecking = false;
      emitStoreChange();
    }
  }, []);

  const downloadUpdate = useCallback(async (): Promise<DesktopActionResult | null> => {
    if (!isUpdateApiAvailable()) return null;
    sharedStore.isDownloading = true;
    emitStoreChange();

    try {
      const result = await window.desktop!.update.download();
      return result;
    } catch (err) {
      appLogger.error('useDesktopUpdate', 'downloadUpdate error', err);
      return null;
    } finally {
      sharedStore.isDownloading = false;
      emitStoreChange();
    }
  }, []);

  const installAndRestart = useCallback(async (): Promise<DesktopActionResult | null> => {
    if (!isUpdateApiAvailable()) return null;
    sharedStore.isInstalling = true;
    emitStoreChange();

    try {
      const result = await window.desktop!.update.installAndRestart();
      return result;
    } catch (err) {
      appLogger.error('useDesktopUpdate', 'installAndRestart error', err);
      return null;
    } finally {
      sharedStore.isInstalling = false;
      emitStoreChange();
    }
  }, []);

  const openReleasePage = useCallback(async () => {
    const url = capabilities?.releasePageUrl ?? 'https://github.com/maorun/feishu-sync/releases';
    if (isDesktopAvailable() && typeof window.desktop!.openExternal === 'function') {
      await window.desktop!.openExternal(url);
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, [capabilities?.releasePageUrl]);

  return {
    currentVersion,
    latestVersion,
    phase,
    updateState,
    capabilities,
    progress,
    error,
    isChecking,
    isDownloading,
    isInstalling,
    isSupported,
    versionTip,
    checkUpdate,
    downloadUpdate,
    installAndRestart,
    openReleasePage,
  };
}

/**
 * 保持向后兼容：TopBar 等位置使用的轻量徽标 hook
 */
export interface DesktopUpdateBadge {
  availableVersion: string | null;
}

export function useDesktopUpdateBadge(): DesktopUpdateBadge {
  const { latestVersion, phase } = useDesktopUpdate();
  const availableVersion = phase === 'available' ? latestVersion : null;
  return { availableVersion };
}
