/**
 * Authentication Middleware - Token-based auth for desktop mode
 *
 * Implements the security design from 架构设计文档 §9.1:
 * - Timing-safe token comparison using crypto.timingSafeEqual()
 * - DesktopToken passed via X-Desktop-Token header
 * - Origin/Referer validation for CSRF protection (see cors.ts)
 */

import type { MiddlewareHandler } from 'hono';
import crypto from 'node:crypto';

export interface AuthEnv {
  desktopToken: string;
}

export function authMiddleware(): MiddlewareHandler<{
  Bindings: AuthEnv;
}> {
  return async (c, next) => {
    const providedToken = c.req.header('X-Desktop-Token') ?? '';
    const expectedToken = (c as any).desktopToken;

    if (!timingSafeTokenEqual(providedToken, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await next();
  };
}

/**
 * Timing-safe token comparison to prevent timing attacks
 */
function timingSafeTokenEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf-8');
  const expectedBuffer = Buffer.from(expected, 'utf-8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
