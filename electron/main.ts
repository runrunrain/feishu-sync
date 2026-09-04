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
import os from 'node:os';
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

// 2026-09 HiDPI 修复（Win）：显式声明 per-monitor DPI 感知。未声明时
// Windows 会对进程做位图拉伸模拟缩放，高分辨率屏（125%/150% 缩放）上
// 文本发虚。必须在 app ready 之前设置。
app.commandLine.appendSwitch('high-dpi-aware', '1');
// 禁用字体亚像素合成在部分 HiDPI 驱动上的模糊路径，保持色彩一致。
app.commandLine.appendSwitch('force-color-profile', 'srgb');

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
 * Returns ALL valid watched root URLs from the latest config (empty
 * array when none are configured or every entry is malformed). Backed
 * by a snapshot refreshed at boot and on config save.
 *
 * Used by ChangeNotificationService.getWatchedRootUrls to (a) skip the
 * detect poll when no roots are configured, and (b) drive the multi-root
 * /api/detect/changes-all endpoint so EVERY configured root is polled
 * automatically — not just the first. The earlier single-root design
 * (urls.find → first valid) left roots [1..N] never auto-detected.
 *
 * Synchronous read would be cleaner, but ConfigManager.load() is async,
 * so a cached snapshot is returned; see refreshWatchedRootUrlsSnapshot()
 * which is invoked on boot. Runtime config edits without a restart are
 * picked up on the next config-save IPC round-trip if the handler calls
 * the refresh; until then the snapshot reflects the boot-time config.
 */
function readAllValidWatchedRootUrls(): string[] {
  return currentValidWatchedRootUrlsSnapshot;
}

// Latest known set of valid watched root URLs. Refreshed at boot and on
// config save. Default empty until the first refresh.
let currentValidWatchedRootUrlsSnapshot: string[] = [];

async function refreshWatchedRootUrlsSnapshot(): Promise<void> {
  if (!configManager) {
    currentValidWatchedRootUrlsSnapshot = [];
    return;
  }
  try {
    const config = await configManager.load();
    const urls = Array.isArray(config.watchedRoots)
      ? config.watchedRoots.filter((root) => root.enabled).map((root) => root.url)
      : [];
    currentValidWatchedRootUrlsSnapshot = urls.filter(isValidFeishuWikiUrl);
  } catch (error) {
    console.warn('[Config] Failed to refresh watched root URLs snapshot:', sanitizeDesktopError(error));
    currentValidWatchedRootUrlsSnapshot = [];
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

  // dev:desktop 模式下窗口加载 vite(http://localhost:5173)，前端跨域调 server(3001)；
  // 必须 corsDevMode=true 才允许 localhost:5173 origin（见 server/src/index.ts:44-58）。
  // 生产打包后窗口加载 app:// 同源，不需要 dev gate。
  const isDevMode = !app.isPackaged || process.env.NODE_ENV === 'development';
  console.info('[Electron] Starting server with options:', { desktopMode: true, hostname: LOOPBACK_HOST, port: 0, corsDevMode: isDevMode });
  const started = await serverModule.startServer({
    desktopMode: true,
    desktopToken: token,
    hostname: LOOPBACK_HOST,
    port: 0, // Auto-select available port
    corsDevMode: isDevMode,
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
    // VITE_DEV_SERVER_URL：本机 5173 被其他项目占用时可用环境变量指向别的
    // vite 端口（需与 server dev CORS 白名单口径一致，见 cors.ts）。
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    window.loadURL(devUrl).catch((error) => {
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
        // 退出前先切断所有指向内嵌 server 的连接来源：停掉主进程的
        // 变更检测轮询、销毁渲染窗口——渲染层每 30s 轮询鉴权状态会
        // 持续维持 keep-alive 连接，让 server.close() 永远等不完。
        // destroy() 会绕过 window.on('close') 里的“隐藏到托盘”拦截，
        // 且保证触发 closed 事件完成 mainWindow 清理。
        changeNotificationService?.stop();
        trayService?.dispose();
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.destroy();
          }
        }
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
  // P4: server and desktop share ~/.feishu-sync (not Electron userData).
  const configPath = path.join(
    process.env.FEISHU_SYNC_HOME || path.join(os.homedir(), '.feishu-sync'),
    'config.json',
  );
  const result = await shell.openPath(configPath);
  return result ? { ok: false, code: 'open-config-file-failed', error: sanitizeDesktopError(result) } : { ok: true };
});

ipcMain.handle('desktop:reveal-in-folder', async (_event, targetPath: unknown) => {
  // 2026-09 修复：「在文件夹中打开」此前误用 open-data-directory（打开
  // 数据目录而非文档所在目录）。showItemInFolder 在 Win 资源管理器/
  // mac Finder 中定位并选中文件；传父目录则直接打开。
  // 2026-09 二次修复：Electron showItemInFolder 对不存在路径**静默无动作**
  // （不抛错），用户表现为「按钮无效」。现在显式校验存在性：文件在→定位
  // 选中；文件不在但目录在→打开目录；都不在→返回明确错误供前端 toast。
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return { ok: false, code: 'invalid-path', error: 'Path must be a non-empty string' };
  }
  if (!path.isAbsolute(targetPath)) {
    return { ok: false, code: 'invalid-path', error: 'Path must be absolute' };
  }
  try {
    const normalized = path.resolve(targetPath);
    if (fs.existsSync(normalized)) {
      const stat = fs.statSync(normalized);
      if (stat.isFile()) {
        shell.showItemInFolder(normalized);
      } else {
        // 目录：直接打开
        const result = await shell.openPath(normalized);
        if (result) {
          return { ok: false, code: 'reveal-in-folder-failed', error: sanitizeDesktopError(result) };
        }
      }
      return { ok: true };
    }
    // 文件不在但父目录在：打开父目录（同步后文件被移走/改名时的友好降级）
    const parent = path.dirname(normalized);
    if (fs.existsSync(parent)) {
      const result = await shell.openPath(parent);
      if (!result) return { ok: true, code: 'fallback-parent' };
      return { ok: false, code: 'reveal-in-folder-failed', error: sanitizeDesktopError(result) };
    }
    return {
      ok: false,
      code: 'path-not-found',
      error: `文件或目录不存在：${normalized}`,
    };
  } catch (error) {
    return { ok: false, code: 'reveal-in-folder-failed', error: sanitizeDesktopError(error) };
  }
});

ipcMain.handle('desktop:open-external', async (_event, url: unknown) => {
  // 白名单：仅 http:/https: 可打开，拒绝 file:/javascript: 等任意协议
  // （渲染进程被攻破时也不能借 openExternal 触达系统处理器）。
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, code: 'invalid-url', error: 'URL must be a non-empty string' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: 'invalid-url', error: sanitizeDesktopError(url) };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, code: 'protocol-not-allowed', error: `Protocol not allowed: ${parsed.protocol}` };
  }
  try {
    await shell.openExternal(parsed.href);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: 'open-external-failed', error: sanitizeDesktopError(error) };
  }
});

ipcMain.handle('desktop:get-platform-capabilities', () => {
  // 2026-09 新增：渲染进程需要 capabilities（真实版本号 / releasePageUrl /
  // 平台更新能力）来渲染「关于与更新」卡片，避免在前端重复维护仓库地址。
  return getDesktopPlatformCapabilities();
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
      await configManager.updateConfig({ enableAutoStart: enabled });
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
  // P4: align desktop data dir with server (~/.feishu-sync), not Electron userData.
  desktopDataDir = process.env.FEISHU_SYNC_HOME || path.join(os.homedir(), '.feishu-sync');
  fs.mkdirSync(desktopDataDir, { recursive: true, mode: 0o700 });
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

  // 2026-09 新增：启动后台静默检查一次更新（仅打包环境生效，未打包/
  // 不支持平台在 check() 内部被能力门控拦下并置 unsupported 状态，不会
  // 发起网络请求）。延迟 15s：让内嵌 server 启动、健康检查与窗口渲染
  // 先行完成，避免更新检查与首屏竞争；结果只推进状态机并通过
  // desktop:update:event 广播——渲染层 TopBar 徽标凭 available 相位亮起，
  // 失败仅落在更新卡片里，不打断用户。
  setTimeout(() => {
    updaterService?.check().catch((error) => {
      console.warn('[Updater] startup silent check failed:', error);
    });
  }, 15_000);

  // Initialize auto-start service (M4 new)
  autoStartService = new AutoStartService({
    sanitizeError: sanitizeDesktopError,
  });

  // Load config BEFORE constructing ChangeNotificationService so we can
  // inject a getWatchedRootUrls callback that reads the latest config.
  // Previous order constructed the service first and passed a hardcoded
  // { rootUrls: [] } body, which caused the detect endpoint to receive
  // rootUrl=undefined and leak into lark-cli as a positional-arg error
  // (historical lesson, see change-notification-service.ts header).
  try {
    configManager = new ConfigManager();
    const config = await configManager.load();

    // Populate the watched root URLs snapshot BEFORE constructing the
    // ChangeNotificationService. The service's start() triggers an
    // immediate first poll (see change-notification-service.ts start()),
    // and if the snapshot were empty at that moment the poll would no-op
    // with "No watched root URLs configured" instead of doing real work.
    // Seeding the snapshot synchronously here, against the freshly loaded
    // config, guarantees the first poll observes the full URL set.
    await refreshWatchedRootUrlsSnapshot();

    // Initialize change notification service (M4 new). The poller now
    // drives the multi-root /api/detect/changes-all endpoint via the
    // getWatchedRootUrls callback so every configured root is auto-
    // detected — the earlier single-root design left roots [1..N]
    // unwatched. The snapshot is refreshed on boot (here); runtime
    // config edits without an IPC round-trip require an app restart to
    // be picked up by the poller. This is an architectural constraint,
    // not a bug — settings UI saves via the IPC handler so the common
    // path is covered.
    changeNotificationService = new ChangeNotificationService({
      getWindow: () => mainWindow,
      getServerUrl: () => startedServer?.url ?? null,
      getApiToken: () => desktopApiToken,
      sanitizeError: sanitizeDesktopError,
      trayService: () => trayService,
      getWatchedRootUrls: () => readAllValidWatchedRootUrls(),
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

// 把 SIGTERM/SIGINT 纳入统一的退出流程（内部带 5s 强制退出兜底）。
// 此前默认 SIGTERM 被 Electron 转入 quit 流程后，会卡死在
// before-quit 的 preventDefault + server.close() 上，信号被吞掉，
// 表现为 kill 无效、只能 kill -9。
process.on('SIGTERM', () => {
  console.info('[Electron] SIGTERM received, initiating quit');
  void getQuitCoordinator().requestQuit('system');
});

process.on('SIGINT', () => {
  console.info('[Electron] SIGINT received, initiating quit');
  void getQuitCoordinator().requestQuit('system');
});

// Global shortcut for showing window
app.whenReady().then(() => {
  globalShortcut.register('CommandOrControl+Shift+F', () => {
    showMainWindow();
  });
});

// Will-quit cleanup
// 2026-09-04 Win 实测修复：第二实例（单实例锁失败路径）与 ready 前收到的
// 退出信号会走到这里，此时 globalShortcut 尚不可用，unregisterAll 抛
// 「globalShortcut cannot be used before the app is ready」并弹出系统级
// 错误对话框。ready 前不可能注册过快捷键，跳过即可；try/catch 兜底
// 防御其他非常规时序。
app.on('will-quit', () => {
  if (app.isReady()) {
    try {
      globalShortcut.unregisterAll();
    } catch (err) {
      console.error('[Electron] globalShortcut.unregisterAll failed on will-quit:', err);
    }
  }
  void closeServer();
});

// ============================================================================
// Single Instance Lock
// ============================================================================

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  // 2026-09-04 Win 实测修复：第二实例退出用 app.exit(0) 直接短路，
  // 而非 app.quit()——后者会派发 before-quit/will-quit 事件流，触发
  // QuitCoordinator 与 will-quit 清理逻辑，而第二实例从未 ready，
  // globalShortcut 调用直接抛错弹「A JavaScript error occurred in the
  // main process」。第二实例没有任何已分配资源，无需优雅清理。
  app.exit(0);
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
