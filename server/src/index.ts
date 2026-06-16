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
import { authMiddleware } from './middleware/auth.js';
import { corsMiddleware } from './middleware/cors.js';
import { healthRoutes } from './routes/health.js';
import { configRoutes } from './routes/config.js';
import { detectRoutes } from './routes/detect.js';
import { syncRoutes } from './routes/sync.js';
import { feishuRoutes } from './routes/feishu.js';
import type { LarkCliConfig } from './types/index.js';

// ============================================================================
// Configuration and Constants
// ============================================================================

const DEFAULT_PORT = 3001;
const DEFAULT_DESKTOP_ORIGIN = 'app://feishu-sync.local';

export interface CreateServerOptions {
  desktopMode?: boolean;
  desktopToken?: string;
  configPath?: string;
}

export interface StartedServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

// ============================================================================
// Server Factory
// ============================================================================

export function buildServer(options: CreateServerOptions = {}) {
  const {
    desktopMode = false,
    desktopToken: providedDesktopToken,
    configPath,
  } = options;

  // Generate or use provided desktop token
  const desktopToken = providedDesktopToken || crypto.randomBytes(32).toString('base64url');

  // Note: desktopToken is passed to auth middleware via c.env, not used here directly
  void desktopToken; // Suppress unused variable warning

  // Initialize dependencies
  const configManager = new ConfigManager(configPath);
  const dbPath = path.join(os.homedir(), '.feishu-sync', 'feishu-sync.db');
  const localMapStore = new LocalMapStore(dbPath);
  const defaultLarkCliConfig: LarkCliConfig = {
    requiredScopes: [
      'wiki:node:retrieve',
      'wiki:space:retrieve',
      'docs:document:read',
      'sheets:spreadsheet:read',
      'docx:document:readonly',
      'drive:drive.metadata:readonly',
    ],
    timeout: 30000,
  };
  const larkCliClient = new LarkCliClient(defaultLarkCliConfig);

  // Initialize database schema
  localMapStore.initialize();

  // Create Hono app
  const app = new Hono();

  // ============================================================================
  // Middleware Registration Order Matters
  // ============================================================================

  // CORS (desktop mode or dev mode)
  app.use('*', corsMiddleware({
    expectedOrigin: DEFAULT_DESKTOP_ORIGIN,
    devMode: !desktopMode,
  }));

  // ============================================================================
  // Inject Dependencies via Middleware (must run before auth)
  // ============================================================================

  app.use('*', async (c, next) => {
    // Inject dependencies for downstream routes
    (c as any).configManager = configManager;
    (c as any).larkCliClient = larkCliClient;
    (c as any).localMapStore = localMapStore;

    // Inject desktopToken for auth middleware via context property
    if (desktopMode) {
      (c as any).desktopToken = desktopToken;
    }

    await next();
  });

  // ============================================================================
  // Register Public Routes (no auth required)
  // ============================================================================

  app.route('/', healthRoutes); // Health check is always public

  // Token authentication (desktop mode only, must run after dependency injection)
  if (desktopMode) {
    app.use('*', authMiddleware());
  }

  // ============================================================================
  // Register Protected Routes (auth required)
  // ============================================================================

  app.route('/', healthRoutes);
  app.route('/', configRoutes);
  app.route('/', detectRoutes);
  app.route('/', syncRoutes);
  app.route('/', feishuRoutes);

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

  return app;
}

export async function startServer(options: CreateServerOptions & {
  port?: number;
  hostname?: string;
} = {}): Promise<StartedServer> {
  const port = options.port || DEFAULT_PORT;
  const hostname = options.hostname || '127.0.0.1';

  const app = buildServer(options);

  const started = await new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
    let settled = false;
    const server = serve(
      {
        fetch: app.fetch,
        port,
        hostname,
      },
      (info) => {
        if (!settled) {
          settled = true;
          // @hono/node-server v1.x callback info structure: { port: number }
          resolve({ server, port: info.port || port });
        }
      }
    );
    server.once('error', (error) => {
      if (!settled) reject(error);
    });
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
    port: 3002, // Use alternative port for verification
    hostname: '127.0.0.1', // Bind to localhost only in standalone mode
  }).catch((error) => {
    console.error('[server] Failed to start:', error);
    process.exit(1);
  });
}

export default buildServer;
