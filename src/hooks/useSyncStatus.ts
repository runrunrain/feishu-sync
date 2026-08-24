/**
 * Sync Status Hook
 *
 * Pulls the REAL pending change count from the backend so the value
 * shown in GlobalStatusBar matches the ChangeListPanel. Previously this
 * hook returned hard-coded placeholder data (`pendingCount: 3`), which
 * contradicted the genuine diff results rendered elsewhere in the UI
 * (reported in v0.2.0 sync-state-timeout-fix §问题1).
 *
 * Data source contract:
 *   GET /api/mapping/diff?rootUrl=<watchedRoot>&cached=1  (per-root)
 *   -> DiffReport { added, modified, deleted, ... }
 *
 * Multi-root aggregation: when `config.watchedRootUrls` contains more
 * than one URL (the default in v0.2.0: 4 watchedRoots), we fan out to
 * every root and sum the pending counts. Otherwise the status bar would
 * only reflect the FIRST root, and changes in other subtrees would be
 * invisible even though they exist (this was the exact mismatch the
 * user reported: "状态栏待同步3 but 变更列表为空" — the legacy hard-coded
 * 3 happened to roughly match the total, but the panel queried only the
 * first root and came back empty).
 *
 * `pendingCount` counts added + modified (NOT deleted): deleted rows go
 * to the trash bin rather than the sync queue, so showing them as "待同步"
 * would mislead the user. `ChangeListPanel` computes the same set via
 * `selectableChanges = [...added, ...modified]`, so both counters stay
 * consistent.
 *
 * Polling cadence: the hook refetches on three triggers:
 *   1. Mount (initial load).
 *   2. `watchedRootUrls` list change (config swap / URL edit).
 *   3. `refreshTick` increment (callers bump this after a manual detect
 *      or sync to force a fresh pull without a full page reload).
 *
 * `lastSyncTime` is derived from the latest (max) diff.checkedAt across
 * roots, and `nextCheckTime` is projected from `pollIntervalMinutes` in
 * the config — both are now REAL signals instead of fabricated timestamps.
 * This is a local-state reader, not a cloud detector. The status bar's
 * explicit detect action owns the real detection spinner.
 */

import { useState, useEffect, useCallback } from 'react';
import { getStoredMappingDiff } from '../api/client';
import { appLogger } from '../utils/appLogger';
import { isUsableWikiUrl } from '../utils/wikiUrl';
import { useConfig } from './useConfig';

interface SyncStatusData {
  pendingCount: number;
  lastSyncTime: number | null;
  nextCheckTime: number | null;
  isDetecting: boolean;
}

/**
 * Backward-compat option: callers (e.g. GlobalStatusBar) can omit all
 * arguments and the hook will derive rootUrl + pollIntervalMinutes from
 * useConfig itself. An explicit `refreshTick` is still accepted so views
 * that already hold a "did detect / sync just finish?" signal can force
 * a refetch without waiting for the next mount.
 */
interface UseSyncStatusOptions {
  refreshTick?: number;
}

export function useSyncStatus(options: UseSyncStatusOptions = {}): SyncStatusData {
  const { refreshTick = 0 } = options;
  const { config } = useConfig();
  const watchedRootUrls = config?.watchedRootUrls ?? [];
  const pollIntervalMinutes = config?.pollIntervalMinutes ?? 30;

  // Stable signature for the effect; joins valid URLs so adding/removing a
  // root triggers a refetch while unrelated config changes do not.
  const watchedKey = watchedRootUrls.filter(isUsableWikiUrl).join('|');

  const [status, setStatus] = useState<SyncStatusData>({
    pendingCount: 0,
    lastSyncTime: null,
    nextCheckTime: null,
    isDetecting: false,
  });

  const refresh = useCallback(async () => {
    const validUrls = watchedRootUrls.filter(isUsableWikiUrl);
    if (validUrls.length === 0) {
      setStatus({
        pendingCount: 0,
        lastSyncTime: null,
        nextCheckTime: null,
        isDetecting: false,
      });
      return;
    }
    try {
      // Dedup by objToken across roots: custom-folder (归档) docs are
      // merged into every root's stored diff server-side, so summing
      // per-root counts would multiply them by the number of watchedRoots.
      const pendingTokens = new Set<string>();
      let latestCheckedAt = '';
      for (const url of validUrls) {
        try {
          const report = await getStoredMappingDiff(url);
          for (const doc of [...report.added, ...report.modified]) {
            pendingTokens.add(doc.objToken ?? `${doc.title}:${doc.localMdPath ?? ''}`);
          }
          if (report.checkedAt && report.checkedAt > latestCheckedAt) {
            latestCheckedAt = report.checkedAt;
          }
        } catch (err) {
          // Per-root failures degrade gracefully — the status bar shows the
          // partial sum rather than blocking on a single broken root.
          // ChangeListPanel surfaces the error via toast.
          appLogger.warn('useSyncStatus', 'getStoredMappingDiff failed for root', { url, err });
        }
      }
      const lastSyncTime = latestCheckedAt
        ? new Date(latestCheckedAt).getTime()
        : null;
      const intervalMs = Math.max(1, pollIntervalMinutes) * 60 * 1000;
      const nextCheckTime = lastSyncTime ? lastSyncTime + intervalMs : null;
      setStatus({
        pendingCount: pendingTokens.size,
        lastSyncTime,
        nextCheckTime,
        isDetecting: false,
      });
    } catch (err) {
      // Surface as "no pending info" rather than fabricating a number.
      appLogger.warn('useSyncStatus', 'aggregate pending count failed', err);
      setStatus((prev) => ({
        ...prev,
        pendingCount: 0,
        isDetecting: false,
      }));
    }
  }, [watchedKey, pollIntervalMinutes]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshTick]);

  return status;
}
