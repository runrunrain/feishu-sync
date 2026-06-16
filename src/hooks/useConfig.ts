/**
 * Hook for managing configuration
 * Provides loading, error, and success states
 */

import { useState, useCallback, useEffect } from 'react';
import { getConfig, saveConfig, APIError } from '../api/client';
import type { Config } from '../types';

interface UseConfigResult {
  config: Config | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  saveError: string | null;
  loadConfig: () => Promise<void>;
  updateConfig: (updates: Partial<Config>) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useConfig(): UseConfigResult {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getConfig();
      setConfig(data);
    } catch (err) {
      const message = err instanceof APIError ? err.message : 'Failed to load configuration';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const updateConfig = useCallback(async (updates: Partial<Config>) => {
    if (!config) return;

    setSaving(true);
    setSaveError(null);
    try {
      const updated = await saveConfig(updates);
      setConfig(updated);
    } catch (err) {
      const message = err instanceof APIError ? err.message : 'Failed to save configuration';
      setSaveError(message);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [config]);

  const refresh = useCallback(async () => {
    await loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  return {
    config,
    loading,
    error,
    saving,
    saveError,
    loadConfig,
    updateConfig,
    refresh,
  };
}
