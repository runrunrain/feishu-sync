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
  /** 已完成（成功+失败）的文档数——逐文档串行提交驱动，真实进度。 */
  done: number;
  /** 当前正在同步的文档标题（串行提交中实时更新；空闲时 null）。 */
  currentTitle: string | null;
  /** 本次已失败文档数（实时）。 */
  failedCount: number;
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
  const [done, setDone] = useState(0);
  const [currentTitle, setCurrentTitle] = useState<string | null>(null);
  const [failedCount, setFailedCount] = useState(0);

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
    setDone(0);
    setFailedCount(0);
    setCurrentTitle(documents[0]?.title ?? null);

    // 2026-09 真实进度修复：改为逐文档串行提交（后端本就按文档独立原子
    // 提交，语义等价；本地 HTTP 开销可忽略）。每完成一个文档即推进
    // done / currentTitle / failedCount，SyncProgress 得以展示真实百分比
    // 与当前正在同步的文档名。结果聚合成单份 SyncResult 供报告面板使用。
    const syncedAcc: SyncResult['syncedDocuments'] = [];
    const failedAcc: SyncResult['failedDocuments'] = [];
    let lastResult: SyncResult | null = null;
    let firstStartedAt = '';
    let durationMs = 0;

    try {
      for (let i = 0; i < documents.length; i += 1) {
        const doc = documents[i];
        setCurrentTitle(doc.title);
        try {
          const result = await syncDocs([doc], options);
          lastResult = result;
          if (!firstStartedAt && result.startedAt) firstStartedAt = result.startedAt;
          durationMs += result.duration ?? 0;
          syncedAcc.push(...(result.syncedDocuments ?? []));
          failedAcc.push(...(result.failedDocuments ?? []));
          setFailedCount(failedAcc.length);
        } catch (docErr) {
          // 单文档网络层失败：记入 failed 并继续后续文档，错误详情在
          // 结果报告中可见。
          const message = docErr instanceof Error ? docErr.message : 'Sync failed';
          failedAcc.push({
            objToken: doc.objToken,
            title: doc.title,
            error: message,
            retryable: true,
          });
          setFailedCount(failedAcc.length);
        }
        setDone(i + 1);
      }

      const completedAt = new Date().toISOString();
      const aggregated: SyncResult = {
        ...(lastResult as SyncResult),
        success: failedAcc.length === 0,
        syncedDocuments: syncedAcc,
        failedDocuments: failedAcc,
        startedAt: firstStartedAt || completedAt,
        completedAt,
        duration: durationMs,
      };
      setSyncResult(aggregated);
      return aggregated;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      setError(message);
      return null;
    } finally {
      setSyncing(false);
      setCurrentTitle(null);
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
    done,
    currentTitle,
    failedCount,
    syncDocuments,
    syncIndex,
    clear,
  }), [syncing, indexing, syncResult, indexResult, error, total, done, currentTitle, failedCount, syncDocuments, syncIndex, clear]);

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
