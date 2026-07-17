/**
 * Hook for document synchronization
 * M2: Full implementation with syncDocuments and syncIndex.
 *
 * P0-06: syncDocuments intentionally exposes only selected documents. The
 * API client fixes unsupported fullSync/LLM options to false and requests a
 * dry-run, so callers cannot accidentally present those pseudo-features.
 */

import { useState, useCallback } from 'react';
import type { SyncResult, ChangedDocument } from '../types';
import { syncDocs, syncIndex as apiSyncIndex } from '../api/client';

interface IndexResult {
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
  errors?: string[];
}

interface UseSyncResult {
  syncing: boolean;
  indexing: boolean;
  syncResult: SyncResult | null;
  indexResult: IndexResult | null;
  error: string | null;
  syncDocuments: (documents: ChangedDocument[]) => Promise<SyncResult | null>;
  syncIndex: (rootDir?: string) => Promise<void>;
  clear: () => void;
}

export function useSync(): UseSyncResult {
  const [syncing, setSyncing] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [indexResult, setIndexResult] = useState<IndexResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const syncDocuments = useCallback(async (
    documents: ChangedDocument[]
  ) => {
    if (documents.length === 0) {
      setError('No documents selected for sync');
      return null;
    }

    setSyncing(true);
    setError(null);
    setSyncResult(null);

    try {
      const result = await syncDocs(documents);
      setSyncResult(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      setError(message);
      return null;
    } finally {
      setSyncing(false);
    }
  }, []);

  const syncIndex = useCallback(async (rootDir?: string) => {
    setIndexing(true);
    setError(null);
    setIndexResult(null);

    try {
      const result = await apiSyncIndex({ rootDir });
      setIndexResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Index scan failed';
      setError(message);
    } finally {
      setIndexing(false);
    }
  }, []);

  const clear = useCallback(() => {
    setSyncResult(null);
    setIndexResult(null);
    setError(null);
  }, []);

  return {
    syncing,
    indexing,
    syncResult,
    indexResult,
    error,
    syncDocuments,
    syncIndex,
    clear,
  };
}
