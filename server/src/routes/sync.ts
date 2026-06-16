/**
 * Sync Routes - Document synchronization endpoints
 *
 * POST /api/sync - Synchronize selected documents
 *
 * NOTE: This is a placeholder implementation returning a stub structure.
 * Full implementation will be completed in M2 milestone.
 *
 * TODO-M2: Implement SyncEngine integration with LarkCliClient, LayoutReconstructor, ContentAdapter
 */

import { Hono } from 'hono';
import type { SyncResult } from '../types/index.js';

const syncRoutes = new Hono();

/**
 * POST /api/sync - Synchronize documents
 *
 * Request body: { documents: ChangedDocument[], options: SyncOptions }
 * Response: SyncResult
 */
syncRoutes.post('/api/sync', async (c) => {
  const { documents, options } = await c.req.json();

  // Suppress unused variable warnings
  void documents;
  void options;

  // TODO-M2: Implement actual sync logic
  // This will be completed in M2 milestone with:
  // - SyncEngine.syncDocuments() orchestration
  // - LarkCliClient for content fetching (docs +fetch, media-download)
  // - LayoutReconstructor for table reconstruction
  // - ContentAdapter for LLM-based content adaptation
  // - LocalMapStore for mapping updates

  const stubResult: SyncResult = {
    success: false,
    syncedDocuments: [],
    failedDocuments: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    duration: 0,
  };

  return c.json(stubResult);
});

export { syncRoutes };
