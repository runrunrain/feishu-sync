/**
 * Auto-Start Service
 *
 * Manages application auto-start on OS boot using Electron's built-in app.setLoginItemSettings.
 * Windows: Registry / macOS: LaunchAgent
 *
 * Architecture reference: §6.6 TrayService / §10.4 auto-start
 */

import { app } from 'electron';
import type { DesktopActionResult } from './contracts.js';

type AutoStartServiceOptions = {
  sanitizeError: (error: unknown) => string;
};

export class AutoStartService {
  constructor(private readonly options: AutoStartServiceOptions) {}

  /**
   * Set auto-start enabled/disabled
   */
  setAutoStart(enabled: boolean): DesktopActionResult {
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true, // Start minimized to tray
        name: app.getName(),
        path: process.execPath,
        args: [], // No additional args needed
      });

      console.info(`[AutoStart] Auto-start ${enabled ? 'enabled' : 'disabled'}`);
      return { ok: true };
    } catch (error) {
      const message = this.options.sanitizeError(error);
      console.error('[AutoStart] Failed to set auto-start:', message);
      return { ok: false, code: 'auto-start-failed', error: message };
    }
  }

  /**
   * Check if auto-start is enabled
   */
  isAutoStartEnabled(): boolean {
    try {
      const loginItemSettings = app.getLoginItemSettings();
      return loginItemSettings.openAtLogin || false;
    } catch (error) {
      console.error('[AutoStart] Failed to get auto-start status:', error);
      return false;
    }
  }

  /**
   * Get current auto-start status
   */
  getStatus(): { enabled: boolean; willOpenAsHidden: boolean } {
    try {
      const settings = app.getLoginItemSettings();
      return {
        enabled: settings.openAtLogin || false,
        willOpenAsHidden: settings.openAsHidden || false,
      };
    } catch (error) {
      console.error('[AutoStart] Failed to get status:', error);
      return { enabled: false, willOpenAsHidden: false };
    }
  }
}
