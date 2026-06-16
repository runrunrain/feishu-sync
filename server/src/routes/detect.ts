/**
 * Detect Routes - Change detection endpoints
 *
 * POST /api/detect/changes - Detect changed documents in a wiki subtree
 *
 * NOTE: This is a placeholder implementation returning a stub structure.
 * Full implementation will be completed in M1 milestone.
 *
 * TODO-M1: Implement ChangeDetector integration with LarkCliClient
 */

import { Hono } from 'hono';
import type { ChangeDetectionResult } from '../types/index.js';

const detectRoutes = new Hono();

/**
 * POST /api/detect/changes - Detect changed documents
 *
 * Request body: { rootUrl: string }
 * Response: ChangeDetectionResult
 */
detectRoutes.post('/api/detect/changes', async (c) => {
  const { rootUrl } = await c.req.json();

  // Suppress unused variable warning
  void rootUrl;

  // TODO-M1: Implement actual change detection logic
  // This will be completed in M1 milestone with:
  // - LarkCliClient.getNode(rootUrl) to get space_id and root_token
  // - LarkCliClient.listWikiNodes() to traverse subtree
  // - Compare obj_edit_time with SQLite records

  const stubResult: ChangeDetectionResult = {
    changed: false,
    changedDocuments: [],
    checkedAt: new Date().toISOString(),
    totalNodes: 0,
  };

  return c.json(stubResult);
});

export { detectRoutes };
