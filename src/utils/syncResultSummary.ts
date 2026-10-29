import type { SyncResult } from '../types';

/** A saved CSV is usable, but does not mean that Excel repair succeeded. */
export function summarizeSyncResult(result: SyncResult) {
  const isDryRun = result.mode === 'dry-run';
  const partialDocuments = isDryRun ? [] : result.syncedDocuments.filter((document) => document.sheetAcquisition === 'csv-fallback');
  const completedDocuments = isDryRun ? [] : result.syncedDocuments.filter((document) => document.sheetAcquisition !== 'csv-fallback');
  const writablePlans = (result.plannedDocuments ?? []).filter((document) => document.action !== 'blocked');
  return {
    isDryRun,
    partialDocuments,
    completedDocuments,
    writablePlans,
    successCount: isDryRun ? writablePlans.length : completedDocuments.length,
    failedCount: result.failedDocuments.length,
    ok: result.success && result.failedDocuments.length === 0 && partialDocuments.length === 0,
  };
}
