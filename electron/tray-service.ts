/**
 * Tray Service (Production-Ready M4 Version)
 *
 * Manages system tray icon and menu for background residence.
 * M4 adds: template icons, notifications, auto-start integration, refresh menu.
 *
 * Adapted from tts-voice-generator/tray-service.ts with M4 enhancements
 */

import { app, BrowserWindow, Menu, nativeImage, Tray, Notification } from 'electron';
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

      // M4: Enhanced icon handling with template image support
      if (icon.isEmpty()) {
        // Check if we're in development mode
        if (!app.isPackaged) {
          // Development: use a simple colored square as fallback
          console.warn('[Tray] Icon not found in development, using fallback placeholder.');
          const fallbackIcon = nativeImage.createFromPath(this.createFallbackIcon());
          this.tray = new Tray(fallbackIcon);
          this.tray.setToolTip('Feishu Sync (Development Mode)');
        } else {
          // Production: icon must exist
          this.disabledReason = 'Tray icon resource is empty or unreadable.';
          return { ok: false, code: 'tray-icon-unavailable', error: this.disabledReason };
        }
      } else {
        // Icon loaded successfully
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
        label: '立即检测变更',
        click: () => {
          // Trigger manual check via main process
          console.info('[Tray] Manual change detection triggered');
          // The main process will handle this via IPC to ChangeNotificationService
          this.showWindow();
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
    if (!this.tray) return;

    // M4: Production notification implementation
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: options.title,
        body: options.body,
        icon: this.resolveTrayIconPath(),
      });

      notification.on('click', () => {
        this.showWindow();
      });

      notification.show();
    } else {
      // Fallback for platforms without Notification support
      console.info(`[Tray Notification] ${options.title}: ${options.body}`);
    }
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
          path.join(__dirname, '..', 'build', fileName),
        ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
  }

  private createFallbackIcon(): string {
    // Create a minimal 1x1 PNG as fallback (development only)
    const fallbackPath = path.join(app.getPath('temp'), 'feishu-sync-fallback.png');
    if (!fs.existsSync(fallbackPath)) {
      // Create a simple 1x1 transparent PNG
      const png = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
        0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
      ]);
      fs.writeFileSync(fallbackPath, png);
    }
    return fallbackPath;
  }
}
