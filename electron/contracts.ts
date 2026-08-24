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
  OPEN_EXTERNAL: 'desktop:open-external',
  AUTO_START_GET_STATUS: 'desktop:auto-start:get-status',
  AUTO_START_SET_ENABLED: 'desktop:auto-start:set-enabled',
  CHANGE_NOTIFICATION_START: 'desktop:change-notification:start',
  CHANGE_NOTIFICATION_STOP: 'desktop:change-notification:stop',
  CHANGE_NOTIFICATION_MANUAL_CHECK: 'desktop:change-notification:manual-check',
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

// ============================================================================
// Auto-Start Types (M4)
// ============================================================================

export type AutoStartStatus = {
  enabled: boolean;
  willOpenAsHidden: boolean;
};

// ============================================================================
// Change Notification Types (M4)
// ============================================================================

export type ChangedDocument = {
  objToken: string;
  title: string;
  changeType: 'modified' | 'added' | 'deleted';
};

export type ChangeDetectionResult = {
  changed: boolean;
  changedDocuments: ChangedDocument[];
  checkedAt: string;
  totalNodes: number;
};
