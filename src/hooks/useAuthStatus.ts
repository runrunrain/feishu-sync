/**
 * Hook for managing Feishu authentication status
 * Provides ready state and error information
 */

import { useState, useCallback, useEffect } from 'react';
import { getAuthStatus, APIError } from '../api/client';
import type { AuthStatus } from '../types';

interface UseAuthStatusResult {
  authStatus: AuthStatus | null;
  loading: boolean;
  error: string | null;
  ready: boolean;
  refresh: () => Promise<void>;
  check: () => Promise<void>;
}

export function useAuthStatus(pollInterval: number = 30000): UseAuthStatusResult {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await getAuthStatus();
      setAuthStatus(status);
      if (!status.ready && status.error) {
        setError(status.error);
      }
    } catch (err) {
      const message = err instanceof APIError ? err.message : 'Failed to check authentication status';
      setError(message);
      setAuthStatus({ ready: false, error: message });
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await check();
  }, [check]);

  useEffect(() => {
    check();

    if (pollInterval > 0) {
      const interval = setInterval(check, pollInterval);
      return () => clearInterval(interval);
    }
  }, [check, pollInterval]);

  return {
    authStatus,
    loading,
    error,
    ready: authStatus?.ready ?? false,
    refresh,
    check,
  };
}
