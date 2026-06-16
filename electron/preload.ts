/**
 * Preload Script
 *
 * Exposes secure IPC API to renderer process via contextBridge.
 * All renderer-to-main communication MUST go through these methods.
 *
 * Adapted from tts-voice-generator/preload.ts
 */

import { contextBridge, ipcRenderer } from 'electron';
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
