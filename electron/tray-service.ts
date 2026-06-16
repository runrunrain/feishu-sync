/**
 * Tray Service (Minimal M0 Version)
 *
 * Manages system tray icon and menu for background residence.
 * M0 provides minimal functionality; M4 will add template icons, notifications, and polish.
 *
 * Adapted from tts-voice-generator/tray-service.ts with minimal M0 implementation
 */

import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopActionResult } from './contracts.js';

type DesktopTrayServiceOptions = {
  getWindow: () => BrowserWindow | null;
  showWindow: () => BrowserWindow | null;
  requestQuit: () => Promise<DesktopActionResult>;
  sanitizeError: (error: unknown) => string;
};

export class DesktopTrayService {
  private tray: Tray | null = null;
  private disabledReason: string | null = null;

  constructor(private readonly options: DesktopTrayServiceOptions) {}

  initialize(): DesktopActionResult {
    if (this.tray) {
      return { ok: true };
    }

    try {
      const icon = nativeImage.createFromPath(this.resolveTrayIconPath());

      // M0: Development-friendly fallback - use empty icon with tooltip instead of crashing
      // M4 will add proper template icon handling and 1x1 transparent placeholder
      if (icon.isEmpty() && !app.isPackaged) {
        // In development, create a minimal 1x1 placeholder to avoid crashes
        const emptyIcon = nativeImage.createEmpty();
        this.tray = new Tray(emptyIcon);
        this.tray.setToolTip('Feishu Sync (Development Mode)');
        console.warn('[Tray] Icon not found in development, using empty placeholder. M4 will add proper icon handling.');
      } else if (icon.isEmpty()) {
        this.disabledReason = 'Tray icon resource is empty or unreadable.';
        return { ok: false, code: 'tray-icon-unavailable', error: this.disabledReason };
      } else {
        if (process.platform === 'darwin') {
          icon.setTemplateImage(true);
        }
        this.tray = new Tray(icon);
        this.tray.setToolTip('Feishu Sync');
      }

      this.tray.on('click', () => {
        this.showWindow();
      });
      this.refreshMenu();
      return { ok: true };
    } catch (error) {
      this.disabledReason = this.options.sanitizeError(error);
      return { ok: false, code: 'tray-initialization-failed', error: this.disabledReason };
    }
  }

  refreshMenu() {
    if (!this.tray) return;
    const window = this.options.getWindow();
    const visible = Boolean(window && !window.isDestroyed() && window.isVisible());
    const menu = Menu.buildFromTemplate([
      {
        label: '显示窗口',
        enabled: !visible,
        click: () => {
          this.showWindow();
        },
      },
      {
        label: '隐藏窗口',
        enabled: visible,
        click: () => {
          this.hideWindow();
        },
      },
      { type: 'separator' },
      {
        label: '退出 Feishu Sync',
        click: () => {
          void this.options.requestQuit();
        },
      },
    ]);
    this.tray.setContextMenu(menu);
  }

  dispose() {
    this.tray?.destroy();
    this.tray = null;
  }

  getDisabledReason() {
    return this.disabledReason;
  }

  isAvailable() {
    return Boolean(this.tray);
  }

  showNotification(options: { title: string; body: string }) {
    // M0: Minimal stub - M4 will implement proper notification display
    if (!this.tray) return;
    console.info(`[Tray Notification] ${options.title}: ${options.body}`);
    // M4 will use this.tray.display Balloon or nativeNotification
  }

  private showWindow() {
    const window = this.options.showWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    this.refreshMenu();
  }

  private hideWindow() {
    const window = this.options.getWindow();
    if (window && !window.isDestroyed()) {
      window.hide();
    }
    this.refreshMenu();
  }

  private resolveTrayIconPath() {
    const fileName = process.platform === 'darwin' ? 'tray-iconTemplate.png' : 'tray-icon.ico';
    const candidates = app.isPackaged
      ? [
          path.join(process.resourcesPath, 'build', fileName),
          path.join(process.resourcesPath, fileName),
        ]
      : [
          path.join(process.cwd(), 'build', fileName),
          path.join(app.getAppPath(), 'build', fileName),
          path.join(process.cwd(), '..', 'build', fileName),
        ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
  }
}
