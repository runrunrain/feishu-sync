/**
 * Hook for detecting document changes
 * M1: Full implementation with API integration
 */

import { useState, useCallback } from 'react';
import { detectChanges } from '../api/client';
import type { ChangeDetectionResult, ChangedDocument } from '../types';

interface UseChangesResult {
  changes: ChangedDocument[];
  loading: boolean;
  error: string | null;
  hasChanges: boolean;
  lastCheckedAt: string | null;
  totalNodes: number;
  detect: (rootUrl: string) => Promise<void>;
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
    refresh,
    clear,
  };
}
