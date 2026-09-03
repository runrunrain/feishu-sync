/**
 * Preload Script
 *
 * Exposes secure IPC API to renderer process via contextBridge.
 * All renderer-to-main communication MUST go through these methods.
 *
 * Adapted from tts-voice-generator/preload.ts
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type {
  DesktopActionResult,
  DesktopPlatformCapabilities,
  DesktopUpdateCheckResult,
  DesktopUpdateEvent,
  DesktopUpdateState,
  AutoStartStatus,
  ChangeDetectionResult,
} from './contracts.js';
import type { DesktopAPI } from './desktop-contracts.js';

const desktopApi: DesktopAPI = {
  getApiHeaders: async (): Promise<{ 'X-Desktop-Token': string }> => {
    return ipcRenderer.invoke('desktop:get-api-headers');
  },

  getServerStatus: async (): Promise<{ running: boolean; port: number | null }> => {
    return ipcRenderer.invoke('desktop:get-server-status');
  },

  getPlatformCapabilities: async (): Promise<DesktopPlatformCapabilities> => {
    return ipcRenderer.invoke('desktop:get-platform-capabilities');
  },

  update: {
    getState: async (): Promise<DesktopUpdateState> => {
      return ipcRenderer.invoke('desktop:update:get-state');
    },
    check: async (): Promise<DesktopUpdateCheckResult> => {
      return ipcRenderer.invoke('desktop:update:check');
    },
    download: async (): Promise<DesktopActionResult> => {
      return ipcRenderer.invoke('desktop:update:download');
    },
    installAndRestart: async (): Promise<DesktopActionResult> => {
      return ipcRenderer.invoke('desktop:update:install-and-restart');
    },
    onEvent: (callback: (event: DesktopUpdateEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, updateEvent: DesktopUpdateEvent) => {
        callback(updateEvent);
      };
      ipcRenderer.on('desktop:update:event', listener);
      return () => {
        ipcRenderer.removeListener('desktop:update:event', listener);
      };
    },
  },

  openDataDirectory: async (): Promise<DesktopActionResult> => {
    return ipcRenderer.invoke('desktop:open-data-directory');
  },

  openConfigFile: async (): Promise<DesktopActionResult> => {
    return ipcRenderer.invoke('desktop:open-config-file');
  },

  openExternal: async (url: string): Promise<DesktopActionResult> => {
    return ipcRenderer.invoke('desktop:open-external', url);
  },

  revealInFolder: async (absolutePath: string): Promise<DesktopActionResult> => {
    return ipcRenderer.invoke('desktop:reveal-in-folder', absolutePath);
  },

  // 界面缩放（2026-09 高分屏文本模糊缓解）：Win 125%/150% 非整数缩放下
  // 文本光栅化出现半像素发虚，用户可用 Ctrl+= / Ctrl+- / Ctrl+0 微调
  // zoomLevel 到清晰信率。sandboxed preload 允许使用 webFrame。
  // 谛听 Major 1：setLayoutZoomLevel 在 Electron 31.7.7 已移除，改用
  // setZoomLevel（与 getZoomLevel 配对，同一状态增量计算才正确）。
  setZoomLevel: (level: number): void => {
    webFrame.setZoomLevel(Math.max(-3, Math.min(3, level)));
  },
  getZoomLevel: (): number => webFrame.getZoomLevel(),

  autoStart: {
    getStatus: async (): Promise<AutoStartStatus> => {
      return ipcRenderer.invoke('desktop:auto-start:get-status');
    },
    setEnabled: async (enabled: boolean): Promise<DesktopActionResult> => {
      return ipcRenderer.invoke('desktop:auto-start:set-enabled', enabled);
    },
  },

  changeNotification: {
    start: async (pollIntervalMinutes?: number): Promise<DesktopActionResult> => {
      return ipcRenderer.invoke('desktop:change-notification:start', pollIntervalMinutes);
    },
    stop: async (): Promise<DesktopActionResult> => {
      return ipcRenderer.invoke('desktop:change-notification:stop');
    },
    manualCheck: async (): Promise<ChangeDetectionResult> => {
      return ipcRenderer.invoke('desktop:change-notification:manual-check');
    },
  },
};

contextBridge.exposeInMainWorld('desktop', desktopApi);

// Type augmentation for TypeScript in renderer process
export type {};
