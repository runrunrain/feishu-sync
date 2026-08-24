/**
 * Sync state context - document synchronization
 * M2: Full implementation with syncDocuments and syncIndex.
 *
 * Bug fix（状态提升）：syncing/syncResult 等状态原挂在 SyncView 内部的
 * useState，切换主区导致 SyncView 卸载后全部丢失（后台同步仍在执行，进度卡消失）。
 * 现提升到 SyncProvider（挂于 App 根部 ToastProvider 内），useSync 保持同名、
 * 同返回结构退化为 Context 消费者，SyncView 调用点无需改动。
 *
 * 新增 total：syncDocuments 开始时记录本次提交的 documents.length，用于
 * SyncProgress 在切回主区后仍能显示 "done / total"（此时 selectedTokens 已清空，
 * 不能再依赖 selectedDocs.length）。
 *
 * syncDocuments intentionally exposes only selected documents. The API client
 * requests a confirmed apply; the Sync view owns the user-facing confirmation
 * and the backend remains the final safety gate for every planned write.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { SyncResult, ChangedDocument, SyncDocumentOptions } from '../types';
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
  /** 本次（或最近一次）syncDocuments 提交的文档总数；0 表示尚未发起同步。 */
  total: number;
  syncDocuments: (
    documents: ChangedDocument[],
    options?: SyncDocumentOptions,
  ) => Promise<SyncResult | null>;
  syncIndex: (rootDir?: string) => Promise<void>;
  clear: () => void;
}

const SyncContext = createContext<UseSyncResult | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const [syncing, setSyncing] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [indexResult, setIndexResult] = useState<IndexResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  const syncDocuments = useCallback(async (
    documents: ChangedDocument[],
    options: SyncDocumentOptions = {},
  ) => {
    if (documents.length === 0) {
      setError('No documents selected for sync');
      return null;
    }

    setSyncing(true);
    setError(null);
    setSyncResult(null);
    setTotal(documents.length);

    try {
      const result = await syncDocs(documents, options);
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
    setTotal(0);
  }, []);

  const value = useMemo<UseSyncResult>(() => ({
    syncing,
    indexing,
    syncResult,
    indexResult,
    error,
    total,
    syncDocuments,
    syncIndex,
    clear,
  }), [syncing, indexing, syncResult, indexResult, error, total, syncDocuments, syncIndex, clear]);

  return (
    <SyncContext.Provider value={value}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSync(): UseSyncResult {
  const context = useContext(SyncContext);
  if (!context) {
    throw new Error('useSync must be used within a SyncProvider');
  }
  return context;
}
