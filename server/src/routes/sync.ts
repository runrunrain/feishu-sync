/**
 * Sync Routes - Document synchronization endpoints
 *
 * POST /api/sync - Synchronize selected documents
 * POST /api/sync/index - Trigger initial full index scan
 * GET  /api/sync/feishu-pending - Read Feishu-side repair queue
 * POST /api/sync/feishu-pending/recheck - Permit an explicit recovery scan
 *
 * Implements the complete synchronization pipeline with SyncEngine integration
 */

import { Hono } from 'hono';
import { SyncEngine } from '../modules/sync-engine.js';
import { IndexScanner } from '../modules/index-scanner.js';
import { LayoutReconstructor } from '../modules/layout-reconstructor.js';
import { ContentAdapter } from '../modules/content-adapter.js';
import { ContentBackendRegistry } from '../modules/content-backend-registry.js';
import type { ChannelConfig } from '../modules/content-backend.js';
import type { ChangedDocument, SyncOptions, SyncResult } from '../types/index.js';

const syncRoutes = new Hono();

/** The durable operator queue has a deliberately small route-facing contract. */
function getFeishuPendingStore(c: any): {
  listFeishuPending: (watchedRootIds?: string[]) => unknown[];
  requestFeishuPendingRecheck: (watchedRootIds?: string[]) => number;
} {
  const localMapStore = c.localMapStore;
  if (!localMapStore
    || typeof localMapStore.listFeishuPending !== 'function'
    || typeof localMapStore.requestFeishuPendingRecheck !== 'function') {
    throw new Error('[sync] Feishu-side pending store is not injected');
  }
  return localMapStore;
}

function parseWatchedRootIds(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 200) {
    throw new Error('watchedRootIds 必须是不超过 200 项的字符串数组');
  }
  const ids = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length !== value.length) {
    throw new Error('watchedRootIds 只能包含非空字符串');
  }
  return [...new Set(ids)];
}

/**
 * Read issues that need a human action in Feishu. They are intentionally
 * separate from mapping/diff so normal polling never turns them into a new
 * pending cloud change again.
 */
syncRoutes.get('/api/sync/feishu-pending', (c) => {
  try {
    return c.json({ items: getFeishuPendingStore(c).listFeishuPending() });
  } catch (error) {
    console.error('[sync] list Feishu-side pending items failed:', error);
    return c.json({
      error: 'feishu_pending_list_failed',
      message: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});

/**
 * The user has completed a cloud-side repair and explicitly permits one full
 * recheck. This never grants permissions or mutates Feishu; it only releases
 * local suppression once a later traversal can actually read the node.
 */
syncRoutes.post('/api/sync/feishu-pending/recheck', async (c) => {
  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid_json', message: '重新检测请求必须是 JSON 对象' }, 400);
  }

  try {
    const watchedRootIds = parseWatchedRootIds(payload.watchedRootIds);
    const requested = getFeishuPendingStore(c).requestFeishuPendingRecheck(watchedRootIds);
    return c.json({ requested });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const invalid = message.includes('watchedRootIds');
    if (!invalid) console.error('[sync] request Feishu-side pending recheck failed:', error);
    return c.json({
      error: invalid ? 'invalid_watched_root_ids' : 'feishu_pending_recheck_failed',
      message,
    }, invalid ? 400 : 500);
  }
});

/**
 * POST /api/sync - Synchronize documents
 *
 * Request body: { documents: ChangedDocument[], options: SyncOptions }
 * Response: SyncResult
 */
syncRoutes.post('/api/sync', async (c) => {
  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid_json', message: '同步请求必须是 JSON 对象' }, 400);
  }

  if (!Array.isArray(payload.documents)) {
    return c.json({ error: 'invalid_documents', message: 'documents 必须是数组' }, 400);
  }

  const rawOptions = payload.options;
  const rawOptionsObject = rawOptions && typeof rawOptions === 'object'
    ? rawOptions as Record<string, unknown>
    : {};
  const options: SyncOptions = {
    // Final enablement is gated by persisted configuration after it is
    // loaded below. A request alone can never turn document reorganisation
    // on, which prevents stale/malicious callers from changing bodies.
    enableLLM: rawOptionsObject.enableLLM === true,
    // This recovery flag is only meaningful together with formal apply
    // confirmation. SyncEngine still accepts a file only after matching its
    // canonical profile path and its Markdown title to the cloud document.
    adoptExistingProfileTargets: rawOptionsObject.adoptExistingProfileTargets === true,
    fullSync: false,
    apply: rawOptionsObject.apply === true,
    confirmation: typeof rawOptionsObject.confirmation === 'string'
      ? rawOptionsObject.confirmation
      : undefined,
  };

  // A truthy apply flag is never enough on its own. This rejects accidental
  // compatibility callers instead of silently mutating a real knowledge base.
  if (options.apply && options.confirmation !== 'APPLY') {
    return c.json({
      error: 'apply_confirmation_required',
      message: '正式写入需要 options.apply=true 且 options.confirmation="APPLY"',
    }, 400);
  }
  // P3: apply is available when confirmation=APPLY; SyncEngine commits via
  // staging + atomic rename and only then advances the synced baseline.
  const documents = payload.documents as ChangedDocument[];

  // Get dependencies from context (injected by middleware)
  const larkCliClient = (c as any).larkCliClient;
  const localMapStore = (c as any).localMapStore;
  const configManager = (c as any).configManager;

  // Load config
  const config = await configManager.load();

  // Initialize M3 modules + v0.2.9 单通道 LLM stack.
  //
  // Flow chain:
  //   LayoutReconstructor (必跑, 前置)
  //     -> ContentAdapter (optional, enableLLM=true)
  //       channel: DirectChannel（claude-cli / opencode 已移除）
  //     -> B6 deterministic fallback: reconstructedMarkdown (sync-engine)
  const layoutReconstructor = new LayoutReconstructor();
  const channelConfig: ChannelConfig = {
    llm: config.llm,
  };
  const registry = new ContentBackendRegistry(channelConfig);
  const contentAdapter = new ContentAdapter(registry);
  // Both the current request AND the saved explicit opt-in are required.
  // This preserves a safe default even if a legacy frontend sends
  // enableLLM=true unexpectedly.
  options.enableLLM = options.enableLLM && config.llm.contentAdaptationEnabled === true;

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

  // A dry-run must not refresh _index.json: that file lives in the formal
  // knowledge base and would turn an ostensibly read-only operation into a
  // write. Snapshot refresh remains an apply-only best-effort side effect.
  if (result.mode === 'apply') {
    try {
      const { SnapshotService } = await import('../modules/snapshot-service.js');
      const indexScanner = new IndexScanner({ localMapStore, larkCliClient, config });
      const snapshotService = new SnapshotService(localMapStore, configManager, indexScanner);
      snapshotService.generate();
    } catch (snapshotError) {
      console.warn('[sync] _index.json refresh after sync failed (non-fatal):', snapshotError);
    }
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
