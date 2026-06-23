/**
 * Hook for detecting document changes
 * M1: Full implementation with API integration
 */

import { useState, useCallback } from 'react';
import { detectChanges, detectChangesAll } from '../api/client';
import type { ChangeDetectionResult, ChangedDocument } from '../types';

interface UseChangesResult {
  changes: ChangedDocument[];
  loading: boolean;
  error: string | null;
  hasChanges: boolean;
  lastCheckedAt: string | null;
  totalNodes: number;
  detect: (rootUrl: string) => Promise<void>;
  /**
   * Multi-root detect. Runs POST /api/detect/changes-all on the server side
   * (iterates every watchedRootUrl sequentially). This is the correct
   * entry point when the user has more than one watchedRoot configured —
   * the singular `detect(rootUrl)` only refreshes ONE subtree, so changes
   * in the other roots stay invisible to the change list and the status
   * counter.
   */
  detectAll: () => Promise<void>;
  refresh: (rootUrl: string) => Promise<void>;
  clear: () => void;
}

export function useChanges(): UseChangesResult {
  const [changes, setChanges] = useState<ChangedDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [totalNodes, setTotalNodes] = useState(0);

  const detect = useCallback(async (rootUrl: string) => {
    setLoading(true);
    setError(null);

    try {
      const result: ChangeDetectionResult = await detectChanges(rootUrl);
      setChanges(result.changedDocuments);
      setLastCheckedAt(result.checkedAt);
      setTotalNodes(result.totalNodes);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to detect changes';
      setError(message);
      setChanges([]);
      setLastCheckedAt(null);
      setTotalNodes(0);
    } finally {
      setLoading(false);
    }
  }, []);

  const detectAll = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await detectChangesAll();
      setChanges(result.changedDocuments);
      setLastCheckedAt(result.checkedAt);
      setTotalNodes(result.totalNodes);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to detect changes';
      setError(message);
      setChanges([]);
      setLastCheckedAt(null);
      setTotalNodes(0);
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(
    (rootUrl: string) => {
      return detect(rootUrl);
    },
    [detect]
  );

  const clear = useCallback(() => {
    setChanges([]);
    setError(null);
    setLastCheckedAt(null);
    setTotalNodes(0);
  }, []);

  return {
    changes,
    loading,
    error,
    hasChanges: changes.length > 0,
    lastCheckedAt,
    totalNodes,
    detect,
    detectAll,
    refresh,
    clear,
  };
}
