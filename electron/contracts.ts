/**
 * IPC Channel Names and Type Definitions
 *
 * Defines all IPC channel constants used between main and preload processes.
 */

// ============================================================================
// IPC Channel Names
// ============================================================================

export const IPC_CHANNELS = {
  GET_API_HEADERS: 'desktop:get-api-headers',
  GET_SERVER_STATUS: 'desktop:get-server-status',
  UPDATE_GET_STATE: 'desktop:update:get-state',
  UPDATE_CHECK: 'desktop:update:check',
  UPDATE_DOWNLOAD: 'desktop:update:download',
  UPDATE_INSTALL_AND_RESTART: 'desktop:update:install-and-restart',
  OPEN_DATA_DIRECTORY: 'desktop:open-data-directory',
  OPEN_CONFIG_FILE: 'desktop:open-config-file',
} as const;

// ============================================================================
// Common Types
// ============================================================================

export type DesktopActionResult =
  | { ok: true }
  | { ok: false; code: string; error: string };

export type QuitReason = "tray" | "system" | "update" | "startup-failure";

// ============================================================================
// Update Types
// ============================================================================

export type DesktopUpdatePhase =
  | "idle"
  | "unsupported"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export type DesktopPlatformCapabilities = {
  platform: NodeJS.Platform;
  arch: string;
  appVersion: string;
  packaged: boolean;
  systemTraySupported: boolean;
  hideOnCloseSupported: boolean;
  backgroundResidentSupported: boolean;
  singleInstanceSupported: boolean;
  updateCheckSupported: boolean;
  updateDownloadSupported: boolean;
  updateInstallSupported: boolean;
  updateInstallUnsupportedReason?: string;
  updateProvider: "generic";
  releasePageUrl: string;
};

export type DesktopUpdateInfo = {
  version: string;
  releaseDate?: string;
  releaseName?: string;
  releaseNotes?: string;
};

export type DesktopDownloadProgress = {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

export type DesktopUpdateState = {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  updateInfo?: DesktopUpdateInfo;
  progress?: DesktopDownloadProgress;
  error?: string;
  lastCheckedAt?: string;
};

export type DesktopUpdateCheckResult =
  | { ok: true; state: DesktopUpdateState }
  | { ok: false; code: string; error: string; state: DesktopUpdateState };

export type DesktopUpdateEvent =
  | { type: "state"; state: DesktopUpdateState }
  | { type: "progress"; state: DesktopUpdateState; progress: DesktopDownloadProgress };
