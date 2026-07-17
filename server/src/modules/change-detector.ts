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
 * v0.2.0 detect-traverse-fix (2026-06-22):
 *   - Pass rootToken into compareWithLocalRecords; Pass 2 now restricts
 *     deleted detection to rows whose wiki_node_token or parent_node_token
 *     is in the current traversal. Without this, multi-watchedRoot detect
 *     runs marked every out-of-subtree row as cloud_deleted=1 (baize
 *     structure-align-survey §6.2 问题 B; reproducible: detect 技术-Dev
 *     wiped all 策划-Designer rows).
 *   - Pass 1 added nodes now also call upsertDocumentSeen so the node is
 *     persisted as a placeholder row. Previously added nodes stayed out
 *     of the documents table, so the next detect re-reported them and
 *     the UI never saw them (baize §4.1: 技术-Dev 6 子节点 0 入库).
 *   - upsertDocumentSeen now clears cloud_deleted=0 on conflict so a
 *     node that reappears in cloud (after being wrongly flagged) is
 *     automatically restored.
 *
 * The obj_edit_time fetching uses a fingerprint short-circuit (03 §3.3.2
 * 情况 B): if a node's (title + obj_token) signature is unchanged AND
 * the local row already has a non-null obj_edit_time, we reuse the
 * cached value. has_child is NOT part of the fingerprint because the
 * documents table does not persist it (03 §3.1 declares has_child too
 * volatile to be worth storing); title+obj_token equality is sufficient
 * since a renamed doc keeps its obj_token (triggering a refresh, which
 * is correct) and a different obj_token means a different doc entirely.
 *
 * v0.2.0 change-detection-ttl (diagnosis §2.2 根因 A): the original
 * short-circuit reused the local obj_edit_time indefinitely, so content-
 * only edits (title unchanged) silently leaked — cloudTime > localTime
 * was always false because cloudTime WAS the stale local value. The
 * short-circuit is now bounded by OBJ_EDIT_TIME_REFRESH_TTL_MS: even on
 * a fingerprint hit we re-fetch the real cloud obj_edit_time via
 * wiki +node-get once per TTL window (in-memory tracker, see
 * lastObjEditTimeRefreshAt). Worst-case extra requests are now bounded
 * by "nodes that changed identity OR fingerprint-hit nodes whose TTL
 * expired" — on steady state that is roughly nodesCount / (TTL/pollInterval)
 * node-get calls per poll, which is a fraction of the full subtree.
 */

import type { LarkCliClient } from './lark-cli-client.js';
import type { LocalMapStore } from './local-map-store.js';
import type {
  ChangeDetectionResult,
  ChangedDocument,
  CloudNodeObservation,
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

interface TraversalResult {
  nodes: CloudNodeObservation[];
  complete: boolean;
  failedNodeTokens: string[];
}

interface RawTraversalResult {
  nodes: RawListNode[];
  complete: boolean;
  failedNodeTokens: string[];
}

interface NodeDetailLookup {
  node: LarkCliNodeInfo | null;
  observationStatus: CloudNodeObservation['observationStatus'];
}

interface ComparisonOptions {
  rootToken: string;
  watchedRootUrl?: string | null;
  traversalComplete?: boolean;
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

/**
 * Detect-result cache TTL. See ChangeDetector.detectResultCache docs for
 * the rationale.
 *
 * 120 seconds is the sweet spot:
 *   - Long enough to cover the post-detect UI burst. A 4-root detect-all
 *     takes 40-45s end-to-end (root 1 ~10s, root 2 ~29s, roots 3-4 ~1s
 *     each), so by the time detect-all RETURNS the root-1 cache entry is
 *     already ~40s old. The useSyncStatus hook then fires 4 diff calls
 *     within ~1s of detect-all returning; ChangeListPanel fires one more
 *     a few ms later. All five must hit the cache, which requires TTL >>
 *     the detect duration. 120s gives 80s of headroom.
 *   - Short enough that a manual re-detect click 2+ minutes later still
 *     re-hits the cloud (the user expects fresh results after consciously
 *     waiting and clicking detect again). The detect routes pass
 *     `forceFresh=true` to bypass the cache regardless, so even a click
 *     immediately after always re-traverses.
 */
const DTECT_RESULT_TTL_MS = 120_000;

/**
 * Per-root detect cooldown for the `forceFresh=true` path. See
 * ChangeDetector.detectChanges docs: a second detect invocation on the
 * same rootUrl within this window returns the cached result instead of
 * re-hitting lark-cli, fixing §问题2 ("第二次检测失败"). 60s matches
 * the typical lark-cli QPS recovery window observed on this account.
 */
const DETECT_COOLDOWN_MS = 60_000;

/**
 * TTL for the fingerprint short-circuit's reuse of the cached
 * obj_edit_time (diagnosis §2.2 根因 A fix).
 *
 * The short-circuit previously reused the local obj_edit_time
 * indefinitely whenever (title, obj_token) matched, so content-only
 * edits (title unchanged) silently leaked: cloudTime > localTime was
 * always false because cloudTime was the stale local value. Now even on
 * a fingerprint hit we periodically re-fetch the real cloud obj_edit_time
 * via wiki +node-get once per TTL window.
 *
 * Default 1h balances detection latency against the per-poll wiki QPS
 * budget: with a 30-min poll interval, the worst-case staleness is 1h
 * (2 polls) before a content-only edit is surfaced. Process restart
 * empties the in-memory tracker, so the first detect after boot treats
 * every fingerprint-hit node as TTL-expired and re-fetches once (bounded
 * burst), then steady state resumes. See ChangeDetector.lastObjEditTimeRefreshAt.
 */
const OBJ_EDIT_TIME_REFRESH_TTL_MS = 60 * 60 * 1000;

export class ChangeDetector {
  // space_id cache: rootUrl -> space_id (avoid repeated getNode calls)
  private spaceIdCache = new Map<string, string>();
  /**
   * Short-lived detect-result cache (rootUrl -> { result, expiresAt }).
   *
   * Rationale: in v0.2.0 the UI fires several concurrent detect-derived
   * calls right after the user clicks 立即检测:
   *   - GlobalStatusBar's useSyncStatus pulls GET /api/mapping/diff for
   *     every watchedRoot (4 calls)
   *   - ChangeListPanel's first-load effect pulls GET /api/mapping/diff
   *     for the active root (1 call)
   *   - The polling scheduler may also kick off a detect in the same window
   *
   * Each `/api/mapping/diff` invocation delegates to `computeDiff`, which
   * calls `detectChanges` and therefore traverses the cloud subtree via
   * lark-cli. Even though lark-cli-client.ts throttles per-request QPS
   * (architecture red line I1, untouched here), a tight burst of 5 detect
   * calls against the same root pushes the aggregate lark-cli rate over
   * the upstream limit and the user gets HTTP 500 'QPS 限流' responses
   * from the diff endpoint — which then surfaces as an empty change list
   * while the status bar (previously hard-coded to 3) showed a stale
   * number. That mismatch is the root cause of v0.2.0
   * sync-state-timeout-fix §问题1.
   *
   * This cache deduplicates detect calls that happen within
   * `DETECT_RESULT_TTL_MS` of each other for the SAME rootUrl. The TTL is
   * intentionally short (120s): long enough to collapse the post-click
   * burst, short enough that a real second detect (manual refresh 3min
   * later) still re-hits the cloud. Callers can pass `forceFresh=true` to
   * bypass (used by the explicit "立即检测" button so the user always
   * sees fresh results when they consciously click detect).
   */
  private detectResultCache = new Map<
    string,
    { result: ChangeDetectionResult; expiresAt: number }
  >();

  /**
   * In-memory TTL tracker for the fingerprint short-circuit (diagnosis
   * §2.2 根因 A fix). Maps obj_token → epoch ms of the last wiki +node-get
   * we issued to refresh its obj_edit_time. Used together with
   * OBJ_EDIT_TIME_REFRESH_TTL_MS so that even when a node's title hasn't
   * changed, we periodically re-check the real cloud obj_edit_time
   * instead of reusing the local cached value indefinitely.
   *
   * Process-restart semantics: empty on boot ⇒ the first detect treats
   * every fingerprint-hit node as TTL-expired and re-fetches once
   * (bounded burst = node count of the subtree), then steady state
   * resumes. Persistence would require a documents-table schema migration
   * (last_obj_edit_time_refresh_at column); the in-memory approach is
   * chosen because restarts are rare and the cost is a one-off QPS spike
   * that is fully absorbed by the existing lark-cli throttle. See impl
   * report §3 for the full trade-off analysis.
   */
  private lastObjEditTimeRefreshAt = new Map<string, number>();

  constructor(
    private larkCliClient: LarkCliClient,
    private localMapStore: LocalMapStore
  ) {}

  /**
   * Main entry point: detect changes in a wiki subtree.
   *
   * `forceFresh=true` skips the short-lived result cache. The cache exists
   * to collapse concurrent detect-derived calls (mapping/diff fan-out +
   * ChangeListPanel + polling) into a single cloud traversal, preventing
   * lark-cli QPS 限流 (reported in sync-state-timeout-fix §问题1).
   *
   * Even with `forceFresh=true`, the detector enforces a per-root cooldown
   * (DETECT_COOLDOWN_MS): a second detect invocation on the SAME rootUrl
   * inside the cooldown window returns the last result instead of hitting
   * lark-cli again. This is the root-cause fix for §问题2 ("第二次检测失败"):
   * the user clicks 立即检测 twice in quick succession (or the polling
   * scheduler fires right after a manual click), and the second detect
   * pushes lark-cli past its QPS budget, returning 500 'QPS 限流' for
   * every root. The cooldown deduplicates the second click to a cached
   * response so the user sees consistent success.
   *
   * Callers that need to force an unconditional re-traverse (e.g. tests)
   * can pass `bypassCooldown: true`; production code paths should NOT use
   * this flag, since bypassing the cooldown reintroduces the QPS race.
   *
   * @visibleForTesting `bypassCooldown` is intended exclusively for unit
   * tests; production callers must omit it.
   */
  async detectChanges(
    rootUrl: string,
    options: { forceFresh?: boolean; bypassCooldown?: boolean } = {}
  ): Promise<ChangeDetectionResult> {
    const forceFresh = options.forceFresh === true;
    const bypassCooldown = options.bypassCooldown === true;
    if (!forceFresh) {
      const cached = this.detectResultCache.get(rootUrl);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }
    } else if (!bypassCooldown) {
      // forceFresh path: still respect the cooldown. If a detect on this
      // root completed less than DETECT_COOLDOWN_MS ago, return the last
      // result instead of re-traversing. This is the §问题2 fix.
      const cached = this.detectResultCache.get(rootUrl);
      if (cached) {
        const sinceCompleted = Date.now() - (cached.expiresAt - DTECT_RESULT_TTL_MS);
        if (sinceCompleted < DETECT_COOLDOWN_MS) {
          return cached.result;
        }
      }
    }
    const result = await this.detectChangesUncached(rootUrl);
    this.detectResultCache.set(rootUrl, {
      result,
      expiresAt: Date.now() + DTECT_RESULT_TTL_MS,
    });
    return result;
  }

  /**
   * Uncached detect implementation. Split out so `detectChanges` can wrap
   * it with the short-lived result cache without changing the original
   * traversal/comparison logic.
   */
  private async detectChangesUncached(rootUrl: string): Promise<ChangeDetectionResult> {
    // 1. Get root node info (space_id + root_token + obj_edit_time)
    const rootInfo = await this.larkCliClient.getNode(rootUrl);
    const spaceId = rootInfo.space_id;
    const rootToken = rootInfo.node_token;

    // Cache space_id for future calls
    this.spaceIdCache.set(rootUrl, spaceId);

    // 2. Traverse entire subtree and collect all nodes (with real
    // obj_edit_time plus an explicit completeness signal). A partial tree is
    // still useful for observational/pending updates, but it is never safe
    // evidence for a deletion candidate.
    const traversal = await this.traverseWikiSubtree(spaceId, rootToken, rootUrl);
    const cloudNodes = traversal.nodes;

    // 2a. Include the root node itself in the comparison set. The traversal
    // function only returns DESCENDANTS (BFS over children of rootToken);
    // the root row was being flagged as deleted on every detect because it
    // never appeared in seenObjTokens. Root is part of the subtree, so we
    // prepend it to cloudNodes here (deduped via the seen-set in Pass 1).
    cloudNodes.unshift({
      wikiNodeToken: rootInfo.node_token,
      objToken: rootInfo.obj_token,
      objType: this.normalizeObjType(rootInfo.obj_type),
      title: rootInfo.title,
      spaceId: rootInfo.space_id ?? null,
      observedObjEditTime: rootInfo.obj_edit_time ?? null,
      hasChild: rootInfo.has_child,
      parentNodeToken: rootInfo.parent_node_token ?? null,
      watchedRootId: rootToken,
      watchedRootUrl: rootUrl,
      observationStatus: 'available',
    });

    // 3. Compare with local SQLite records (three-state)
    // Pass rootToken so Pass 2 (deleted detection) only considers rows that
    // belong to THIS subtree — without it, detecting rootA would mark every
    // rootB row as deleted (multi-watchedRoot scenario, see baize
    // structure-align-survey and detect-traverse-fix report).
    const changedDocuments = await this.compareWithLocalRecords(cloudNodes, {
      rootToken,
      watchedRootUrl: rootUrl,
      traversalComplete: traversal.complete,
    });

    const missingCandidates = this.localMapStore.listMissingCandidates
      ? this.localMapStore.listMissingCandidates().filter(
          (record: DocumentRecord) => record.watchedRootId === rootToken,
        ).length
      : 0;

    return {
      changed: changedDocuments.length > 0,
      changedDocuments,
      checkedAt: new Date().toISOString(),
      totalNodes: cloudNodes.length,
      traversalComplete: traversal.complete,
      failedNodeTokens: traversal.failedNodeTokens,
      missingCandidates,
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
   * Fingerprint short-circuit with TTL: if the local row already has a
   * non-null obj_edit_time AND (title, obj_token) are unchanged AND the
   * TTL window has not expired (see OBJ_EDIT_TIME_REFRESH_TTL_MS), we
   * trust the cached value and skip the node-get. The TTL bound is the
   * v0.2.0 change-detection-ttl fix (diagnosis §2.2 根因 A): without it,
   * content-only edits with unchanged title were silently missed. Outside
   * the TTL window we re-fetch even on a fingerprint hit, trading one
   * node-get per node per TTL window for correct modification detection.
   */
  private async traverseWikiSubtree(
    spaceId: string,
    rootToken: string,
    watchedRootUrl: string,
  ): Promise<TraversalResult> {
    const rawTraversal = await this.bfsCollectRawNodes(spaceId, rootToken);
    const enriched: CloudNodeObservation[] = [];

    for (const raw of rawTraversal.nodes) {
      const cached = this.localMapStore.getDocumentByObjToken(raw.obj_token);
      const fingerprintUnchanged = this.isFingerprintUnchanged(raw, cached);

      let objEditTime: number | null;
      let parentNodeToken = raw.parent_node_token ?? null;
      let observationStatus: CloudNodeObservation['observationStatus'] = 'available';

      // TTL guard for the fingerprint short-circuit (diagnosis §2.2 根因 A
      // fix). The original short-circuit reused the local obj_edit_time
      // indefinitely on a fingerprint hit, so content-only edits (title
      // unchanged) were silently missed. Now a fingerprint hit is only
      // honored when the cached obj_edit_time was refreshed within the
      // last OBJ_EDIT_TIME_REFRESH_TTL_MS; otherwise we re-fetch via
      // wiki +node-get. The tracker is in-memory (lastObjEditTimeRefreshAt),
      // so a process restart loses the map and the first detect becomes a
      // full refresh — see OBJ_EDIT_TIME_REFRESH_TTL_MS doc.
      const now = Date.now();
      const lastRefresh = this.lastObjEditTimeRefreshAt.get(raw.obj_token) ?? 0;
      const ttlExpired = now - lastRefresh > OBJ_EDIT_TIME_REFRESH_TTL_MS;

      if (fingerprintUnchanged && cached?.objEditTime != null && !ttlExpired) {
        // Fingerprint hit AND TTL fresh: reuse cached obj_edit_time, skip node-get.
        objEditTime = cached.objEditTime;
      } else {
        // Fingerprint miss OR TTL expired OR no cache: fetch fresh obj_edit_time.
        const detail = await this.fetchNodeDetail(spaceId, raw.node_token, watchedRootUrl);
        // Record the refresh attempt regardless of success. A failed
        // node-get (permission/timeout → null) must not become an infinite
        // retry on every poll: the next TTL window will retry naturally,
        // and meanwhile compareWithLocalRecords safely treats null as
        // "unknown" (no modified report).
        this.lastObjEditTimeRefreshAt.set(raw.obj_token, now);
        if (detail.node) {
          objEditTime = detail.node.obj_edit_time;
          // Prefer freshly-fetched parent_node_token (more authoritative
          // than +node-list, in case of recent moves) when present.
          if (detail.node.parent_node_token) {
            parentNodeToken = detail.node.parent_node_token;
          }
        } else {
          // node-get failed (permission/timeout): treat obj_edit_time as
          // unknown (NULL). compareWithLocalRecords handles NULL safely
          // (does not report modified).
          objEditTime = null;
          observationStatus = detail.observationStatus;
        }
      }

      enriched.push({
        wikiNodeToken: raw.node_token,
        objToken: raw.obj_token,
        objType: this.normalizeObjType(raw.obj_type),
        title: raw.title,
        spaceId: raw.space_id ?? spaceId,
        observedObjEditTime: objEditTime,
        hasChild: raw.has_child,
        parentNodeToken,
        watchedRootId: rootToken,
        watchedRootUrl,
        observationStatus,
      });
    }

    return {
      nodes: enriched,
      complete: rawTraversal.complete,
      failedNodeTokens: rawTraversal.failedNodeTokens,
    };
  }

  /**
   * BFS traversal using `wiki +node-list`. Returns the raw node set
   * WITHOUT obj_edit_time (situation B), plus a completeness signal. A
   * failed level is still logged/skipped so users can see fresh data from
   * healthy branches, but the caller must treat the result as unsafe for
   * deletion inference.
   */
  private async bfsCollectRawNodes(
    spaceId: string,
    rootToken: string
  ): Promise<RawTraversalResult> {
    const all: RawListNode[] = [];
    const failedNodeTokens: string[] = [];
    let complete = true;
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
        // Single level failure should not interrupt the observational pass,
        // but must be carried all the way to compareWithLocalRecords so it
        // cannot produce an absence/deletion conclusion.
        complete = false;
        failedNodeTokens.push(currentToken);
        console.error(
          `[ChangeDetector] Failed to list nodes for token ${currentToken}:`,
          error
        );
        continue;
      }
    }

    return { nodes: all, complete, failedNodeTokens };
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
    nodeToken: string,
    watchedRootUrl: string,
  ): Promise<NodeDetailLookup> {
    // The root URL is the only trustworthy source of the tenant host. Do not
    // hard-code a deployment-specific feishu domain: a second tenant/root
    // would otherwise silently query the wrong workspace.
    let nodeReference = nodeToken;
    try {
      const root = new URL(watchedRootUrl);
      nodeReference = `${root.origin}/wiki/${nodeToken}`;
    } catch {
      // getNode also accepts a raw token. It is a safer fallback than
      // inventing a host when a caller supplied malformed configuration.
      nodeReference = nodeToken;
    }
    void spaceId; // kept in the signature for callers/cache diagnostics.

    try {
      return {
        node: await this.larkCliClient.getNode(nodeReference),
        observationStatus: 'available',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[ChangeDetector] node-get failed for ${nodeToken}, treating obj_edit_time as NULL:`,
        error
      );
      return {
        node: null,
        observationStatus: this.isPermissionError(message) ? 'restricted' : 'unavailable',
      };
    }
  }

  private isPermissionError(message: string): boolean {
    return /(?:40403|131006|无权限|permission|forbidden|access denied)/i.test(message);
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
   * Compare a traversal with the local baseline without conflating observed
   * and synced time. The legacy LarkCliNodeInfo input remains accepted for
   * unit/API compatibility; production traversal passes CloudNodeObservation.
   */
  private async compareWithLocalRecords(
    cloudNodes: Array<CloudNodeObservation | LarkCliNodeInfo>,
    rootOrOptions: string | ComparisonOptions,
  ): Promise<ChangedDocument[]> {
    const options: ComparisonOptions = typeof rootOrOptions === 'string'
      ? { rootToken: rootOrOptions, traversalComplete: true }
      : rootOrOptions;
    const traversalComplete = options.traversalComplete !== false;
    const rootToken = options.rootToken;
    const changedDocuments: ChangedDocument[] = [];
    const seenObjTokens = new Set<string>();
    const traversedNodeTokens = new Set<string>([rootToken]);
    const now = new Date().toISOString();

    const observations = cloudNodes.map((node): CloudNodeObservation => {
      if ('objToken' in node) return node;
      return {
        objToken: node.obj_token,
        wikiNodeToken: node.node_token,
        objType: this.normalizeObjType(node.obj_type),
        title: node.title,
        spaceId: node.space_id ?? null,
        parentNodeToken: node.parent_node_token ?? null,
        watchedRootId: rootToken,
        watchedRootUrl: options.watchedRootUrl ?? null,
        observedObjEditTime: node.obj_edit_time ?? null,
        hasChild: node.has_child,
        observationStatus: node.obj_edit_time == null ? 'unavailable' : 'available',
      };
    });

    // Pass 1: cloud observation -> persistent state machine. This is the
    // only code path that updates observed time; it never writes the synced
    // baseline, so pending additions/modifications remain visible on every
    // subsequent poll until the P3 file/DB commit succeeds.
    for (const observation of observations) {
      seenObjTokens.add(observation.objToken);
      if (observation.wikiNodeToken) traversedNodeTokens.add(observation.wikiNodeToken);
      if (observation.parentNodeToken) traversedNodeTokens.add(observation.parentNodeToken);

      try {
        const record = this.localMapStore.recordCloudObservation({
          ...observation,
          watchedRootId: observation.watchedRootId || rootToken,
          watchedRootUrl: observation.watchedRootUrl ?? options.watchedRootUrl ?? null,
          lastSeenAt: now,
        }) as DocumentRecord;

        if (record.syncState === 'pending_added') {
          changedDocuments.push(this.toChangedDocument(observation, record, 'added'));
        } else if (record.syncState === 'pending_modified') {
          changedDocuments.push(this.toChangedDocument(observation, record, 'modified'));
        }
        // restricted rows remain visible in the mapping/tree projection with
        // their title and hierarchy, but are intentionally not batch-syncable
        // until P4 exposes an explicit restricted-state UI.
      } catch (error) {
        console.error(
          `[ChangeDetector] Failed to record observation for ${observation.objToken}:`,
          error,
        );
      }
    }

    // An incomplete traversal never enters the absence pass. The resulting
    // observations are useful, but a single rate-limited BFS page must not be
    // interpreted as cloud deletion for any local document.
    if (!traversalComplete) {
      return changedDocuments;
    }

    try {
      const allLocal = this.localMapStore.getAllDocuments() as DocumentRecord[];
      for (const local of allLocal) {
        if (seenObjTokens.has(local.objToken)) continue;
        const state = local.syncState ?? this.legacyStateFromDocument(local);
        if (
          state === 'pending_added' ||
          state === 'restricted' ||
          state === 'deleted_confirmed' ||
          local.cloudDeleted === 1
        ) {
          continue;
        }

        // v5 rows own a stable root identity. For legacy records without it,
        // retain the conservative v4 subtree-membership fallback.
        const belongsToRoot = local.watchedRootId
          ? local.watchedRootId === rootToken
          : (
            (local.wikiNodeToken != null && traversedNodeTokens.has(local.wikiNodeToken)) ||
            (local.parentNodeToken != null && local.parentNodeToken !== '' && traversedNodeTokens.has(local.parentNodeToken))
          );
        if (!belongsToRoot) continue;

        this.localMapStore.recordCompleteTraversalMiss(local.objToken, now);
      }
    } catch (error) {
      console.error('[ChangeDetector] Failed to evaluate traversal absences:', error);
    }

    return changedDocuments;
  }

  private toChangedDocument(
    observation: CloudNodeObservation,
    record: DocumentRecord,
    changeType: ChangedDocument['changeType'],
  ): ChangedDocument {
    return {
      objToken: observation.objToken,
      objType: observation.objType,
      title: observation.title,
      changeType,
      cloudModifiedTime: this.formatUnixSeconds(observation.observedObjEditTime),
      localSyncedTime: record.lastSyncedAt || null,
      localMdPath: record.localMdPath || null,
      wikiNodeToken: observation.wikiNodeToken,
      parentNodeToken: observation.parentNodeToken,
      spaceId: observation.spaceId,
      watchedRootId: observation.watchedRootId,
      hasChild: observation.hasChild,
      observedObjEditTime: observation.observedObjEditTime,
      syncState: record.syncState,
    };
  }

  private legacyStateFromDocument(document: DocumentRecord): NonNullable<DocumentRecord['syncState']> {
    if (document.cloudDeleted === 1) return 'missing_candidate';
    if (document.status === 'error') return 'error';
    if (document.status === 'placeholder') {
      return document.cloudMatch === 'restricted' ? 'restricted' : 'pending_added';
    }
    if (document.status === 'changed') return 'pending_modified';
    return 'synced';
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
      parentDoc?.syncedObjEditTime != null &&
      cloudEditTime > parentDoc.syncedObjEditTime;

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
