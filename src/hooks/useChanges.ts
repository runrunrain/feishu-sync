/**
 * Hook for detecting document changes
 * Skeleton for M1 - basic structure with empty state
 */

import { useState, useCallback } from 'react';
import type { ChangedDocument } from '../types';

interface UseChangesResult {
  changes: ChangedDocument[];
  loading: boolean;
  error: string | null;
  hasChanges: boolean;
  detect: (rootUrl: string) => Promise<void>;
  clear: () => void;
}

export function useChanges(): UseChangesResult {
  const [changes, setChanges] = useState<ChangedDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detect = useCallback(async (rootUrl: string) => {
    // M1 skeleton - this will be implemented in M1
    setError('Change detection will be enabled in M1');
  }, []);

  const clear = useCallback(() => {
    setChanges([]);
    setError(null);
  }, []);

  return {
    changes,
    loading,
    error,
    hasChanges: changes.length > 0,
    detect,
    clear,
  };
}
