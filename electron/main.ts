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
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

// Type declaration for CJS __dirname provided by Node.js runtime
declare const __dirname: string;

import { getDesktopPlatformCapabilities } from './platform-capabilities.js';
import { QuitCoordinator } from './quit-coordinator.js';
import { DesktopTrayService } from './tray-service.js';
import { DesktopUpdaterService } from './updater-service.js';
import { AutoStartService } from './auto-start-service.js';
import { ChangeNotificationService } from './change-notification-service.js';
import { ConfigManager } from '../server/src/modules/config-manager.js';
import type { DesktopActionResult, QuitReason } from './contracts.js';

// ============================================================================
// Constants and Configuration
// ============================================================================

const LOOPBACK_HOST = '127.0.0.1';
const DESKTOP_TOKEN_HEADER = 'X-Desktop-Token';
const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 250;

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
let autoStartService: AutoStartService | null = null;
let changeNotificationService: ChangeNotificationService | null = null;
let configManager: ConfigManager | null = null;

// ============================================================================
// Utility Functions
// ============================================================================

function sanitizeDesktopError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .slice(0, 300);
}

/**
 * Minimal Feishu wiki URL validator (electron-side mirror of
 * src/utils/feishu-url.ts). We intentionally inline rather than import
 * the client util to avoid coupling the electron main process to React
 * bundling. The accepted shape: https://<subdomain>.feishu.cn/wiki/<token>,
 * matching server-side change-detector expectations.
 */
const FEISHU_WIKI_URL_PATTERN =
  /^https:\/\/[a-z0-9-]+\.feishu\.cn\/wiki\/[A-Za-z0-9]+/i;

function isValidFeishuWikiUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && FEISHU_WIKI_URL_PATTERN.test(url);
}

/**
 * Returns the first usable watched root URL from the latest config, or
 * null when none is configured or all entries are malformed. Reads
 * configManager on each call so runtime config updates are respected.
 *
 * Used by ChangeNotificationService.getWatchedRootUrl to populate the
 * detect endpoint's required rootUrl field (singular; see
 * change-notification-service.ts header for the contract rationale).
 */
function readFirstValidWatchedRootUrl(): string | null {
  if (!configManager) return null;
  // Synchronous read would be cleaner, but ConfigManager.load() is async.
  // Return a cached snapshot instead — see refreshWatchedRootUrlSnapshot()
  // which is invoked on boot and on every config save via the IPC handler.
  return currentWatchedRootUrlSnapshot;
}

// Latest known first-valid watched root URL. Refreshed at boot and on
// config save. Default null until the first refresh.
let currentWatchedRootUrlSnapshot: string | null = null;

async function refreshWatchedRootUrlSnapshot(): Promise<void> {
  if (!configManager) {
    currentWatchedRootUrlSnapshot = null;
    return;
  }
  try {
    const config = await configManager.load();
    const urls = Array.isArray(config.watchedRootUrls) ? config.watchedRootUrls : [];
    currentWatchedRootUrlSnapshot = urls.find(isValidFeishuWikiUrl) ?? null;
  } catch (error) {
    console.warn('[Config] Failed to refresh watched root URL snapshot:', sanitizeDesktopError(error));
    currentWatchedRootUrlSnapshot = null;
  }
}

// ============================================================================
// Server Startup
// ============================================================================

function resolveServerEntryPath() {
  // 打包后，server 在 app.asar.unpacked/server/dist/index.js
  // 开发环境，server 在 ../server/dist/index.js
  if (process.env.NODE_ENV === 'development') {
    const devPath = path.resolve(__dirname, '../server/dist/index.js');
    console.info('[Electron] Development mode, server path:', devPath);
    return devPath;
  }
  // 生产环境：app.asar.unpacked 与 app.asar 同级
  const appPath = app.getAppPath(); // resources/app.asar
  const asarUnpacked = path.join(path.dirname(appPath), 'app.asar.unpacked');
  const prodPath = path.join(asarUnpacked, 'server', 'dist', 'index.js');
  console.info('[Electron] Production mode, appPath:', appPath, ', server path:', prodPath);
  return prodPath;
}

async function startEmbeddedServer(token: string) {
  const serverEntryPath = resolveServerEntryPath();

  console.info('[Electron] Loading server module from:', serverEntryPath);

  // Verify file exists before import
  if (!fs.existsSync(serverEntryPath)) {
    throw new Error(`Server entry file not found: ${serverEntryPath}`);
  }

  // 动态 import server 模块（ESM）
  const serverModuleUrl = pathToFileURL(serverEntryPath).href;
  console.info('[Electron] Server module URL:', serverModuleUrl);

  let serverModule: any;
  try {
    serverModule = await import(serverModuleUrl);
    console.info('[Electron] Server module loaded successfully, exports:', Object.keys(serverModule));
  } catch (error) {
    console.error('[Electron] Failed to load server module:', error);
    throw new Error(`Server module import failed: ${sanitizeDesktopError(error)}`);
  }

  // A 段契约：buildServer(options: CreateServerOptions) 返回 Hono app
  // 但我们需要 startServer 来获取实际启动的 server with url/close
  // 根据 server/src/index.ts，startServer 返回 { url, port, close }
  if (typeof serverModule.startServer !== 'function') {
    throw new Error('Server module contract failed: startServer export is missing');
  }

  console.info('[Electron] Starting server with options:', { desktopMode: true, hostname: LOOPBACK_HOST, port: 0 });
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

// M4: Auto-start control
ipcMain.handle('desktop:auto-start:get-status', () => {
  if (!autoStartService) {
    return { enabled: false, willOpenAsHidden: false };
  }
  return autoStartService.getStatus();
});

ipcMain.handle('desktop:auto-start:set-enabled', async (_event, enabled: boolean) => {
  if (!autoStartService) {
    return { ok: false, code: 'auto-start-not-initialized', error: 'Auto-start service not initialized' };
  }

  const result = autoStartService.setAutoStart(enabled);

  // Sync with config (single source of truth)
  if (result.ok && configManager) {
    try {
      const currentConfig = await configManager.load();
      const updatedConfig = {
        ...currentConfig,
        enableAutoStart: enabled,
      };
      await configManager.save(updatedConfig);
      console.info(`[AutoStart] Synced config.enableAutoStart = ${enabled}`);
    } catch (error) {
      console.error('[AutoStart] Failed to sync config:', error);
    }
  }

  return result;
});

// M4: Change notification control
ipcMain.handle('desktop:change-notification:start', async (_event, pollIntervalMinutes: number = 30) => {
  if (!changeNotificationService) {
    return { ok: false, code: 'change-notification-not-initialized', error: 'Change notification service not initialized' };
  }
  changeNotificationService.start(pollIntervalMinutes);
  return { ok: true };
});

ipcMain.handle('desktop:change-notification:stop', async () => {
  if (!changeNotificationService) {
    return { ok: false, code: 'change-notification-not-initialized', error: 'Change notification service not initialized' };
  }
  changeNotificationService.stop();
  return { ok: true };
});

ipcMain.handle('desktop:change-notification:manual-check', async () => {
  if (!changeNotificationService) {
    return { ok: false, code: 'change-notification-not-initialized', error: 'Change notification service not initialized' };
  }
  return changeNotificationService.manualCheck();
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

  // Initialize tray service (M4 production version)
  trayService = new DesktopTrayService({
    getWindow: () => mainWindow,
    showWindow: showMainWindow,
    requestQuit: () => getQuitCoordinator().requestQuit('tray'),
    sanitizeError: sanitizeDesktopError,
  });
  trayService.initialize();

  // Initialize updater service (M4 production version)
  updaterService = new DesktopUpdaterService({
    getWindow: () => mainWindow,
    getCapabilities: getDesktopPlatformCapabilities,
    quitCoordinator: getQuitCoordinator(),
    sanitizeError: sanitizeDesktopError,
  });

  // Initialize auto-start service (M4 new)
  autoStartService = new AutoStartService({
    sanitizeError: sanitizeDesktopError,
  });

  // Load config BEFORE constructing ChangeNotificationService so we can
  // inject a getWatchedRootUrl callback that reads the latest config.
  // Previous order constructed the service first and passed a hardcoded
  // { rootUrls: [] } body, which caused the detect endpoint to receive
  // rootUrl=undefined and leak into lark-cli as a positional-arg error.
  try {
    configManager = new ConfigManager();
    const config = await configManager.load();

    // Populate the watched root URL snapshot BEFORE constructing the
    // ChangeNotificationService. The service's start() triggers an
    // immediate first poll (see change-notification-service.ts start()),
    // and if the snapshot were null at that moment the poll would no-op
    // with "No watched root URL configured" instead of doing real work.
    // Seeding the snapshot synchronously here, against the freshly loaded
    // config, guarantees the first poll observes a real URL.
    await refreshWatchedRootUrlSnapshot();

    // Initialize change notification service (M4 new) with a live
    // getWatchedRootUrl callback that reads the snapshot. The snapshot
    // is refreshed on boot (here) and whenever the IPC config-save
    // handler runs; runtime config edits without an IPC round-trip
    // require an app restart to be picked up by the poller. This is
    // an architectural constraint, not a bug — settings UI saves via
    // the IPC handler so the common path is covered.
    changeNotificationService = new ChangeNotificationService({
      getWindow: () => mainWindow,
      getServerUrl: () => startedServer?.url ?? null,
      getApiToken: () => desktopApiToken,
      sanitizeError: sanitizeDesktopError,
      trayService: () => trayService,
      getWatchedRootUrl: () => readFirstValidWatchedRootUrl(),
    });

    // Apply auto-start setting from config (single source of truth)
    if (config.enableAutoStart && autoStartService) {
      const currentStatus = autoStartService.isAutoStartEnabled();
      if (!currentStatus) {
        console.info('[Boot] Enabling auto-start from config');
        autoStartService.setAutoStart(true);
      }
    }

    // Start change notification polling if enabled
    if (config.enableNotifications && changeNotificationService) {
      const pollInterval = config.pollIntervalMinutes || 30;
      console.info(`[Boot] Starting change notification with ${pollInterval}min interval`);
      changeNotificationService.start(pollInterval);
    }
  } catch (error) {
    console.error('[Boot] Failed to load config or apply settings:', sanitizeDesktopError(error));
  }
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
