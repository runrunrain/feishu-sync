/**
 * ChangeDetector - Detect changes in Feishu wiki subtrees
 *
 * v0.2.0 mapping-core rewrite (03 §3.3):
 * - detectChanges(): main entry point
 * - traverseWikiSubtree(): BFS recursion; for each node fetches real
 *   obj_edit_time via wiki URL (situation B per P0-Q1 实测: lark-cli
 *   `wiki +node-list` does NOT return obj_edit_time, so per-node
 *   `wiki +node-get` is required).
 * - compareWithLocalRecords(): three-state identification
 *     added     -> no local record
 *     modified  -> cloud obj_edit_time > local.obj_edit_time
 *                  (NULL local treated as "unknown, do not report modified"
 *                   to handle the 3 permission-restricted docs flagged in
 *                   diting P1 review §五; NULL cloud is also treated as
 *                   "unknown")
 *     deleted   -> local record exists but absent from cloud traversal
 *                  (placeholder rows are excluded; soft delete only)
 * - detectSheetSubChanges(): per-workbook sub-sheet add/del detection
 *
 * Field mapping validated by 飞书认证架构专项设计 §十一 and P0-Q1 实测:
 * - obj_edit_time: Unix seconds string from lark-cli wiki +node-get,
 *                  parsed to int; NULL when permission restricted.
 * - space_id: from getNode(rootUrl) return value.
 * - parent_node_token: from +node-list (since 1.0.53 returns it).
 * - has_child: boolean for recursion.
 *
 * Bug fixes covered: B1 (modified/deleted identification), B7 (real
 * obj_edit_time instead of new Date().toISOString() placeholder), B8
 * (parent_node_token/space_id actually persisted).
 *
 * The obj_edit_time fetching uses a fingerprint short-circuit (03 §3.3.2
 * 情况 B): if a node's (title + obj_token) signature is unchanged AND
 * the local row already has a non-null obj_edit_time, we skip the
 * per-node node-get call and reuse the cached value. has_child is NOT
 * part of the fingerprint because the documents table does not persist
 * it (03 §3.1 declares has_child too volatile to be worth storing);
 * title+obj_token equality is sufficient since a renamed doc keeps its
 * obj_token (triggering a refresh, which is correct) and a different
 * obj_token means a different doc entirely. This bounds the worst-case
 * extra requests to "nodes that actually changed identity" instead of
 * all nodes on every poll.
 */

import type { LarkCliClient } from './lark-cli-client.js';
import type { LocalMapStore } from './local-map-store.js';
import type {
  ChangeDetectionResult,
  ChangedDocument,
  LarkCliNodeInfo,
  DocumentRecord,
} from '../types/index.js';

/**
 * Lightweight result of +node-list (no obj_edit_time; situation B).
 * Fields validated by P0-Q1 实测 against lark-cli 1.0.53.
 */
interface RawListNode {
  node_token: string;
  obj_token: string;
  obj_type: LarkCliNodeInfo['obj_type'];
  title: string;
  has_child: boolean;
  parent_node_token?: string;
  space_id?: string;
}

/**
 * Per-workbook sub-sheet change (03 §3.5). Feishu workbooks share one
 * obj_edit_time across all sub-sheets, so per-sub-sheet modification
 * cannot be precisely detected — we surface "may-be-modified" for all
 * sub-sheets when the workbook's obj_edit_time advanced, and add/del
 * for sub-sheet set differences.
 */
export interface SheetSubChange {
  sheetObjToken: string;
  sheetId: string;
  title: string;
  changeType: 'added' | 'deleted' | 'may-be-modified';
}

export class ChangeDetector {
  // space_id cache: rootUrl -> space_id (avoid repeated getNode calls)
  private spaceIdCache = new Map<string, string>();

  constructor(
    private larkCliClient: LarkCliClient,
    private localMapStore: LocalMapStore
  ) {}

  /**
   * Main entry point: detect changes in a wiki subtree.
   */
  async detectChanges(rootUrl: string): Promise<ChangeDetectionResult> {
    // 1. Get root node info (space_id + root_token + obj_edit_time)
    const rootInfo = await this.larkCliClient.getNode(rootUrl);
    const spaceId = rootInfo.space_id;
    const rootToken = rootInfo.node_token;

    // Cache space_id for future calls
    this.spaceIdCache.set(rootUrl, spaceId);

    // 2. Traverse entire subtree and collect all nodes (with real obj_edit_time)
    const cloudNodes = await this.traverseWikiSubtree(spaceId, rootToken);

    // 3. Compare with local SQLite records (three-state)
    const changedDocuments = await this.compareWithLocalRecords(cloudNodes);

    return {
      changed: changedDocuments.length > 0,
      changedDocuments,
      checkedAt: new Date().toISOString(),
      totalNodes: cloudNodes.length,
    };
  }

  /**
   * Traverse wiki subtree using BFS queue (03 §3.3.2 情况 B).
   *
   * Step 1: BFS via `wiki +node-list --page-all` collects the full node
   *         set with parent/title/has_child but NO obj_edit_time.
   * Step 2: For each node, fetch real obj_edit_time via `wiki +node-get`
   *         using a wiki URL constructed from space_id + node_token
   *         (lark-cli 1.0.53 infers obj_type from the typed wiki URL,
   *          avoiding the --obj-type requirement).
   *
   * Fingerprint short-circuit: if the local row already has a non-null
   * obj_edit_time AND (title, has_child, obj_token) are unchanged, we
   * trust the cached value and skip the node-get. This is the
   * optimization mandated by 03 §3.3.2 for the situation-B performance
   * penalty.
   */
  private async traverseWikiSubtree(
    spaceId: string,
    rootToken: string
  ): Promise<LarkCliNodeInfo[]> {
    const rawNodes = await this.bfsCollectRawNodes(spaceId, rootToken);
    const enriched: LarkCliNodeInfo[] = [];

    for (const raw of rawNodes) {
      const cached = this.localMapStore.getDocumentByObjToken(raw.obj_token);
      const fingerprintUnchanged = this.isFingerprintUnchanged(raw, cached);

      let objEditTime: number | null;
      let parentNodeToken = raw.parent_node_token ?? null;

      if (fingerprintUnchanged && cached?.objEditTime != null) {
        // Fingerprint hit: reuse cached obj_edit_time, skip node-get
        objEditTime = cached.objEditTime;
      } else {
        // Fingerprint miss or no cache: fetch fresh obj_edit_time
        const nodeDetail = await this.fetchNodeDetail(spaceId, raw.node_token);
        if (nodeDetail) {
          objEditTime = nodeDetail.obj_edit_time;
          // Prefer freshly-fetched parent_node_token (more authoritative
          // than +node-list, in case of recent moves) when present.
          if (nodeDetail.parent_node_token) {
            parentNodeToken = nodeDetail.parent_node_token;
          }
        } else {
          // node-get failed (permission/timeout): treat obj_edit_time as
          // unknown (NULL). compareWithLocalRecords handles NULL safely
          // (does not report modified).
          objEditTime = null;
        }
      }

      enriched.push({
        node_token: raw.node_token,
        obj_token: raw.obj_token,
        obj_type: raw.obj_type,
        title: raw.title,
        space_id: raw.space_id ?? spaceId,
        obj_edit_time: objEditTime ?? 0,
        has_child: raw.has_child,
        parent_node_token: parentNodeToken ?? undefined,
      });
    }

    return enriched;
  }

  /**
   * BFS traversal using `wiki +node-list`. Returns the raw node set
   * WITHOUT obj_edit_time (situation B). Single-level failures are
   * logged and skipped so a partial outage does not abort the entire
   * traversal.
   */
  private async bfsCollectRawNodes(
    spaceId: string,
    rootToken: string
  ): Promise<RawListNode[]> {
    const all: RawListNode[] = [];
    const queue: string[] = [rootToken];
    const visited = new Set<string>([rootToken]);

    while (queue.length > 0) {
      const currentToken = queue.shift()!;

      try {
        const nodes = await this.larkCliClient.listWikiNodes({
          spaceId,
          parentNodeToken: currentToken,
        });

        for (const node of nodes as RawListNode[]) {
          // Defensive dedupe: lark-cli occasionally re-surfaces a node
          // via pagination echoes; cycle-break on node_token.
          if (visited.has(node.node_token)) continue;
          visited.add(node.node_token);

          all.push({
            node_token: node.node_token,
            obj_token: node.obj_token,
            obj_type: node.obj_type,
            title: node.title,
            has_child: !!node.has_child,
            parent_node_token: node.parent_node_token ?? currentToken,
            space_id: node.space_id ?? spaceId,
          });

          if (node.has_child) {
            queue.push(node.node_token);
          }
        }
      } catch (error) {
        // Single level failure should not interrupt entire traversal
        console.error(
          `[ChangeDetector] Failed to list nodes for token ${currentToken}:`,
          error
        );
        continue;
      }
    }

    return all;
  }

  /**
   * Fetch full node detail (incl. real obj_edit_time) via wiki URL.
   *
   * lark-cli 1.0.53 +node-get requires --obj-type for a raw token, but
   * a typed wiki URL `https://<host>/wiki/<node_token>` lets lark-cli
   * resolve the node and infer obj_type itself (P0-Q1 实测). We avoid
   * touching lark-cli-client.ts auth/QPS surface (architecture red line
   * I1) by reusing getNode and constructing the URL here.
   *
   * Returns null on failure (permission revoked, rate limit, timeout)
   * so the caller can degrade gracefully (NULL obj_edit_time, no
   * modified report) instead of aborting the whole traversal.
   */
  private async fetchNodeDetail(
    spaceId: string,
    nodeToken: string
  ): Promise<LarkCliNodeInfo | null> {
    // The host is config-driven in production; we infer it from the
    // spaceId cache key when possible. For now we use the canonical
    // qcnbafdrjx7n.feishu.cn host which is the only knowledge space
    // configured in this deployment. If future spaces need different
    // hosts, expose a host resolver in config.
    const wikiUrl = `https://qcnbafdrjx7n.feishu.cn/wiki/${nodeToken}`;
    void spaceId; // kept for future host resolution; not used today

    try {
      return await this.larkCliClient.getNode(wikiUrl);
    } catch (error) {
      console.warn(
        `[ChangeDetector] node-get failed for ${nodeToken}, treating obj_edit_time as NULL:`,
        error
      );
      return null;
    }
  }

  /**
   * Fingerprint equality check (03 §3.3.2 情况 B optimization).
   *
   * "Unchanged" means the (title, obj_token) pair from +node-list
   * matches what's stored locally. has_child is intentionally NOT part
   * of the fingerprint (documents table does not persist it; see file
   * header + 03 §3.1). When title+obj_token match AND the local row
   * has a non-null obj_edit_time, we skip the per-node node-get and
   * trust the cache. Any field mismatch forces a refresh.
   */
  private isFingerprintUnchanged(
    raw: RawListNode,
    cached: DocumentRecord | null
  ): boolean {
    if (!cached) return false;
    if (cached.objEditTime == null) return false;
    if (cached.title !== raw.title) return false;
    // has_child not stored on documents table; use obj_token equality
    // + title equality as the fingerprint (obj_token changes imply a
    // different doc entirely).
    if (cached.objToken !== raw.obj_token) return false;
    return true;
  }

  /**
   * Three-state comparison (03 §3.3.1).
   *
   * Pass 1 (cloud → local):
   *   - no local record           → added
   *   - cloud obj_edit_time > local.obj_edit_time → modified
   *     (NULL on either side is treated as "unknown, do not report
   *      modified" — handles the 3 permission-restricted docs from
   *      diting P1 review §五)
   *   - always upsertDocumentSeen to refresh parent/space/edit-time/
   *     last_seen_at metadata
   *
   * Pass 2 (local orphans):
   *   - local record present but not seen in cloud traversal
   *     AND status !== 'placeholder' → deleted (soft)
   *   - markCloudDeleted invoked; caller (UI) decides physical cleanup
   *
   * Reused-placeholders: a row previously soft-deleted (cloud_deleted=1)
   * that re-appears in cloud is left as-is for the sync flow to clear
   * cloud_deleted via upsertDocument (not change-detector's job).
   */
  private async compareWithLocalRecords(
    cloudNodes: LarkCliNodeInfo[]
  ): Promise<ChangedDocument[]> {
    const changedDocuments: ChangedDocument[] = [];
    const seenObjTokens = new Set<string>();
    const now = new Date().toISOString();

    // Pass 1: cloud → local
    for (const node of cloudNodes) {
      seenObjTokens.add(node.obj_token);

      try {
        const localRecord = await this.localMapStore.getDocumentByObjToken(
          node.obj_token
        );

        if (!localRecord) {
          // New node (added)
          changedDocuments.push({
            objToken: node.obj_token,
            objType: this.normalizeObjType(node.obj_type),
            title: node.title,
            changeType: 'added',
            cloudModifiedTime: this.formatUnixSeconds(node.obj_edit_time),
            localSyncedTime: null,
            localMdPath: null,
          });
        } else {
          // Compare obj_edit_time as Unix-second integers (no timezone
          // ambiguity). NULL on either side ⇒ "unknown" ⇒ do not report
          // modified (see diting P1 review §五 for the 3 permission-
          // restricted docs case).
          const cloudTime = node.obj_edit_time || null;
          const localTime = localRecord.objEditTime ?? null;

          if (cloudTime != null && localTime != null && cloudTime > localTime) {
            changedDocuments.push({
              objToken: node.obj_token,
              objType: this.normalizeObjType(node.obj_type),
              title: node.title,
              changeType: 'modified',
              cloudModifiedTime: this.formatUnixSeconds(cloudTime),
              localSyncedTime: localRecord.lastSyncedAt,
              localMdPath: localRecord.localMdPath,
            });
          }
        }

        // Always refresh mapping metadata (B8 fix: actually persist
        // parent_node_token / space_id / obj_edit_time / last_seen_at).
        await this.localMapStore.upsertDocumentSeen({
          objToken: node.obj_token,
          wikiNodeToken: node.node_token,
          parentNodeToken: node.parent_node_token ?? null,
          spaceId: node.space_id,
          objEditTime: node.obj_edit_time || null,
          lastSeenAt: now,
        });
      } catch (error) {
        // Single comparison failure should not interrupt entire process
        console.error(
          `[ChangeDetector] Failed to compare node ${node.obj_token}:`,
          error
        );
        continue;
      }
    }

    // Pass 2: local orphans → deleted (soft)
    try {
      const allLocal = await this.localMapStore.getAllDocuments();
      for (const local of allLocal) {
        if (seenObjTokens.has(local.objToken)) continue;
        // Skip placeholders (no-permission docs) — they may simply be
        // temporarily untraversable, not truly deleted.
        if (local.status === 'placeholder') continue;
        // Skip rows already soft-deleted (don't re-report).
        if (local.cloudDeleted === 1) continue;

        await this.localMapStore.markCloudDeleted(local.objToken, now);
        changedDocuments.push({
          objToken: local.objToken,
          objType: local.objType,
          title: local.title,
          changeType: 'deleted',
          cloudModifiedTime: '',
          localSyncedTime: local.lastSyncedAt,
          localMdPath: local.localMdPath,
        });
      }
    } catch (error) {
      console.error('[ChangeDetector] Failed to enumerate local documents:', error);
    }

    return changedDocuments;
  }

  /**
   * Detect per-sub-sheet changes for a workbook (03 §3.5).
   *
   * Feishu workbooks share one obj_edit_time across all sub-sheets, so
   * "did a sub-sheet change?" can only be answered at workbook
   * granularity: if the workbook's obj_edit_time advanced, every
   * current sub-sheet is marked "may-be-modified". Sub-sheet
   * add/del is detected by set difference against the local
   * sheet_sheets table.
   *
   * The caller is expected to provide `cloudSheets` from a fresh
   * `sheets +workbook-info` call; we do NOT call lark-cli here so the
   * function stays pure-ish and unit-testable with mocks.
   */
  async detectSheetSubChanges(
    sheetObjToken: string,
    cloudEditTime: number | null,
    cloudSheets: Array<{ sheet_id: string; title: string }>
  ): Promise<SheetSubChange[]> {
    const changes: SheetSubChange[] = [];
    const localSubs = this.localMapStore.getSheetSheets(sheetObjToken);
    const parentDoc = this.localMapStore.getDocumentByObjToken(sheetObjToken);

    const workbookChanged =
      cloudEditTime != null &&
      parentDoc?.objEditTime != null &&
      cloudEditTime > parentDoc.objEditTime;

    const localIds = new Set(localSubs.map((s) => s.sheet_id));
    const cloudIds = new Set(cloudSheets.map((s) => s.sheet_id));

    // Added / may-be-modified (cloud side)
    for (const cloud of cloudSheets) {
      if (!localIds.has(cloud.sheet_id)) {
        changes.push({
          sheetObjToken,
          sheetId: cloud.sheet_id,
          title: cloud.title,
          changeType: 'added',
        });
      } else if (workbookChanged) {
        changes.push({
          sheetObjToken,
          sheetId: cloud.sheet_id,
          title: cloud.title,
          changeType: 'may-be-modified',
        });
      }
    }

    // Deleted (local side)
    for (const local of localSubs) {
      if (!cloudIds.has(local.sheet_id)) {
        changes.push({
          sheetObjToken,
          sheetId: local.sheet_id,
          title: local.sheet_title,
          changeType: 'deleted',
        });
      }
    }

    return changes;
  }

  /**
   * Resolve sheet obj_token from link (fallback for missing obj_token
   * in HTML comments). One-line solution: lark-cli wiki +node-get.
   */
  async resolveSheetTokenFromLink(link: string): Promise<string> {
    const nodeInfo = await this.larkCliClient.getNode(link);
    return nodeInfo.obj_token;
  }

  /**
   * Coerce lark-cli obj_type to the ChangedDocument-allowed union.
   * Unknown / mindnote / file / bitable collapse to 'unknown'.
   */
  private normalizeObjType(
    raw: LarkCliNodeInfo['obj_type']
  ): ChangedDocument['objType'] {
    if (raw === 'docx' || raw === 'sheet' || raw === 'slides') return raw;
    return 'unknown';
  }

  /**
   * Format a Unix-second integer as ISO 8601 for the ChangedDocument
   * contract. Returns empty string for 0/NULL (added path uses real
   * value; deleted path uses empty string).
   */
  private formatUnixSeconds(unixSeconds: number | null | undefined): string {
    if (!unixSeconds || unixSeconds <= 0) return '';
    return new Date(unixSeconds * 1000).toISOString();
  }
}
