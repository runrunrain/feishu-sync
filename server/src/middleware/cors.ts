/**
 * CORS Middleware - Cross-origin resource sharing with desktop mode support
 *
 * Implements the security design from 架构设计文档 §9.2:
 * - Origin/Referer validation for CSRF protection
 * - Desktop mode: only allow app://feishu-sync.local
 * - Dev mode: allow localhost:5173
 * - No-origin requests (curl, server-to-server): pass through without CORS headers
 */

import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

export interface CorsOptions {
  expectedOrigin?: string;
  devMode?: boolean;
}

export function corsMiddleware(options: CorsOptions = {}): MiddlewareHandler {
  const { expectedOrigin = 'app://feishu-sync.local', devMode = false } = options;

  return cors({
    origin: (origin: string) => {
      // Desktop mode: only allow expected origin
      if (!devMode) {
        return origin === expectedOrigin ? origin : null;
      }

      // Dev mode: strict whitelist for specific origins only
      if (!origin) {
        // Reject no-origin requests in dev mode (curl, server-to-server)
        // Requires explicit origin from frontend
        return null;
      }

      // Allow localhost/127.0.0.1 origins on any port in dev mode
      // （本机常有多项目并行开发，5173 可能被占用导致 vite 端口漂移；
      // dev gate 仅限 loopback，生产 desktop 仍走 expectedOrigin 严格校验）。
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return origin;
      }

      return null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Desktop-Token'],
    exposeHeaders: ['Content-Length'],
    maxAge: 86400,
    credentials: !devMode,
  });
}
