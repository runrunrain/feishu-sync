/**
 * Mapping Routes - Cloud/local mapping API endpoints (P2-T5/T6/T7/T10).
 *
 *   GET  /api/mapping/diff           - DiffReport (added/modified/deleted/unchanged)
 *   GET  /api/mapping/tree           - Flat MappingNode[] for client-side tree rebuild
 *   GET  /api/mapping/index          - Current _index.json snapshot (no regen)
 *   POST /api/mapping/refresh-index  - Force-regenerate _index.json (manual trigger)
 *   POST /api/mapping/reorder        - Local-only drag reorder (decision 5)
 *
 * Routes are intentionally thin: business logic lives in MappingService
 * and SnapshotService so the same code paths are exercised by unit
 * tests with in-memory mocks.
 *
 * Dependency injection follows the existing project pattern: routes
 * read services off the Hono context (set by index.ts middleware).
 * Before those services are wired into index.ts in this task, the
 * routes construct them lazily from the always-injected
 * localMapStore / changeDetector / configManager so the endpoints
 * work end-to-end without requiring callers to update middleware.
 */

import { Hono } from 'hono';
import { MappingService, MappingValidationError, CrossParentReorderError } from '../modules/mapping-service.js';
import { SnapshotService } from '../modules/snapshot-service.js';
import { IndexScanner } from '../modules/index-scanner.js';
import type { ReorderRequest } from '../types/index.js';

const mappingRoutes = new Hono();

/**
 * Lazily build a MappingService. The first request pays the
 * construction cost; subsequent requests reuse the cached instance
 * stored on the Hono context root.
 *
 * Wiring design: index.ts already injects changeDetector /
 * localMapStore / configManager / larkCliClient into c. We compose
 * the SnapshotService + MappingService here so this route file is
 * self-contained and doesn't force an index.ts refactor in the same
 * commit. A future cleanup can hoist this wiring into index.ts.
 */
function getMappingService(c: any): MappingService {
  if (!c.__mappingService) {
    const localMapStore = c.localMapStore;
    const changeDetector = c.changeDetector;
    const configManager = c.configManager;
    const larkCliClient = c.larkCliClient;

    if (!localMapStore || !changeDetector || !configManager) {
      throw new Error('[mapping] required dependencies not injected');
    }

    const indexScanner = new IndexScanner({
      localMapStore,
      larkCliClient,
      config: configManager.getConfig() ?? {},
    });
    const snapshotService = new SnapshotService(localMapStore, configManager, indexScanner);
    c.__mappingService = new MappingService(
      changeDetector,
      localMapStore,
      snapshotService,
      configManager,
    );
    c.__snapshotService = snapshotService;
  }
  return c.__mappingService as MappingService;
}

function getSnapshotService(c: any): SnapshotService {
  // Ensure both are constructed together (getMappingService caches
  // the snapshot service as a side effect).
  getMappingService(c);
  return c.__snapshotService as SnapshotService;
}

/** The deletion-candidate endpoints only need the state store. */
function getLocalMapStore(c: any): {
  listMissingCandidates: () => unknown[];
  confirmMissingCandidateDeletion: (objToken: string, confirmedAt: string) => boolean;
} {
  const localMapStore = c.localMapStore;
  if (!localMapStore
    || typeof localMapStore.listMissingCandidates !== 'function'
    || typeof localMapStore.confirmMissingCandidateDeletion !== 'function') {
    throw new Error('[mapping] localMapStore is not injected');
  }
  return localMapStore;
}

// ---------------------------------------------------------------------------
// GET /api/mapping/diff  (P2-T5, R3.6-AC1)
// ---------------------------------------------------------------------------

/**
 * Query params:
 *   rootUrl (required) - Feishu wiki URL to diff against
 *   cached=1 (optional) - read the last persisted detection result only;
 *                         never starts a cloud request. UI callers use this
 *                         mode so rendering cannot trigger a traversal.
 *
 * Response: DiffReport
 */
mappingRoutes.get('/api/mapping/diff', async (c) => {
  const rootUrl = c.req.query('rootUrl');
  if (!rootUrl) {
    return c.json({ error: 'rootUrl query parameter is required' }, 400);
  }

  try {
    const svc = getMappingService(c);
    const report = c.req.query('cached') === '1'
      ? svc.getStoredDiff(rootUrl)
      : await svc.computeDiff(rootUrl);
    return c.json(report);
  } catch (error) {
    console.error('[mapping] computeDiff failed:', error);
    return c.json(
      {
        error: 'diff_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// Missing/deletion candidates (v5 state model)
// ---------------------------------------------------------------------------
//
// Traversal itself never soft-deletes a row. After two complete misses it
// marks a record as `missing_candidate`; this small API makes the candidate
// visible to a future UI and requires a literal confirmation before it can
// move into the existing trash/cleanup flow.

mappingRoutes.get('/api/mapping/missing-candidates', (c) => {
  try {
    const localMapStore = getLocalMapStore(c);
    return c.json({ candidates: localMapStore.listMissingCandidates() });
  } catch (error) {
    console.error('[mapping] list missing candidates failed:', error);
    return c.json(
      {
        error: 'missing_candidates_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

mappingRoutes.post('/api/mapping/missing-candidates/:objToken/confirm', async (c) => {
  let body: { confirmation?: unknown };
  try {
    body = await c.req.json() as { confirmation?: unknown };
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (body?.confirmation !== 'DELETE') {
    return c.json(
      {
        error: 'confirmation_required',
        message: '请在请求体中提供 confirmation: "DELETE" 以确认已核对删除候选。',
      },
      400,
    );
  }

  try {
    const localMapStore = getLocalMapStore(c);
    const objToken = c.req.param('objToken');
    const confirmed = localMapStore.confirmMissingCandidateDeletion(
      objToken,
      new Date().toISOString(),
    );
    if (!confirmed) {
      return c.json(
        {
          error: 'candidate_not_found_or_stale',
          message: '该文档当前不是可确认的缺失候选；请重新检测后再操作。',
        },
        409,
      );
    }
    return c.json({ confirmed: true, objToken });
  } catch (error) {
    console.error('[mapping] confirm missing candidate failed:', error);
    return c.json(
      {
        error: 'confirm_missing_candidate_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// GET /api/mapping/tree  (P2-T7, R3.8-AC1)
// ---------------------------------------------------------------------------

/**
 * Response: { nodes: MappingNode[] } | TreeResponse (when ?view= is set)
 *
 * Query params:
 *   view (optional) - 'feishu' | 'local'. When present, returns the
 *     full TreeResponse envelope (view + watched_roots + orphan_files
 *     + stats). When absent, returns the legacy { nodes } shape for
 *     backward compatibility with clients that consume only that field.
 *
 *   view='feishu' (default when ?view= is present): only rows with
 *     wiki_node_token != null are returned. The frontend rebuilds the
 *     cloud tree from parent_node_token.
 *
 *   view='local': ALL rows are returned (including local-only README).
 *     The frontend rebuilds the directory tree from local_path.
 *     orphan_files are also included.
 *
 * Legacy contract: clients that omit ?view= continue to receive
 * { nodes: MappingNode[] } and can use the cloud-view semantics
 * implicitly (the legacy overload filters out cloud_deleted but does
 * not filter wiki_node_token=NULL — the new view='feishu' filter is
 * stricter, so existing clients may see slightly fewer nodes if they
 * opt-in to the new query param).
 */
mappingRoutes.get('/api/mapping/tree', async (c) => {
  try {
    const svc = getMappingService(c);
    const rawView = c.req.query('view');
    // Treat absent / empty / unknown view as "legacy" so existing callers
    // keep seeing the unchanged { nodes } response shape.
    if (rawView === undefined || rawView === '') {
      const nodes = svc.getTree();
      return c.json({ nodes });
    }
    const view = rawView === 'local' ? 'local' : 'feishu';
    const includeOrphans = c.req.query('include_orphans') !== 'false';
    const envelope = svc.getTreeDetailed({ view, includeOrphans });
    return c.json(envelope);
  } catch (error) {
    console.error('[mapping] getTree failed:', error);
    return c.json(
      {
        error: 'tree_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// GET /api/mapping/index  (convenience: current snapshot, no regen)
// ---------------------------------------------------------------------------

mappingRoutes.get('/api/mapping/index', async (c) => {
  try {
    const snap = getSnapshotService(c);
    const config = (c as any).configManager.getConfig();
    if (!config?.knowledgeBaseRoot) {
      return c.json({ error: 'knowledgeBaseRoot not configured' }, 400);
    }
    const existing = snap.readExisting(config.knowledgeBaseRoot);
    if (!existing) {
      return c.json({ error: 'snapshot_not_generated_yet' }, 404);
    }
    return c.json(existing);
  } catch (error) {
    console.error('[mapping] read snapshot failed:', error);
    return c.json(
      {
        error: 'snapshot_read_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /api/mapping/refresh-index  (manual snapshot regen, P2-T6)
// ---------------------------------------------------------------------------

mappingRoutes.post('/api/mapping/refresh-index', async (c) => {
  try {
    const snap = getSnapshotService(c);
    const snapshot = snap.generate();
    return c.json({
      generated_at: snapshot.generated_at,
      node_count: snapshot.nodes.length,
      orphan_count: snapshot.orphan_files.length,
      top_level_dirs: snapshot.top_level_dirs,
    });
  } catch (error) {
    console.error('[mapping] refresh-index failed:', error);
    return c.json(
      {
        error: 'refresh_index_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /api/index/rebuild  (P0-bug-2 fix, v0.2.0 P5)
// ---------------------------------------------------------------------------
//
// Forces a full re-scan of the knowledge base via IndexScanner so every
// .md file gets its real title + status='synced' written back into the
// documents table. This is the missing "first index / repair index"
// entry point called out in wukong P5 §5.1 P0-bug-2: the existing
// refresh-index only re-projects SQLite into _index.json, so rows that
// were written as placeholder by upsertDocumentSeen (title='', never
// updated by change-detector) surfaced as empty titles in the tree.
//
// Contract (agreed with 洛神 frontend):
//   Request body: {} (optional, ignored)
//   Response 200: {
//     rebuilt: number,             // count of .md files successfully indexed
//     scanned: number,             // total .md files seen
//     refreshed_index: boolean,    // whether _index.json was regenerated
//     failed: Array<{ file: string; error: string }>
//   }
//   Response 400: knowledgeBaseRoot not configured
//   Response 500: unexpected error
//
// Idempotent + read-only on the knowledge base: IndexScanner reads .md
// files but never writes them; it only upserts into SQLite.

mappingRoutes.post('/api/index/rebuild', async (c) => {
  try {
    const configManager: any = (c as any).configManager;
    const config = configManager?.getConfig();
    if (!config?.knowledgeBaseRoot) {
      return c.json(
        { error: 'knowledgeBaseRoot not configured', rebuilt: 0, refreshed_index: false, failed: [] },
        400,
      );
    }

    const localMapStore: any = (c as any).localMapStore;
    const larkCliClient: any = (c as any).larkCliClient;
    if (!localMapStore || !larkCliClient) {
      return c.json(
        { error: 'required_dependencies_not_injected', rebuilt: 0, refreshed_index: false, failed: [] },
        500,
      );
    }

    const indexScanner = new IndexScanner({
      localMapStore,
      larkCliClient,
      config,
    });

    const scanResult = await indexScanner.scanKnowledgeBase(config.knowledgeBaseRoot);

    // After re-indexing, regenerate the _index.json snapshot so the UI
    // immediately sees the refreshed titles. Reuse the SnapshotService
    // built by getMappingService so the orphan-detection / top-level-dir
    // aggregation stays consistent with the GET /api/mapping/index path.
    let refreshed = false;
    try {
      const snap = getSnapshotService(c);
      snap.generate();
      refreshed = true;
    } catch (snapErr) {
      // Snapshot regen must not fail the whole rebuild — the SQLite write
      // already succeeded. Log and surface refreshed_index=false.
      console.warn('[mapping] index rebuild: snapshot regen skipped', snapErr);
    }

    return c.json({
      rebuilt: scanResult.indexed,
      scanned: scanResult.scanned,
      refreshed_index: refreshed,
      failed: scanResult.errors,
      // 2026-09：手动删除清理统计——本地文件已不存在而被硬删的 documents
      // 行数，前端 toast 提示用户视图残留已被清理。
      pruned_local_missing: scanResult.prunedLocalMissing ?? 0,
    });
  } catch (error) {
    console.error('[mapping] index rebuild failed:', error);
    return c.json(
      {
        error: 'rebuild_failed',
        message: error instanceof Error ? error.message : String(error),
        rebuilt: 0,
        refreshed_index: false,
        failed: [],
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /api/mapping/reorder  (P2-T10, R2.2bis-AC1/AC2/AC3/AC4)
// ---------------------------------------------------------------------------

/**
 * Request body: ReorderRequest
 *   {
 *     parent_node_token: string | null,
 *     ordered_obj_tokens: string[]
 *   }
 *
 * Response: ReorderResponse { updated, refreshed_index }
 *
 * Errors:
 *   400 MappingValidationError    - malformed body
 *   400 CrossParentReorderError   - tokens span multiple parents
 *   500                           - unexpected failure
 */
mappingRoutes.post('/api/mapping/reorder', async (c) => {
  let body: ReorderRequest;
  try {
    body = (await c.req.json()) as ReorderRequest;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (body == null || typeof body !== 'object') {
    return c.json({ error: 'invalid_body', message: 'expected an object' }, 400);
  }
  if (
    !('ordered_obj_tokens' in body) ||
    !Array.isArray(body.ordered_obj_tokens) ||
    !body.ordered_obj_tokens.every((t) => typeof t === 'string')
  ) {
    return c.json(
      {
        error: 'invalid_body',
        message: 'ordered_obj_tokens must be an array of strings',
      },
      400,
    );
  }
  if (
    body.parent_node_token != null &&
    typeof body.parent_node_token !== 'string'
  ) {
    return c.json(
      {
        error: 'invalid_body',
        message: 'parent_node_token must be a string or null',
      },
      400,
    );
  }

  try {
    const svc = getMappingService(c);
    const result = svc.updateSortOrder(body);
    return c.json(result);
  } catch (error) {
    if (error instanceof MappingValidationError) {
      return c.json({ error: 'validation_failed', message: error.message }, 400);
    }
    if (error instanceof CrossParentReorderError) {
      return c.json(
        {
          error: 'cross_parent_rejected',
          message: error.message,
          mismatches: error.mismatches,
        },
        400,
      );
    }
    console.error('[mapping] reorder failed:', error);
    return c.json(
      {
        error: 'reorder_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

export { mappingRoutes };
