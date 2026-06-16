/**
 * Hook for document synchronization
 * Skeleton for M2 - basic structure with empty state
 */

import { useState, useCallback } from 'react';
import type { SyncResult } from '../types';

interface UseSyncResult {
  syncing: boolean;
  progress: number;
  error: string | null;
  result: SyncResult | null;
  sync: (objTokens: string[], enableLLM?: boolean, fullSync?: boolean) => Promise<void>;
  clear: () => void;
}

export function useSync(): UseSyncResult {
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);

  const sync = useCallback(async (
    objTokens: string[],
    enableLLM: boolean = false,
    fullSync: boolean = false
  ) => {
    // M2 skeleton - this will be implemented in M2
    setError('Document synchronization will be enabled in M2');
  }, []);

  const clear = useCallback(() => {
    setProgress(0);
    setError(null);
    setResult(null);
  }, []);

  return {
    syncing,
    progress,
    error,
    result,
    sync,
    clear,
  };
}
