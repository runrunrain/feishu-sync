/**
 * Sync Routes - Document synchronization endpoints
 *
 * POST /api/sync - Synchronize selected documents
 * POST /api/sync/index - Trigger initial full index scan
 *
 * Implements the complete synchronization pipeline with SyncEngine integration
 */

import { Hono } from 'hono';
import { SyncEngine } from '../modules/sync-engine.js';
import { IndexScanner } from '../modules/index-scanner.js';
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

  // Get dependencies from context (injected by middleware)
  const larkCliClient = (c as any).larkCliClient;
  const localMapStore = (c as any).localMapStore;
  const configManager = (c as any).configManager;

  // Load config
  const config = await configManager.load();

  // Create SyncEngine instance
  const syncEngine = new SyncEngine({
    larkCliClient,
    localMapStore,
    config,
    // layoutReconstructor and contentAdapter will be injected in M3
  });

  // Execute synchronization
  const result: SyncResult = await syncEngine.syncDocuments(documents, options);

  return c.json(result);
});

/**
 * POST /api/sync/index - Trigger initial full index scan
 *
 * Request body: { rootDir?: string }  // Optional, defaults to config.knowledgeBaseRoot
 * Response: IndexResult
 */
syncRoutes.post('/api/sync/index', async (c) => {
  const { rootDir } = await c.req.json();

  // Get dependencies from context
  const larkCliClient = (c as any).larkCliClient;
  const localMapStore = (c as any).localMapStore;
  const configManager = (c as any).configManager;

  // Load config
  const config = await configManager.load();

  // Use provided rootDir or default to config
  const scanRoot = rootDir || config.knowledgeBaseRoot;

  // Create IndexScanner instance
  const indexScanner = new IndexScanner({
    localMapStore,
    larkCliClient,
    config,
  });

  // Execute scan
  const result = await indexScanner.scanKnowledgeBase(scanRoot);

  return c.json(result);
});

export { syncRoutes };