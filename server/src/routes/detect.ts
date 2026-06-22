/**
 * Detect Routes - Change detection endpoints
 *
 * POST /api/detect/changes      - Detect changes in ONE wiki subtree
 * POST /api/detect/changes-all  - Detect changes across ALL configured watchedRoots
 *
 * M1 Implementation: Integrated with ChangeDetector + LarkCliClient
 *
 * v0.2.0 fix: validate rootUrl at the edge. Previously, when callers
 * sent { rootUrls: [] } (plural) or omitted the field, rootUrl was
 * undefined and was passed unchanged through ChangeDetector →
 * LarkCliClient.getNode(undefined) → lark-cli `--node-token undefined
 * --format json`, which Node execFile(shell:true) collapses into a
 * command line that lark-cli 1.0.53 parses as a positional argument
 * "json", producing:
 *   Error: positional arguments are not supported (got ["json"])
 * This route now rejects missing/invalid rootUrl at the boundary so
 * the contract violation fails fast with an actionable error instead
 * of leaking into a misleading lark-cli invocation.
 *
 * v0.2.0 multi-root-detect (2026-06-22):
 *   New POST /api/detect/changes-all traverses every URL in
 *   config.watchedRootUrls sequentially. detect-traverse-fix already
 *   guarantees per-subtree filtering (compareWithLocalRecords Pass 2
 *   restricts deleted detection to rows whose wiki_node_token or
 *   parent_node_token is in the CURRENT traversal), so detecting
 *   watchedRoot A no longer marks watchedRoot B rows as cloud_deleted.
 *   Sequential (not parallel) to respect lark-cli QPS and keep the
 *   standalone server's stdout log readable. Per-root failures are
 *   captured into results[] without aborting the whole batch.
 */

import { Hono } from 'hono';
import type { ChangeDetector } from '../modules/change-detector.js';
import type { ConfigManager } from '../modules/config-manager.js';
import type {
  ChangeDetectionResult,
  ChangedDocument,
} from '../types/index.js';

const detectRoutes = new Hono();

/**
 * POST /api/detect/changes - Detect changed documents
 *
 * Request body: { rootUrl: string }  — singular Feishu wiki URL
 * Response: ChangeDetectionResult
 */
detectRoutes.post('/api/detect/changes', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rootUrl = typeof body?.rootUrl === 'string' ? body.rootUrl.trim() : '';

  if (!rootUrl) {
    return c.json(
      {
        error: 'missing_rootUrl',
        message:
          'Request body must include { rootUrl: "<feishu wiki url>" }. Received empty/undefined rootUrl.',
      },
      400
    );
  }

  // Minimal structural check: lark-cli +node-get requires a URL or token
  // we can resolve. Empty/garbage strings leak into lark-cli and surface
  // as cryptic errors; reject early with a precise message.
  const looksLikeFeishuWikiUrl = /^https:\/\/[a-z0-9-]+\.feishu\.cn\/wiki\/[A-Za-z0-9]+/i.test(
    rootUrl
  );
  const looksLikeRawToken = /^[A-Za-z0-9]{20,}$/.test(rootUrl);
  if (!looksLikeFeishuWikiUrl && !looksLikeRawToken) {
    return c.json(
      {
        error: 'invalid_rootUrl',
        message:
          'rootUrl must be a Feishu wiki URL (https://<host>/wiki/<token>) or a raw node/obj token.',
      },
      400
    );
  }

  // Get ChangeDetector instance from app context (set by index.ts)
  const changeDetector = (c as any).changeDetector as ChangeDetector;

  if (!changeDetector) {
    return c.json({ error: 'ChangeDetector not initialized' }, 500);
  }

  try {
    const result = await changeDetector.detectChanges(rootUrl);
    return c.json(result);
  } catch (error) {
    console.error('[DetectRoutes] Change detection failed:', error);
    return c.json(
      {
        error: 'Change detection failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

/**
 * Multi-root result envelope.
 *
 * `results[]` preserves the configured watchedRootUrls order so the UI
 * can map outcomes back to display groups. Each entry carries either a
 * `result` (success) or an `error` message (failure); both shapes are
 * explicit so the client can render partial-failure states without
 * second-guessing missing fields.
 */
interface RootResult {
  rootUrl: string;
  status: 'ok' | 'error';
  result?: ChangeDetectionResult;
  error?: string;
}

interface MultiRootDetectionResult {
  changed: boolean;
  totalNodes: number;
  changedDocuments: ChangedDocument[];
  checkedAt: string;
  results: RootResult[];
}

/**
 * POST /api/detect/changes-all - Detect changes across ALL configured watchedRoots.
 *
 * Reads `watchedRootUrls` from ConfigManager and runs detectChanges
 * sequentially for each URL. Sequential ordering is deliberate:
 *
 *   1. lark-cli has a QPS budget (architecture red line I1 delegates
 *      throttling to lark-cli-client.ts); serial calls keep the
 *      aggregate request shape within the per-node QPS envelope.
 *   2. compareWithLocalRecords's Pass 2 already filters by traversed
 *      subtree tokens, so running root A then root B is equivalent to
 *      running them in parallel from a correctness standpoint.
 *   3. Sequential stdout logs are far easier to attribute to a specific
 *      rootUrl when diagnosing partial failures.
 *
 * Per-root failures (lark-cli errors, permission revoked on a single
 * root, etc.) are captured into `results[i].status='error'` WITHOUT
 * aborting the batch, so a single broken root does not prevent the
 * other three from refreshing.
 *
 * Aggregation rule: `changed=true` if ANY root reported changes;
 * `changedDocuments` is the concatenation in configured order;
 * `totalNodes` is the sum across successful roots.
 *
 * Request body: ignored (config-driven). An empty `{}` is fine.
 */
detectRoutes.post('/api/detect/changes-all', async (c) => {
  const changeDetector = (c as any).changeDetector as ChangeDetector | undefined;
  const configManager = (c as any).configManager as ConfigManager | undefined;

  if (!changeDetector) {
    return c.json({ error: 'ChangeDetector not initialized' }, 500);
  }
  if (!configManager) {
    return c.json({ error: 'ConfigManager not initialized' }, 500);
  }

  const config = configManager.getConfig();
  const watchedRootUrls: string[] = config?.watchedRootUrls ?? [];
  if (watchedRootUrls.length === 0) {
    return c.json(
      {
        error: 'no_watched_roots',
        message:
          'config.watchedRootUrls is empty. Add at least one Feishu wiki URL via the config panel before calling detect-all.',
      },
      400
    );
  }

  const results: RootResult[] = [];
  const aggregatedChangedDocuments: ChangedDocument[] = [];
  let aggregatedTotalNodes = 0;

  for (const rootUrl of watchedRootUrls) {
    try {
      const result = await changeDetector.detectChanges(rootUrl);
      results.push({ rootUrl, status: 'ok', result });
      aggregatedTotalNodes += result.totalNodes ?? 0;
      if (result.changedDocuments?.length) {
        aggregatedChangedDocuments.push(...result.changedDocuments);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[DetectRoutes] detect-all: failed for ${rootUrl}:`,
        error
      );
      results.push({ rootUrl, status: 'error', error: message });
    }
  }

  const response: MultiRootDetectionResult = {
    changed: aggregatedChangedDocuments.length > 0,
    totalNodes: aggregatedTotalNodes,
    changedDocuments: aggregatedChangedDocuments,
    checkedAt: new Date().toISOString(),
    results,
  };

  return c.json(response);
});

export { detectRoutes };
