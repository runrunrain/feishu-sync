/**
 * Sync Status Hook
 * Provides aggregated sync status for SyncPulse component
 */

import { useState, useEffect } from 'react';

interface SyncStatusData {
  pendingCount: number;
  lastSyncTime: number | null;
  nextCheckTime: number | null;
  isDetecting: boolean;
}

export function useSyncStatus(): SyncStatusData {
  // TODO: Integrate with real sync state from useChanges and config
  // For now, return placeholder data
  const [status, setStatus] = useState<SyncStatusData>({
    pendingCount: 0,
    lastSyncTime: null,
    nextCheckTime: null,
    isDetecting: false,
  });

  useEffect(() => {
    // Simulate initial state
    const now = Date.now();
    setStatus({
      pendingCount: 3,
      lastSyncTime: now - 15 * 60 * 1000, // 15 minutes ago
      nextCheckTime: now + 5 * 60 * 1000, // 5 minutes from now
      isDetecting: false,
    });
  }, []);

  return status;
}
