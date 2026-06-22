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
import type {
  DiffReport,
  MappingNode,
  ReorderRequest,
  ReorderResponse,
} from '../types/index.js';

export class MappingService {
  constructor(
    private changeDetector: ChangeDetector,
    private localMapStore: LocalMapStore,
    private snapshotService: SnapshotService,
  ) {}

  /**
   * Compute a full DiffReport for a wiki subtree (03 §3.6.2).
   *
   * Flow:
   *   1. Delegate cloud traversal + three-state comparison to
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
    const result = await this.changeDetector.detectChanges(rootUrl);
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
   */
  getTree(): MappingNode[] {
    const documents = this.localMapStore.getAllDocuments();
    const live = documents.filter((d) => (d.cloudDeleted ?? 0) === 0);

    // Precompute wiki_node_token -> has_child once for O(N) total.
    const parentSet = new Set<string>();
    for (const d of live) {
      if (d.parentNodeToken) parentSet.add(d.parentNodeToken);
    }

    return live.map((d) => {
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
        // cloud_match defaults to 'unknown' for rows that pre-date the
        // migration; UI should treat null original_link + unknown as
        // "legacy, run rebuild to classify".
        original_link: d.originalLink ?? null,
        cloud_match: (d.cloudMatch ?? 'unknown') as
          | 'synced'
          | 'restricted'
          | 'unknown',
      } satisfies MappingNode;
    });
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
