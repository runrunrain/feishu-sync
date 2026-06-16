/**
 * Electron Main Process Entry Point
 *
 * Manages application lifecycle, embedded server startup, window management,
 * IPC handlers, tray service, and updater service.
 *
 * Adapted from tts-voice-generator/main.ts with feishu-sync adaptations
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell, globalShortcut } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

import { getDesktopPlatformCapabilities } from './platform-capabilities.js';
import { QuitCoordinator } from './quit-coordinator.js';
import { DesktopTrayService } from './tray-service.js';
import { DesktopUpdaterService } from './updater-service.js';
import type { DesktopActionResult, QuitReason } from './contracts.js';

// ============================================================================
// Constants and Configuration
// ============================================================================

const LOOPBACK_HOST = '127.0.0.1';
const DESKTOP_TOKEN_HEADER = 'X-Desktop-Token';
const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 250;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// State Management
// ============================================================================

type StartedServer = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

let mainWindow: BrowserWindow | null = null;
let startedServer: StartedServer | null = null;
let desktopApiToken: string | null = null;
let desktopDataDir: string | null = null;
let quitCoordinator: QuitCoordinator | null = null;
let trayService: DesktopTrayService | null = null;
let updaterService: DesktopUpdaterService | null = null;

// ============================================================================
// Utility Functions
// ============================================================================

function sanitizeDesktopError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .slice(0, 300);
}

// ============================================================================
// Server Startup
// ============================================================================

function resolveServerEntryPath() {
  // A 段产物：server/dist/index.js 是编译后的 CommonJS 模块
  return path.resolve(__dirname, '../server/dist/index.js');
}

async function startEmbeddedServer(token: string) {
  const serverEntryPath = resolveServerEntryPath();

  // 动态 import 编译后的 server 模块
  const serverModuleUrl = pathToFileURL(serverEntryPath).href;
  const serverModule = await import(serverModuleUrl);

  // A 段契约：buildServer(options: CreateServerOptions) 返回 Hono app
  // 但我们需要 startServer 来获取实际启动的 server with url/close
  // 根据 server/src/index.ts，startServer 返回 { url, port, close }
  if (typeof serverModule.startServer !== 'function') {
    throw new Error('Server module contract failed: startServer export is missing');
  }

  const started = await serverModule.startServer({
    desktopMode: true,
    desktopToken: token,
    hostname: LOOPBACK_HOST,
    port: 0, // Auto-select available port
  });

  if (!started || !started.url || typeof started.close !== 'function') {
    throw new Error('Server start contract failed: invalid result structure');
  }

  startedServer = started;
  console.info(`[Electron] Embedded server started on ${started.url}`);
}

async function waitForHealth(serverUrl: string) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`Health check failed with HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Health check failed');
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  throw lastError ?? new Error('Health check timed out');
}

// ============================================================================
// Window Management
// ============================================================================

function createMainWindow() {
  if (!startedServer) {
    throw new Error('Cannot create window before server is running');
  }

  const preloadPath = path.join(__dirname, 'preload.cjs');
  const allowedOrigin = new URL(startedServer.url).origin;

  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
    trayService?.refreshMenu();
  });

  window.on('close', (event) => {
    if (!quitCoordinator?.isQuitRequested() && trayService?.isAvailable()) {
      event.preventDefault();
      window.hide();
      trayService?.refreshMenu();
    }
  });

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
    trayService?.refreshMenu();
  });

  window.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      if (new URL(targetUrl).origin !== allowedOrigin) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Load frontend based on environment
  if (process.env.NODE_ENV === 'development') {
    window.loadURL('http://localhost:5173').catch((error) => {
      console.error('[Electron] Failed to load dev server:', error);
    });
    window.webContents.openDevTools();
  } else {
    window.loadFile(path.join(__dirname, '../dist/index.html')).catch((error) => {
      console.error('[Electron] Failed to load production build:', error);
    });
  }

  mainWindow = window;
  trayService?.refreshMenu();
  return window;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!startedServer) return null;
    createMainWindow();
  }
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  trayService?.refreshMenu();
  return mainWindow;
}

// ============================================================================
// Quit Coordination
// ============================================================================

async function closeServer() {
  const server = startedServer;
  startedServer = null;
  if (server) {
    await server.close();
    console.info('[Electron] Embedded server closed');
  }
}

function getQuitCoordinator() {
  if (!quitCoordinator) {
    quitCoordinator = new QuitCoordinator({
      closeServer,
      sanitizeError: sanitizeDesktopError,
      onBeforeQuit: (reason: QuitReason) => {
        trayService?.dispose();
      },
    });
  }
  return quitCoordinator;
}

// ============================================================================
// IPC Handlers
// ============================================================================

ipcMain.handle('desktop:get-api-headers', () => {
  if (!desktopApiToken) {
    throw new Error('Desktop API token is not initialized');
  }
  return { [DESKTOP_TOKEN_HEADER]: desktopApiToken };
});

ipcMain.handle('desktop:get-server-status', () => ({
  running: Boolean(startedServer),
  port: startedServer?.port ?? null,
}));

ipcMain.handle('desktop:open-data-directory', async () => {
  if (!desktopDataDir) {
    return { ok: false, code: 'data-directory-uninitialized', error: 'Data directory is not initialized' };
  }
  const result = await shell.openPath(desktopDataDir);
  return result ? { ok: false, code: 'open-data-directory-failed', error: sanitizeDesktopError(result) } : { ok: true };
});

ipcMain.handle('desktop:open-config-file', async () => {
  // M0: Stub implementation - config file path will be determined in M1-M3
  const configPath = path.join(app.getPath('userData'), 'config.json');
  const result = await shell.openPath(configPath);
  return result ? { ok: false, code: 'open-config-file-failed', error: sanitizeDesktopError(result) } : { ok: true };
});

ipcMain.handle('desktop:update:get-state', () => {
  if (updaterService) return updaterService.getState();
  const capabilities = getDesktopPlatformCapabilities();
  return {
    phase: 'unsupported',
    currentVersion: capabilities.appVersion,
    error: '桌面更新服务尚未初始化。',
  };
});

ipcMain.handle('desktop:update:check', async () => {
  if (!updaterService) {
    const capabilities = getDesktopPlatformCapabilities();
    return {
      ok: false,
      code: 'updater-not-initialized',
      error: '桌面更新服务尚未初始化。',
      state: {
        phase: 'unsupported',
        currentVersion: capabilities.appVersion,
        error: '桌面更新服务尚未初始化。',
      },
    };
  }
  return updaterService.check();
});

ipcMain.handle('desktop:update:download', async () => {
  if (!updaterService) {
    return { ok: false, code: 'updater-not-initialized', error: '桌面更新服务尚未初始化。' };
  }
  return updaterService.download();
});

ipcMain.handle('desktop:update:install-and-restart', async () => {
  if (!updaterService) {
    return { ok: false, code: 'updater-not-initialized', error: '桌面更新服务尚未初始化。' };
  }
  return updaterService.installAndRestart();
});

// ============================================================================
// Application Lifecycle
// ============================================================================

async function boot() {
  // Get quit coordinator ready
  getQuitCoordinator();

  // Configure security
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  // Generate desktop API token
  desktopApiToken = crypto.randomBytes(32).toString('base64url');
  desktopDataDir = app.getPath('userData');
  console.info('[Electron] Desktop API token generated, data directory:', desktopDataDir);

  // Start embedded server
  await startEmbeddedServer(desktopApiToken);
  await waitForHealth(startedServer!.url);

  // Create main window
  createMainWindow();

  // Initialize tray service (minimal M0 version)
  trayService = new DesktopTrayService({
    getWindow: () => mainWindow,
    showWindow: showMainWindow,
    requestQuit: () => getQuitCoordinator().requestQuit('tray'),
    sanitizeError: sanitizeDesktopError,
  });
  trayService.initialize();

  // Initialize updater service (skeleton M0 version)
  updaterService = new DesktopUpdaterService({
    getWindow: () => mainWindow,
    getCapabilities: getDesktopPlatformCapabilities,
    quitCoordinator: getQuitCoordinator(),
    sanitizeError: sanitizeDesktopError,
  });
}

// ============================================================================
// App Event Handlers
// ============================================================================

app.on('window-all-closed', () => {
  if (!trayService?.isAvailable() && !getQuitCoordinator().isQuitRequested()) {
    void getQuitCoordinator().requestQuit('system');
    return;
  }
  trayService?.refreshMenu();
});

app.on('activate', () => {
  if (startedServer) showMainWindow();
});

app.on('before-quit', (event) => {
  getQuitCoordinator().handleBeforeQuit(event);
});

// Global shortcut for showing window
app.whenReady().then(() => {
  globalShortcut.register('CommandOrControl+Shift+F', () => {
    showMainWindow();
  });
});

// Will-quit cleanup
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  void closeServer();
});

// ============================================================================
// Single Instance Lock
// ============================================================================

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady()
    .then(boot)
    .catch(async (error) => {
      await closeServer().catch(() => undefined);
      const message = sanitizeDesktopError(error instanceof Error ? error : 'Unknown startup error');
      dialog.showErrorBox('Feishu Sync failed to start', message);
      app.exit(1);
    });
}
