/**
 * MappingService - High-level mapping API orchestration (P2-T5/T7/T10).
 *
 * Bridges the ChangeDetector (cloud traversal + three-state comparison)
 * with LocalMapStore (SQLite persistence) and SnapshotService (_index.json
 * cache). The routes in routes/mapping.ts are kept thin; business logic
 * lives here so it is testable with mocks (mirrors the ChangeDetector
 * test pattern).
 *
 * Responsibilities (03 §3.6.2 / §3.6.5 / §3.8):
 *   - computeDiff(rootUrl): run change detection + group into DiffReport
 *   - getTree(): project documents into MappingNode[] for client-side
 *     tree rebuild (Q5: nodes mirror Feishu L1/L2 via parent_node_token,
 *     NOT local directory layout)
 *   - updateSortOrder(parent, ordered): decision-5 local-only reorder;
 *     assigns 0..N as local_sort_order, refuses cross-parent tokens,
 *     triggers SnapshotService.refreshSortOrder()
 *
 * Three-不变量 (03 §3.6.5.1):
 *   - structure unchanged: parent_node_token is NEVER modified here
 *   - sync unchanged: local_sort_order is NEVER read/written by sync
 *   - display adjustable: only local_sort_order is touched on reorder
 */

import type { ChangeDetector } from './change-detector.js';
import type { LocalMapStore } from './local-map-store.js';
import type { SnapshotService } from './snapshot-service.js';
import type { ConfigManager } from './config-manager.js';
import type {
  ChangedDocument,
  DocumentRecord,
  DiffReport,
  MappingNode,
  ReorderRequest,
  ReorderResponse,
  TreeResponse,
  WatchedRoot,
} from '../types/index.js';

/**
 * The hierarchy evidence a persisted row needs before it may be planned as a
 * new local file.  `null` deliberately means "unknown", not an empty chain:
 * an empty chain is valid only for a direct child of the watched root.
 */
interface StoredParentChainProjection {
  parentChainTitles: string[];
  isWatchedRootNode: boolean;
}

export class MappingService {
  constructor(
    private changeDetector: ChangeDetector,
    private localMapStore: LocalMapStore,
    private snapshotService: SnapshotService,
    /**
     * v0.2.0 structure-align Phase B: configManager is needed to read the
     * current structured watchedRoots for the tree API response envelope. Kept
     * optional for backward compatibility with tests that construct the
     * service with the old 3-arg signature.
     */
    private configManager?: ConfigManager,
  ) {}

  /**
   * Compute a full DiffReport for a wiki subtree (03 §3.6.2).
   *
   * Flow:
   *   1. Delegate a fast cloud metadata check + three-state comparison to
   *      ChangeDetector.detectChanges (which already upserts
   *      parent/space/obj_edit_time/last_seen_at metadata).
   *   2. Bucket changed documents by changeType.
   *   3. Compute summary stats (totalCloud from detection result,
   *      totalLocal from SQLite, unchanged = totalCloud - changed-in-cloud).
   *
   * Note: `unchanged` counts only nodes seen in the cloud pass that
   * did not enter the changed list (i.e. added/modified). deleted
   * nodes are local-side orphans and are NOT subtracted from
   * unchanged — they are surfaced in their own bucket per 03 §3.6.1.
  */
  async computeDiff(rootUrl: string): Promise<DiffReport> {
    // Keep the legacy non-cached endpoint safe for older clients too: a
    // diff is about whether known mapped files changed, not a request to
    // rediscover the entire Wiki topology. Full reconciliation remains an
    // explicit detect route mode.
    const result = await this.changeDetector.detectChanges(rootUrl, { mode: 'fast' });
    const changed = result.changedDocuments;

    const added = changed.filter((c) => c.changeType === 'added');
    const modified = changed.filter((c) => c.changeType === 'modified');
    const deleted = changed.filter((c) => c.changeType === 'deleted');

    // changed-in-cloud counts only added + modified (deleted are local
    // side orphans, not cloud-traversed nodes).
    const changedInCloud = added.length + modified.length;
    const unchanged = Math.max(0, result.totalNodes - changedInCloud);

    const totalLocal = this.localMapStore.getAllDocuments().length;

    return {
      added,
      modified,
      deleted,
      unchanged,
      totalCloud: result.totalNodes,
      totalLocal,
      checkedAt: result.checkedAt,
    };
  }

  /**
   * Return the last known diff from SQLite without contacting Feishu.
   *
   * UI rendering must never be the thing that starts a cloud traversal:
   * Dashboard, status badges and the change list can all mount together.
   * Detection is instead owned by the explicit detect endpoint / tray poller,
   * which writes these persistent states first. This method is intentionally
   * read-only and completes in constant local-DB time.
   */
  getStoredDiff(rootUrl: string): DiffReport {
    const rootToken = this.rootTokenFromUrl(rootUrl);
    const documents = this.localMapStore.getAllDocuments()
      .filter((document) =>
        document.watchedRootUrl === rootUrl || document.watchedRootId === rootToken,
      );
    // A previous implementation returned only flat document rows here. That
    // discarded the parent-chain projection supplied by a successful full
    // detect, so the ordinary UI flow (detect → cached diff → sync) lost the
    // hierarchy and PathResolver correctly blocked every newly discovered
    // non-root document as `missing_parent_chain`.
    //
    // Rebuild the chain from the authoritative persisted wiki topology. The
    // resolver is deliberately fail-closed: a missing ancestor, duplicate
    // wiki-node token, wrong root, or cycle yields null rather than a guessed
    // root README path. An explicit full recovery still remains available for
    // genuinely incomplete topology.
    const hierarchyByObjToken = this.projectStoredParentChains(documents, rootToken);
    const added: ChangedDocument[] = [];
    const modified: ChangedDocument[] = [];
    const deleted: ChangedDocument[] = [];
    let checkedAt = '';

    for (const document of documents) {
      if (document.lastSeenAt && document.lastSeenAt > checkedAt) {
        checkedAt = document.lastSeenAt;
      }

      const state = this.storedSyncState(document);
      if (state === 'pending_added') {
        added.push(this.toStoredChangedDocument(
          document,
          'added',
          hierarchyByObjToken.get(document.objToken) ?? null,
        ));
      } else if (state === 'pending_modified') {
        modified.push(this.toStoredChangedDocument(
          document,
          'modified',
          hierarchyByObjToken.get(document.objToken) ?? null,
        ));
      } else if (
        state === 'missing_candidate' ||
        state === 'deleted_confirmed' ||
        document.cloudDeleted === 1
      ) {
        deleted.push(this.toStoredChangedDocument(
          document,
          'deleted',
          hierarchyByObjToken.get(document.objToken) ?? null,
        ));
      }
    }

    const liveCount = documents.filter((document) => document.cloudDeleted !== 1).length;
    return {
      added,
      modified,
      deleted,
      unchanged: Math.max(0, liveCount - added.length - modified.length),
      totalCloud: liveCount,
      totalLocal: documents.length,
      checkedAt,
    };
  }

  private rootTokenFromUrl(rootUrl: string): string {
    try {
      return new URL(rootUrl).pathname.split('/').filter(Boolean).pop() || rootUrl;
    } catch {
      return rootUrl;
    }
  }

  private storedSyncState(document: DocumentRecord): NonNullable<DocumentRecord['syncState']> {
    if (document.syncState) return document.syncState;
    if (document.cloudDeleted === 1) return 'missing_candidate';
    if (document.status === 'error') return 'error';
    if (document.status === 'placeholder') {
      return document.cloudMatch === 'restricted' ? 'restricted' : 'pending_added';
    }
    return document.status === 'changed' ? 'pending_modified' : 'synced';
  }

  private toStoredChangedDocument(
    document: DocumentRecord,
    changeType: ChangedDocument['changeType'],
    hierarchy: StoredParentChainProjection | null,
  ): ChangedDocument {
    const observed = document.observedObjEditTime ?? document.objEditTime ?? null;
    const milliseconds = observed != null && observed < 100_000_000_000
      ? observed * 1000
      : observed;
    return {
      objToken: document.objToken,
      objType: document.objType,
      title: document.title,
      changeType,
      cloudModifiedTime: milliseconds != null && milliseconds > 0
        ? new Date(milliseconds).toISOString()
        : '',
      localSyncedTime: document.lastSyncedAt || null,
      localMdPath: document.localMdPath || null,
      wikiNodeToken: document.wikiNodeToken ?? null,
      parentNodeToken: document.parentNodeToken ?? null,
      spaceId: document.spaceId ?? null,
      watchedRootId: document.watchedRootId ?? null,
      hasChild: document.hasChild ?? false,
      observedObjEditTime: observed,
      syncState: this.storedSyncState(document),
      parentChainTitles: hierarchy?.parentChainTitles,
      isWatchedRootNode: hierarchy?.isWatchedRootNode,
      localRelPath: document.localRelPath ?? null,
    };
  }

  /**
   * Reconstruct parent chains for one watched root from persisted traversal
   * observations. This performs no cloud requests and never invents a path
   * from a local filename, which keeps cached-diff rendering safe.
   */
  private projectStoredParentChains(
    documents: DocumentRecord[],
    rootToken: string,
  ): Map<string, StoredParentChainProjection | null> {
    const byWikiNodeToken = new Map<string, DocumentRecord>();
    const duplicateTokens = new Set<string>();
    for (const document of documents) {
      const token = document.wikiNodeToken?.trim();
      if (!token) continue;
      if (byWikiNodeToken.has(token)) duplicateTokens.add(token);
      byWikiNodeToken.set(token, document);
    }

    const memo = new Map<string, StoredParentChainProjection | null>();
    const visiting = new Set<string>();

    const resolve = (document: DocumentRecord): StoredParentChainProjection | null => {
      if (memo.has(document.objToken)) return memo.get(document.objToken) ?? null;
      const nodeToken = document.wikiNodeToken?.trim();
      const watchedRootId = document.watchedRootId ?? rootToken;
      if (!nodeToken || !watchedRootId || duplicateTokens.has(nodeToken)) {
        memo.set(document.objToken, null);
        return null;
      }
      if (nodeToken === watchedRootId) {
        const root = { parentChainTitles: [], isWatchedRootNode: true };
        memo.set(document.objToken, root);
        return root;
      }
      if (visiting.has(document.objToken)) {
        memo.set(document.objToken, null);
        return null;
      }

      const parentToken = document.parentNodeToken?.trim();
      // A direct child needs no parent row: the configured root token itself
      // is already sufficient proof that its ancestor chain is empty.
      if (parentToken === watchedRootId) {
        const directChild = { parentChainTitles: [], isWatchedRootNode: false };
        memo.set(document.objToken, directChild);
        return directChild;
      }
      if (!parentToken || duplicateTokens.has(parentToken)) {
        memo.set(document.objToken, null);
        return null;
      }

      const parent = byWikiNodeToken.get(parentToken);
      if (!parent || (parent.watchedRootId ?? rootToken) !== watchedRootId || !parent.title.trim()) {
        memo.set(document.objToken, null);
        return null;
      }

      visiting.add(document.objToken);
      const parentProjection = resolve(parent);
      visiting.delete(document.objToken);
      if (!parentProjection) {
        memo.set(document.objToken, null);
        return null;
      }

      const projection = {
        parentChainTitles: [...parentProjection.parentChainTitles, parent.title],
        isWatchedRootNode: false,
      };
      memo.set(document.objToken, projection);
      return projection;
    };

    for (const document of documents) resolve(document);
    return memo;
  }

  /**
   * Project all documents into a flat MappingNode[] (03 §3.8 + §3.6.4).
   *
   * The frontend rebuilds the tree client-side by parent_node_token.
   * We deliberately keep this array flat — server-side tree nesting
   * would force eager recursion and complicate pagination / lazy
   * expansion in the UI.
   *
   * cloud_deleted rows are EXCLUDED: the trash-bin UI surfaces them
   * via a separate path (LocalMapStore.listCloudDeleted), so the tree
   * only shows live nodes.
   *
   * v0.2.0 structure-align Phase B: this legacy overload returns the
   * cloud-view (wiki_node_token != null) projection WITHOUT the
   * watched_roots envelope. New callers should prefer
   * getTreeDetailed({view}) which returns the TreeResponse envelope
   * with watched_roots + orphan_files + stats. The thin `/api/mapping/tree`
   * route still calls this overload for backward compatibility with
   * existing clients; the new `?view=` query param routes to
   * getTreeDetailed instead.
   */
  getTree(): MappingNode[] {
    const documents = this.localMapStore.getAllDocuments();
    const live = documents.filter((d) => (d.cloudDeleted ?? 0) === 0);

    // Precompute wiki_node_token -> has_child once for O(N) total.
    const parentSet = new Set<string>();
    for (const d of live) {
      if (d.parentNodeToken) parentSet.add(d.parentNodeToken);
    }

    return live.map((d) => this.projectNode(d, parentSet));
  }

  /**
   * v0.2.0 structure-align Phase B: dual-view tree response.
   *
   * The view parameter controls how the flat node list is filtered:
   *
   *   - view='feishu' (default): only rows with wiki_node_token IS NOT NULL
   *     are returned. These are the rows that correspond to actual
   *     feishu nodes; the frontend rebuilds the cloud tree from
   *     parent_node_token. Top-level nodes (parent_node_token NULL)
   *     should be grouped under their watched_root_url by the frontend.
   *
   *   - view='local': ALL rows are returned (including wiki_node_token NULL
   *     local-only files). The frontend rebuilds the directory tree
   *     from local_path. orphan_files are also included so the UI can
   *     show files that exist on disk but were never mapped in SQLite.
   *
   * The response always carries:
   *   - watched_roots: array of materialized WatchedRoot records (for
   *     top-level grouping + status display)
   *   - orphan_files: only populated when view='local'
   *   - stats: total_nodes + watched_root_count + cloud_match distribution
   *
   * `view='feishu'` is the default to keep the legacy shape backward
   * compatible: a client that adds `?view=feishu` to an existing URL
   * should see the exact same nodes it saw before (with the extra
   * watched_root_url field per node).
   */
  getTreeDetailed(options: { view: 'feishu' | 'local'; includeOrphans?: boolean } = { view: 'feishu' }): TreeResponse {
    const view = options.view === 'local' ? 'local' : 'feishu';
    const includeOrphans = options.includeOrphans ?? (view === 'local');

    const documents = this.localMapStore.getAllDocuments();
    const live = documents.filter((d) => (d.cloudDeleted ?? 0) === 0);

    // Precompute parent->child presence once for O(N) has_child.
    const parentSet = new Set<string>();
    for (const d of live) {
      if (d.parentNodeToken) parentSet.add(d.parentNodeToken);
    }

    let nodes: MappingNode[];
    if (view === 'feishu') {
      // Cloud view: only rows with a feishu node identity.
      // The second filter drops placeholder nodes — rows with a non-empty
      // wiki_node_token but an empty title/local_path. These come from
      // change-detector.upsertDocumentSeen's permission-restricted branch
      // (cloud_match='restricted', status='placeholder'); they carry no
      // user-visible information and would otherwise render as blank rows
      // in NodeTreeView. A non-empty title is the signal that the row has
      // been back-filled with real metadata (synced or a titled restricted
      // node). Note this filter is intentionally feishu-view-only: the
      // local view must keep every row so LocalDirTreeView can show all
      // on-disk files (placeholder rows have local_path='' and are
      // naturally skipped by splitPath anyway).
      // P2 Gate 2: keep restricted/pending placeholders visible even when
      // title is empty — project a diagnostic display title instead of dropping.
      nodes = live
        .filter(
          (d) => d.wikiNodeToken != null && d.wikiNodeToken !== '',
        )
        .map((d) => {
          const node = this.projectNode(d, parentSet);
          if (!(d.title ?? '').trim()) {
            const state = d.syncState ?? d.status;
            if (state === 'restricted' || d.cloudMatch === 'restricted' || d.status === 'placeholder') {
              node.title = '(权限受限·占位)';
              node.cloud_match = 'restricted';
            } else if (
              state === 'pending_added' ||
              state === 'pending_modified' ||
              state === 'missing_candidate'
            ) {
              node.title = node.title || `(${state})`;
            } else {
              node.title = node.title || '(未命名)';
            }
          }
          return node;
        });
    } else {
      // Local view: all rows (including local-only README/index).
      nodes = live.map((d) => this.projectNode(d, parentSet));
    }

    // watched_roots envelope (always present).
    const configuredRoots = this.configManager?.getConfig()?.watchedRoots ?? [];
    const watchedRoots: WatchedRoot[] =
      typeof (this.localMapStore as any).getWatchedRoots === 'function'
        ? (this.localMapStore as any).getWatchedRoots(configuredRoots)
        : [];

    // orphan_files only meaningful in local view.
    let orphanFiles: TreeResponse['orphan_files'] = [];
    if (includeOrphans) {
      try {
        const config = this.configManager?.getConfig();
        if (config?.knowledgeBaseRoot) {
          const snap = this.snapshotService.readExisting(config.knowledgeBaseRoot);
          if (snap?.orphan_files) {
            orphanFiles = snap.orphan_files;
          }
        }
      } catch (err) {
        // Reading orphans is best-effort; never fail the whole tree call.
        console.warn('[MappingService] orphan_files lookup failed:', err);
      }
    }

    // Distribution stats.
    const dist: Record<string, number> = {};
    for (const n of nodes) {
      const k = n.cloud_match ?? 'unknown';
      dist[k] = (dist[k] ?? 0) + 1;
    }

    return {
      view,
      nodes,
      watched_roots: watchedRoots,
      orphan_files: orphanFiles,
      stats: {
        total_nodes: nodes.length,
        watched_root_count: watchedRoots.length,
        cloud_match_distribution: dist,
      },
    };
  }

  /**
   * Project a single DocumentRecord into the MappingNode shape shared
   * by getTree + getTreeDetailed. v0.2.0 structure-align Phase B adds
   * watched_root_url to the projection so the frontend can group
   * top-level entries.
   */
  private projectNode(d: any, parentSet: Set<string>): MappingNode {
    const wikiNodeToken = d.wikiNodeToken ?? null;
    const hasChild = wikiNodeToken != null && parentSet.has(wikiNodeToken);
    return {
      obj_token: d.objToken,
      wiki_node_token: wikiNodeToken,
      space_id: d.spaceId ?? null,
      obj_type: d.objType ?? 'unknown',
      title: d.title,
      local_path: d.localMdPath,
      parent_node_token: d.parentNodeToken ?? null,
      has_child: hasChild,
      obj_edit_time: d.objEditTime ?? null,
      last_synced_modify_time: d.lastSyncedModifyTime,
      last_synced_at: d.lastSyncedAt,
      last_seen_at: d.lastSeenAt ?? null,
      status: d.status,
      cloud_deleted: d.cloudDeleted ?? 0,
      sortOrder: d.localSortOrder ?? null,
      // v0.2.0 cloud-link-coverage: expose the explicit feishu relationship.
      original_link: d.originalLink ?? null,
      cloud_match: (d.cloudMatch ?? 'unknown') as
        | 'synced'
        | 'restricted'
        | 'unknown',
      // v0.2.0 structure-align Phase B: surface the watchedRoot that owns
      // this node so the frontend can group top-level entries.
      watched_root_url: d.watchedRootUrl ?? null,
    } satisfies MappingNode;
  }

  /**
   * Apply a user-initiated sibling reorder (decision 5, 03 §3.6.5).
   *
   * Contract:
   *   - parent_node_token scopes the update; only rows whose
   *     parent_node_token matches will receive a new local_sort_order.
   *   - ordered_obj_tokens is the COMPLETE new ordering of that
   *     sibling set; backend assigns 0..N by array index.
   *   - Cross-parent rejection: if any token in the array has a
   *     stored parent_node_token that doesn't match the request's
   *     parent_node_token, the whole request is rejected with 400
   *     (caller surfaces the error in the UI). This is the backend
   *     second-line defense — the frontend already prevents cross-
   *     parent drags, but we double-check to defend against buggy
   *     clients and direct API misuse.
   *   - On success, the _index.json snapshot is refreshed so the
   *     new sortOrder is visible without a full regen.
   *
   * Returns updated count + refreshed_index=true.
   */
  updateSortOrder(req: ReorderRequest): ReorderResponse {
    if (!Array.isArray(req.ordered_obj_tokens)) {
      throw new MappingValidationError('ordered_obj_tokens must be an array');
    }
    if (req.ordered_obj_tokens.length === 0) {
      // No-op reorder: no rows to update, but still refresh the snapshot
      // so the _index.json reflects a consistent state (the user
      // explicitly hit the endpoint; cheap path).
      this.snapshotService.refreshSortOrder();
      return { updated: 0, refreshed_index: true };
    }

    // Cross-parent defense: verify every token's stored parent matches.
    const mismatches: string[] = [];
    for (const tok of req.ordered_obj_tokens) {
      const row = this.localMapStore.getDocumentByObjToken(tok);
      if (!row) {
        mismatches.push(tok);
        continue;
      }
      const storedParent = row.parentNodeToken ?? null;
      const requestParent = req.parent_node_token ?? null;
      if (storedParent !== requestParent) {
        mismatches.push(tok);
      }
    }
    if (mismatches.length > 0) {
      throw new CrossParentReorderError(
        `Tokens are not children of parent ${req.parent_node_token}: ${mismatches.join(', ')}`,
        mismatches,
      );
    }

    const updated = this.localMapStore.setSortOrder(
      req.parent_node_token,
      req.ordered_obj_tokens,
    );

    // Refresh _index.json so the new sortOrder is reflected. We use the
    // cheap refreshSortOrder path (no orphan rescan) per 03 §3.6.5.2.
    this.snapshotService.refreshSortOrder();

    return { updated, refreshed_index: true };
  }
}

/**
 * Validation error (400): malformed request body.
 */
export class MappingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingValidationError';
  }
}

/**
 * Cross-parent rejection (400): one or more tokens do not belong to
 * the requested parent. Carries the offending tokens so the UI can
 * highlight them if desired.
 */
export class CrossParentReorderError extends Error {
  mismatches: string[];
  constructor(message: string, mismatches: string[]) {
    super(message);
    this.name = 'CrossParentReorderError';
    this.mismatches = mismatches;
  }
}
