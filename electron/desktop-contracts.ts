/**
 * Desktop API Interface Definition
 *
 * Defines the shape of the window.desktop object exposed via contextBridge.
 * This interface is used by preload.ts to type the exposed API.
 */

import type {
  DesktopActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateEvent,
  DesktopUpdateState,
  AutoStartStatus,
  ChangeDetectionResult,
} from './contracts.js';

export interface DesktopAPI {
  /**
   * Get API headers for authenticated requests to embedded server
   * @returns Promise resolving to headers object with X-Desktop-Token
   */
  getApiHeaders: () => Promise<{ 'X-Desktop-Token': string }>;

  /**
   * Get current status of embedded server
   * @returns Promise resolving to server status with running flag and port
   */
  getServerStatus: () => Promise<{ running: boolean; port: number | null }>;

  /**
   * Update operations namespace
   */
  update: {
    /**
     * Get current update state
     */
    getState: () => Promise<DesktopUpdateState>;

    /**
     * Check for available updates
     */
    check: () => Promise<DesktopUpdateCheckResult>;

    /**
     * Download available update
     */
    download: () => Promise<DesktopActionResult>;

    /**
     * Install downloaded update and restart application
     */
    installAndRestart: () => Promise<DesktopActionResult>;

    /**
     * Subscribe to update events (progress, state changes)
     * @param callback - Function to call when update event occurs
     * @returns Unsubscribe function
     */
    onEvent: (callback: (event: DesktopUpdateEvent) => void) => () => void;
  };

  /**
   * Open application data directory in system file manager
   */
  openDataDirectory: () => Promise<DesktopActionResult>;

  /**
   * Open application configuration file in default editor
   */
  openConfigFile: () => Promise<DesktopActionResult>;

  /**
   * Open an external URL in the default browser.
   * Only http:/https: URLs are accepted; other protocols are rejected.
   */
  openExternal: (url: string) => Promise<DesktopActionResult>;

  /**
   * Auto-start operations namespace (M4)
   */
  autoStart: {
    /**
     * Get current auto-start status
     */
    getStatus: () => Promise<AutoStartStatus>;

    /**
     * Enable or disable auto-start
     * @param enabled - Whether to enable auto-start on OS login
     */
    setEnabled: (enabled: boolean) => Promise<DesktopActionResult>;
  };

  /**
   * Change notification operations namespace (M4)
   */
  changeNotification: {
    /**
     * Start polling for changes
     * @param pollIntervalMinutes - Polling interval in minutes (default: 30)
     */
    start: (pollIntervalMinutes?: number) => Promise<DesktopActionResult>;

    /**
     * Stop polling for changes
     */
    stop: () => Promise<DesktopActionResult>;

    /**
     * Manually trigger a change detection check
     */
    manualCheck: () => Promise<ChangeDetectionResult>;
  };
}
