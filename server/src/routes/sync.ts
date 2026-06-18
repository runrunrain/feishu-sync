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
import { LayoutReconstructor } from '../modules/layout-reconstructor.js';
import { ContentAdapter } from '../modules/content-adapter.js';
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

  // Initialize M3 modules
  const layoutReconstructor = new LayoutReconstructor();
  const contentAdapter = new ContentAdapter();

  // Create SyncEngine instance with M3 modules
  const syncEngine = new SyncEngine({
    larkCliClient,
    localMapStore,
    config,
    layoutReconstructor,
    contentAdapter,
  });

  // Execute synchronization
  const result: SyncResult = await syncEngine.syncDocuments(documents, options);

  // Refresh _index.json snapshot (03 §2.4.1 生成时机: 同步完成后).
  // Best-effort: snapshot failure must not invalidate an otherwise
  // successful sync. The next manual refresh-index call will recover.
  try {
    const { SnapshotService } = await import('../modules/snapshot-service.js');
    const indexScanner = new IndexScanner({ localMapStore, larkCliClient, config });
    const snapshotService = new SnapshotService(localMapStore, configManager, indexScanner);
    snapshotService.generate();
  } catch (snapshotError) {
    console.warn('[sync] _index.json refresh after sync failed (non-fatal):', snapshotError);
  }

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

  // Refresh _index.json snapshot (03 §2.4.1 生成时机: 首次索引完成后).
  // Best-effort: snapshot failure must not invalidate an otherwise
  // successful index scan.
  try {
    const { SnapshotService } = await import('../modules/snapshot-service.js');
    const snapshotService = new SnapshotService(localMapStore, configManager, indexScanner);
    snapshotService.generate();
  } catch (snapshotError) {
    console.warn('[sync] _index.json refresh after index failed (non-fatal):', snapshotError);
  }

  return c.json(result);
});

export { syncRoutes };