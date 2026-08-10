/**
 * Feishu Sync - Server Entry Point
 *
 * Hono API server with embedded desktop mode support.
 * Handles health check, configuration, change detection, sync, and Feishu integration.
 *
 * Based on tts-voice-generator server structure with feishu-specific adaptations.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { ConfigManager } from './modules/config-manager.js';
import { LarkCliClient } from './modules/lark-cli-client.js';
import { LocalMapStore } from './modules/local-map-store.js';
import { ChangeDetector } from './modules/change-detector.js';
import { authMiddleware } from './middleware/auth.js';
import { corsMiddleware } from './middleware/cors.js';
import { healthRoutes } from './routes/health.js';
import { configRoutes } from './routes/config.js';
import { detectRoutes } from './routes/detect.js';
import { syncRoutes } from './routes/sync.js';
import { feishuRoutes } from './routes/feishu.js';
import { mappingRoutes } from './routes/mapping.js';
import { trashRoutes } from './routes/trash.js';
import { llmRoutes } from './routes/llm.js';
import { opencodeRoutes } from './routes/opencode.js';
import { OpenCodeCliService } from './modules/opencode-cli-service.js';
import { claudeRoutes } from './routes/claude.js';
import { ClaudeCliService } from './modules/claude-cli-service.js';
import type { LarkCliConfig } from './types/index.js';

// ============================================================================
// Configuration and Constants
// ============================================================================

const DEFAULT_PORT = 3001;

export interface CreateServerOptions {
  desktopMode?: boolean;
  desktopToken?: string;
  configPath?: string;
  /**
   * P0-bug-1 fix (v0.2.0 P5): independently control the CORS dev gate.
   *
   * desktopMode alone cannot distinguish "real Electron (origin app://,
   * same-origin, browser never involved)" from "standalone dev:all
   * (vite at http://localhost:5173 making cross-origin requests to
   * http://127.0.0.1:3001)" — both run with desktopMode=true. So the
   * CORS dev gate is now driven by this explicit flag instead.
   *
   *   - Electron production (electron/main.ts) → leave undefined / false
   *     → CORS enforces expectedOrigin `app://feishu-sync.local`
   *   - Standalone dev:all (isMainModule entry below) → set true
   *     → CORS allows http://localhost:5173 + http://127.0.0.1:5173
   */
  corsDevMode?: boolean;
}

export interface StartedServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

// ============================================================================
// Server Factory
// ============================================================================

export async function buildServer(options: CreateServerOptions = {}) {
  console.info('[server] buildServer started');

  const {
    desktopMode = false,
    desktopToken: providedDesktopToken,
    configPath,
    corsDevMode = false,
  } = options;

  // Generate or use provided desktop token
  const desktopToken = providedDesktopToken || crypto.randomBytes(32).toString('base64url');
  console.info('[server] Desktop token generated');

  // Note: desktopToken is passed to auth middleware via c.env, not used here directly
  void desktopToken; // Suppress unused variable warning

  // Initialize dependencies
  console.info('[server] Initializing ConfigManager');
  const configManager = new ConfigManager(configPath);
  console.info('[server] ConfigManager initialized');

  // Load the user configuration before constructing LarkCliClient. The
  // previous order constructed the client from hard-coded defaults and never
  // passed through config.larkCliPath, so the setting shown in the desktop UI
  // had no effect in the packaged application.
  console.info('[server] Loading config');
  const config = await configManager.load();
  console.info('[server] Config loaded');

  console.info('[server] Initializing LocalMapStore');
  const dbPath = path.join(os.homedir(), '.feishu-sync', 'feishu-sync.db');
  console.info('[server] Database path:', dbPath);
  const localMapStore = new LocalMapStore(dbPath);
  console.info('[server] LocalMapStore initialized');

  console.info('[server] Initializing LarkCliClient');
  const larkCliConfig: LarkCliConfig = {
    // Keep aligned with ConfigManager DEFAULT_REQUIRED_SCOPES (min sync boundary).
    requiredScopes: config.requiredScopes.length > 0 ? config.requiredScopes : [
      'wiki:node:retrieve',
      'wiki:space:retrieve',
      'docs:document.content:read',
      'sheets:spreadsheet:read',
      'docx:document:readonly',
      'drive:drive.metadata:readonly',
      'docs:document.media:download',
      'slides:presentation:read',
      'offline_access',
    ],
    timeout: 30000,
    larkCliPath: config.larkCliPath,
  };
  const larkCliClient = new LarkCliClient(larkCliConfig);
  console.info('[server] LarkCliClient initialized');

  // Keep a single service instance so explicit global installation is
  // serialized even when the settings button is clicked repeatedly.
  const openCodeCliService = new OpenCodeCliService();
  const claudeCliService = new ClaudeCliService();

  // Initialize database schema
  console.info('[server] Initializing database schema');
  localMapStore.initialize();
  console.info('[server] Database schema initialized');

  // Initialize ChangeDetector
  console.info('[server] Initializing ChangeDetector');
  const changeDetector = new ChangeDetector(
    larkCliClient,
    localMapStore
  );
  console.info('[server] ChangeDetector initialized');

  // Create Hono app
  console.info('[server] Creating Hono app');
  const app = new Hono();
  console.info('[server] Hono app created');

  // ============================================================================
  // Middleware Registration Order Matters
  // ============================================================================

  // CORS (desktop mode or dev mode)
  //
  // P0-bug-1 fix: in standalone dev:all (vite 5173 + server 3001) the
  // browser sends cross-origin requests from http://localhost:5173 to
  // http://127.0.0.1:3001. Without devMode the CORS origin gate rejects
  // them (expectedOrigin defaults to the Electron app:// scheme), which
  // makes the entire frontend unable to reach the API in dev:all.
  //
  // desktopMode alone cannot tell standalone-dev:all apart from real
  // Electron production (both set desktopMode=true), so we drive the
  // CORS dev gate from an explicit `corsDevMode` option:
  //   - Electron production (electron/main.ts) → leaves it false
  //   - Standalone isMainModule entry → sets it true
  app.use('*', corsMiddleware({ devMode: corsDevMode }));
  console.info(`[server] CORS middleware registered (devMode=${corsDevMode})`);

  // ============================================================================
  // Inject Dependencies via Middleware (must run before auth)
  // ============================================================================

  app.use('*', async (c, next) => {
    // Inject dependencies for downstream routes
    (c as any).configManager = configManager;
    (c as any).larkCliClient = larkCliClient;
    (c as any).localMapStore = localMapStore;
    (c as any).changeDetector = changeDetector;
    (c as any).openCodeCliService = openCodeCliService;
    (c as any).claudeCliService = claudeCliService;

    // Inject desktopToken for auth middleware via context property
    if (desktopMode) {
      (c as any).desktopToken = desktopToken;
    }

    await next();
  });
  console.info('[server] Dependency injection middleware registered');

  // ============================================================================
  // Register Public Routes (no auth required)
  // ============================================================================

  app.route('/', healthRoutes); // Health check is always public (must be before auth middleware)
  console.info('[server] Health routes registered');

  // Token authentication (desktop mode only, must run after dependency injection)
  if (desktopMode) {
    app.use('*', authMiddleware());
    console.info('[server] Auth middleware registered');
  }

  // ============================================================================
  // Register Protected Routes (auth required)
  // ============================================================================

  app.route('/', configRoutes);
  app.route('/', detectRoutes);
  app.route('/', syncRoutes);
  app.route('/', feishuRoutes);
  app.route('/', mappingRoutes);
  app.route('/', trashRoutes);
  app.route('/', llmRoutes);
  app.route('/', opencodeRoutes);
  app.route('/', claudeRoutes);
  console.info('[server] Protected routes registered');

  // ============================================================================
  // Error Handling
  // ============================================================================

  app.onError((err, c) => {
    console.error('[server] Unhandled error:', err);
    return c.json({
      error: 'Internal server error',
      message: err.message,
    }, 500);
  });

  app.notFound((c) => {
    return c.json({ error: 'Not found', path: c.req.path }, 404);
  });

  console.info('[server] buildServer completed');
  return app;
}

export async function startServer(options: CreateServerOptions & {
  port?: number;
  hostname?: string;
} = {}): Promise<StartedServer> {
  const port = options.port || DEFAULT_PORT;
  const hostname = options.hostname || '127.0.0.1';

  console.info(`[server] Building server with options:`, options);
  const app = await buildServer(options);
  console.info(`[server] Server built, starting HTTP server on port ${port}`);

  const started = await new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
    let settled = false;
    try {
      const server = serve(
        {
          fetch: app.fetch,
          port,
          hostname,
        },
        (info) => {
          console.info(`[server] HTTP server callback invoked, info:`, info);
          if (!settled) {
            settled = true;
            // @hono/node-server v1.x callback info structure: { port: number }
            resolve({ server, port: info.port || port });
          }
        }
      );
      server.once('error', (error) => {
        console.error('[server] HTTP server error:', error);
        if (!settled) reject(error);
      });
      console.info('[server] serve() called, waiting for callback');
    } catch (error) {
      console.error('[server] serve() threw error:', error);
      reject(error);
    }
  });

  const actualPort = started.port;
  const url = `http://${hostname}:${actualPort}`;
  console.info(`[server] Feishu Sync API listening on ${url}`);
  console.info(`[server] Desktop mode: ${options.desktopMode ? 'enabled' : 'disabled'}`);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => {
      started.server.close((error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };

  return {
    url,
    port: actualPort,
    close,
  };
}

// ============================================================================
// Main Module Entry
// ============================================================================

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  // Start server in standalone mode (for development/testing)
  // SECURITY: Generate a temporary token and log to console for access
  const standaloneToken = crypto.randomBytes(32).toString('base64url');
  console.info(`[server] Standalone mode token: ${standaloneToken}`);
  console.info('[server] Use this token via X-Desktop-Token header to access protected routes');

  startServer({
    desktopMode: true, // Enable auth middleware in standalone mode
    desktopToken: standaloneToken,
    corsDevMode: true, // P0-bug-1 fix: standalone always serves a browser client (vite 5173 cross-origin)
    port: 3001, // Use default port to align with vite proxy
    hostname: '127.0.0.1', // Bind to localhost only in standalone mode
  }).catch((error) => {
    console.error('[server] Failed to start:', error);
    process.exit(1);
  });
}

export default buildServer;
