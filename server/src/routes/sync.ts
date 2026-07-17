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
import { ContentBackendRegistry } from '../modules/content-backend-registry.js';
import type { ChannelConfig } from '../modules/content-backend.js';
import type { ChangedDocument, SyncOptions, SyncResult } from '../types/index.js';

const syncRoutes = new Hono();

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
    enableLLM: false,
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
  const documents = payload.documents as ChangedDocument[];

  // Get dependencies from context (injected by middleware)
  const larkCliClient = (c as any).larkCliClient;
  const localMapStore = (c as any).localMapStore;
  const configManager = (c as any).configManager;

  // Load config
  const config = await configManager.load();

  // Initialize M3 modules + v0.2.0 P3 channel-agnostic LLM stack.
  //
  // P3 flow chain (03 §4.4.1):
  //   LayoutReconstructor (必跑, 前置)
  //     -> ContentAdapter (optional, enableLLM=true)
  //       primary channel: ClaudeCliChannel (default) or DirectChannel
  //       on failure: fallback channel (single layer)
  //     -> B6 deterministic fallback: reconstructedMarkdown (sync-engine)
  const layoutReconstructor = new LayoutReconstructor();
  const channelConfig: ChannelConfig = {
    llm: config.llm,
    claudeCli: config.llm.claudeCli,
    primaryChannel: config.llm.primaryChannel,
    fallbackOnFailure: config.llm.fallbackOnFailure,
  };
  const registry = new ContentBackendRegistry(channelConfig);
  const contentAdapter = new ContentAdapter(registry);
  // contentAdapter 暂不注入 SyncEngine（LLM 屏蔽期，见下方 contentAdapter: undefined）。
  // 保留构造以保证 LLM 代码路径可逆 + ContentAdapter/ContentBackendRegistry 的
  // import 仍被引用（满足 tsc noUnusedLocals）。恢复 LLM 时删掉此行 + 把
  // 下方 contentAdapter: undefined 改回 contentAdapter 即可。
  void contentAdapter;

  // Create SyncEngine instance with M3 modules
  // 暂时屏蔽 LLM：不注入 contentAdapter，sync-engine Step 7 条件
  // (this.contentAdapter && options.enableLLM && localMdPath) 因 contentAdapter
  // 为 undefined 永远 false，绝不调用 LLM。仅做云端原始内容→本地同步。
  // 上方 ContentBackendRegistry/ContentAdapter 构造保留不动（删了影响测试、不可逆）。
  const syncEngine = new SyncEngine({
    larkCliClient,
    localMapStore,
    config,
    layoutReconstructor,
    contentAdapter: undefined,
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
