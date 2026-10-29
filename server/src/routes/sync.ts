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
syncRoutes.get('/api/sync/blocklist', async (c) => {
  const config = await (c as any).configManager.load();
  return c.json({ root: config.knowledgeBaseRoot, items: (c as any).localMapStore.listSyncBlockedSources(config.knowledgeBaseRoot) });
});
syncRoutes.post('/api/sync/blocklist/remove', async (c) => {
  const body = await c.req.json();
  const config = await (c as any).configManager.load();
  if (body?.root !== config.knowledgeBaseRoot) return c.json({ error: 'knowledge_root_changed', message: '知识库已切换，请刷新后重试' }, 409);
  if (!Array.isArray(body.tokens) || !body.tokens.length || body.tokens.length > 50000 || !body.tokens.every((token: unknown) => typeof token === 'string' && token.length > 0))
    return c.json({ error: 'invalid_request', message: '请选择要移出屏蔽名单的文档' }, 400);
  return c.json({ removed: (c as any).localMapStore.removeSyncBlockedSources(config.knowledgeBaseRoot, body.tokens) });
});

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

  if (documents.some((doc) => localMapStore.isSyncBlocked?.(config.knowledgeBaseRoot, doc.objToken)))
    return c.json({ error: 'source_blocked', message: '所选文档已被屏蔽，请刷新列表或先移出屏蔽名单' }, 409);

  // 2026-10 首次配置引导：未设置知识库根目录时提前 400（错误码对齐
  // custom-folders 的 knowledge_base_root_not_configured），不再让空路径
  // 穿透到写盘层炸出难以理解的 ENOENT/路径校验错误。前端同步入口有
  // 弹窗引导（跳设置/采用默认路径），这里是 API 直调场景的保底。
  if (!config.knowledgeBaseRoot || !config.knowledgeBaseRoot.trim()) {
    return c.json({
      error: 'knowledge_base_root_not_configured',
      message: '知识库根目录未设置：请先在「设置 → 知识库」中配置本地根目录，或采用默认路径',
    }, 400);
  }

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
    selection: config.agent?.model?.source === 'app-llm' ? config.agent.model : undefined,
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

/** Explicitly refresh one mapped sheet using the same planner, locks and atomic commit as sync. */
syncRoutes.post('/api/sync/refresh-sheet', async (c) => {
  const body = await c.req.json<{ objToken?: string }>().catch(() => null);
  const token = body?.objToken;
  if (typeof token !== 'string' || !token) return c.json({ error: 'invalid_document', message: '缺少文档标识' }, 400);
  const store = (c as any).localMapStore, client = (c as any).larkCliClient;
  const config = await (c as any).configManager.load();
  if (!config.knowledgeBaseRoot?.trim()) return c.json({ error: 'knowledge_base_root_not_configured', message: '请先配置知识库根目录。' }, 400);
  const record = store.getDocumentByObjToken(token);
  if (!record || record.objType !== 'sheet' || record.cloudDeleted || !record.localMdPath || !record.wikiNodeToken) {
    return c.json({ error: 'sheet_not_refreshable', message: '该表格没有可用的本地映射或云端节点，请先检测并同步。' }, 409);
  }
  if (store.isSyncBlocked?.(config.knowledgeBaseRoot, token)) return c.json({ error: 'source_blocked', message: '文档已被屏蔽，请先移出屏蔽名单。' }, 409);
  try {
    const cloud = await client.getNode(record.wikiNodeToken);
    if (cloud.obj_token !== token || cloud.obj_type !== 'sheet' || cloud.obj_edit_time == null) {
      return c.json({ error: 'cloud_identity_changed', message: '云端表格标识或版本不可确认，请先重新检测。' }, 409);
    }
    const parents: string[] = [];
    if (!record.customFolderId && record.watchedRootId && record.wikiNodeToken !== record.watchedRootId) {
      let parent = cloud.parent_node_token ?? record.parentNodeToken;
      const visited = new Set<string>();
      while (parent && parent !== record.watchedRootId) {
        if (visited.has(parent) || visited.size >= 100) return c.json({ error: 'missing_parent_chain', message: '无法确认完整父级路径，请先重新检测。' }, 409);
        visited.add(parent);
        const ancestor = store.getDocumentByWikiNodeToken(parent);
        if (!ancestor || ancestor.cloudDeleted) return c.json({ error: 'missing_parent_chain', message: '无法确认完整父级路径，请先重新检测。' }, 409);
        parents.unshift(ancestor.title);
        parent = ancestor.parentNodeToken;
      }
      if (parent !== record.watchedRootId) return c.json({ error: 'missing_parent_chain', message: '无法确认所属同步根，请先重新检测。' }, 409);
    }
    const doc: ChangedDocument = {
      objToken: token, objType: 'sheet', title: cloud.title, changeType: 'modified',
      cloudModifiedTime: new Date(cloud.obj_edit_time * 1000).toISOString(), localSyncedTime: record.lastSyncedAt ?? null,
      localMdPath: record.localMdPath, localRelPath: record.localRelPath, wikiNodeToken: record.wikiNodeToken,
      parentNodeToken: cloud.parent_node_token ?? record.parentNodeToken, spaceId: cloud.space_id ?? record.spaceId,
      watchedRootId: record.watchedRootId, watchedRootUrl: record.watchedRootUrl, customFolderId: record.customFolderId,
      hasChild: cloud.has_child, observedObjEditTime: cloud.obj_edit_time,
      parentChainTitles: parents, isWatchedRootNode: record.wikiNodeToken === record.watchedRootId,
    };
    const engine = new SyncEngine({ larkCliClient: client, localMapStore: store, config, layoutReconstructor: new LayoutReconstructor() });
    const result = await engine.syncDocuments([doc], { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' });
    if (result.syncedDocuments.length > 0) {
      try {
        const { SnapshotService } = await import('../modules/snapshot-service.js');
        new SnapshotService(store, (c as any).configManager, new IndexScanner({ localMapStore: store, larkCliClient: client, config })).generate();
      } catch (error) { console.warn('[sync] snapshot refresh after sheet refresh failed:', error); }
    }
    return c.json(result);
  } catch (error) {
    return c.json({ error: 'sheet_refresh_failed', message: error instanceof Error ? error.message : String(error) }, 500);
  }
});

/**
 * POST /api/sync/whiteboard-backfill — P0-S8 存量补齐（设计 §5.8）
 *
 * 人工触发（CLI `sync whiteboard-backfill` / 内部 Agent app_command 同一
 * 命令表转发）：对 synced 文档补导白板旁路文件（svg 主 + raw 降级）。
 *
 * 硬约束（与 SyncEngine.backfillWhiteboardBypass 同一不变量）：只新增
 * .wb.svg/.wb.raw.json；md 字节与 DB 基线字段前后不变；脏文档跳过。
 *
 * 门控：confirm='BACKFILL'（写本地旁路文件的风险级确认，设计 §5.8）；
 * 知识库根未配置 → 400；whiteboardExport 显式关闭 → 400（无需补齐）；
 * 标准库构建活跃 → 409（§5.8 守卫，与源编辑/写回链同款探针）。
 */
syncRoutes.post('/api/sync/whiteboard-backfill', async (c) => {
  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid_json', message: '补齐请求必须是 JSON 对象' }, 400);
  }
  if (payload.confirm !== 'BACKFILL') {
    return c.json({
      error: 'confirmation_required',
      message: '白板旁路补齐需要 confirm="BACKFILL"',
    }, 422);
  }

  let docTokens: string[] | undefined;
  if (payload.docTokens !== undefined) {
    const raw = payload.docTokens;
    if (
      !Array.isArray(raw)
      || raw.length === 0
      || raw.length > 200
      || !raw.every((token: unknown) => typeof token === 'string' && token.length > 0)
    ) {
      return c.json({
        error: 'invalid_doc_tokens',
        message: 'docTokens 必须是 1–200 个非空字符串',
      }, 400);
    }
    docTokens = [...new Set(raw as string[])];
  }

  const larkCliClient = (c as any).larkCliClient;
  const localMapStore = (c as any).localMapStore;
  const configManager = (c as any).configManager;
  if (!larkCliClient || !localMapStore || !configManager) {
    return c.json({ error: 'dependencies_not_injected', message: '依赖未注入' }, 500);
  }

  const config = await configManager.load();
  if (!config.knowledgeBaseRoot || !config.knowledgeBaseRoot.trim()) {
    return c.json({
      error: 'knowledge_base_root_not_configured',
      message: '知识库根目录未设置：请先在「设置 → 知识库」中配置本地根目录',
    }, 400);
  }
  if (config.sync?.whiteboardExport?.enabled === false) {
    return c.json({
      error: 'whiteboard_export_disabled',
      message: 'sync.whiteboardExport.enabled=false，旁路导出已关闭，无需补齐',
    }, 400);
  }
  // §5.8 守卫：构建活跃 → 整个命令 409（旧测试替身无此方法则不拦）。
  if (
    typeof localMapStore.getActiveKbBuild === 'function'
    && localMapStore.getActiveKbBuild() != null
  ) {
    return c.json({
      error: 'kb_build_active',
      message: '标准库构建进行中，暂不能补齐白板旁路文件（构建结束或取消后再试）',
    }, 409);
  }

  const syncEngine = new SyncEngine({ larkCliClient, localMapStore, config });
  try {
    const result = await syncEngine.backfillWhiteboardBypass(
      docTokens ? { docTokens } : {},
    );
    return c.json(result);
  } catch (error) {
    console.error('[sync] whiteboard backfill failed:', error);
    return c.json({
      error: 'whiteboard_backfill_failed',
      message: error instanceof Error ? error.message : String(error),
    }, 500);
  }
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

  // 未设置根目录（且请求未显式携带 rootDir）时索引无意义，提前 400 引导
  // 配置（与 POST /api/sync 的前置校验同源）。
  if ((!rootDir || !String(rootDir).trim())
    && (!config.knowledgeBaseRoot || !config.knowledgeBaseRoot.trim())) {
    return c.json({
      error: 'knowledge_base_root_not_configured',
      message: '知识库根目录未设置：请先在「设置 → 知识库」中配置本地根目录，或采用默认路径',
    }, 400);
  }

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
