/**
 * Detect Routes - Change detection endpoints
 *
 * POST /api/detect/changes - Detect changed documents in a wiki subtree
 *
 * M1 Implementation: Integrated with ChangeDetector + LarkCliClient
 */

import { Hono } from 'hono';
import type { ChangeDetector } from '../modules/change-detector.js';

const detectRoutes = new Hono();

/**
 * POST /api/detect/changes - Detect changed documents
 *
 * Request body: { rootUrl: string }
 * Response: ChangeDetectionResult
 */
detectRoutes.post('/api/detect/changes', async (c) => {
  const { rootUrl } = await c.req.json();

  // Get ChangeDetector instance from app context (set by index.ts)
  const changeDetector = (c as any).changeDetector as ChangeDetector;

  if (!changeDetector) {
    return c.json({ error: 'ChangeDetector not initialized' }, 500);
  }

  try {
    const result = await changeDetector.detectChanges(rootUrl);
    return c.json(result);
  } catch (error) {
    console.error('[DetectRoutes] Change detection failed:', error);
    return c.json(
      {
        error: 'Change detection failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

export { detectRoutes };
