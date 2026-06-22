/**
 * Detect Routes - Change detection endpoints
 *
 * POST /api/detect/changes - Detect changed documents in a wiki subtree
 *
 * M1 Implementation: Integrated with ChangeDetector + LarkCliClient
 *
 * v0.2.0 fix: validate rootUrl at the edge. Previously, when callers
 * sent { rootUrls: [] } (plural) or omitted the field, rootUrl was
 * undefined and was passed unchanged through ChangeDetector →
 * LarkCliClient.getNode(undefined) → lark-cli `--node-token undefined
 * --format json`, which Node execFile(shell:true) collapses into a
 * command line that lark-cli 1.0.53 parses as a positional argument
 * "json", producing:
 *   Error: positional arguments are not supported (got ["json"])
 * This route now rejects missing/invalid rootUrl at the boundary so
 * the contract violation fails fast with an actionable error instead
 * of leaking into a misleading lark-cli invocation.
 */

import { Hono } from 'hono';
import type { ChangeDetector } from '../modules/change-detector.js';

const detectRoutes = new Hono();

/**
 * POST /api/detect/changes - Detect changed documents
 *
 * Request body: { rootUrl: string }  — singular Feishu wiki URL
 * Response: ChangeDetectionResult
 */
detectRoutes.post('/api/detect/changes', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rootUrl = typeof body?.rootUrl === 'string' ? body.rootUrl.trim() : '';

  if (!rootUrl) {
    return c.json(
      {
        error: 'missing_rootUrl',
        message:
          'Request body must include { rootUrl: "<feishu wiki url>" }. Received empty/undefined rootUrl.',
      },
      400
    );
  }

  // Minimal structural check: lark-cli +node-get requires a URL or token
  // we can resolve. Empty/garbage strings leak into lark-cli and surface
  // as cryptic errors; reject early with a precise message.
  const looksLikeFeishuWikiUrl = /^https:\/\/[a-z0-9-]+\.feishu\.cn\/wiki\/[A-Za-z0-9]+/i.test(
    rootUrl
  );
  const looksLikeRawToken = /^[A-Za-z0-9]{20,}$/.test(rootUrl);
  if (!looksLikeFeishuWikiUrl && !looksLikeRawToken) {
    return c.json(
      {
        error: 'invalid_rootUrl',
        message:
          'rootUrl must be a Feishu wiki URL (https://<host>/wiki/<token>) or a raw node/obj token.',
      },
      400
    );
  }

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
