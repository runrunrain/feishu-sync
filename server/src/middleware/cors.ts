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

      // Allow only specific localhost origins in dev mode
      const allowedOrigins = [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
      ];

      return allowedOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Desktop-Token'],
    exposeHeaders: ['Content-Length'],
    maxAge: 86400,
    credentials: !devMode,
  });
}
