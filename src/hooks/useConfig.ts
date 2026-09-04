/**
 * Hook for managing configuration
 * Provides loading, error, and success states
 *
 * 2026-09-04 跨实例同步修复：useConfig 是组件本地 state，无全局 context，
 * 每个消费组件持有独立副本。此前在设置页（WatchedRootsCard）保存
 * watchedRoots 后，GlobalStatusBar 等其他组件的副本不会更新——“添加
 * 飞书根 URL 后立即检测按钮仍不可点击”即此根因（detectDisabled 基于
 * 旧 config 的 watchedRootUrls 判空）。现约定：任一实例 updateConfig
 * 成功后向 window 广播 CONFIG_UPDATED_EVENT，所有实例监听并重新拉取，
 * 服务端真相源单一、前端副本最终一致。
 */

import { useState, useCallback, useEffect } from 'react';
import { getConfig, saveConfig, APIError, type ConfigUpdate } from '../api/client';
import type { Config } from '../types';

export const CONFIG_UPDATED_EVENT = 'feishu-sync:config-updated';

interface UseConfigResult {
  config: Config | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  saveError: string | null;
  loadConfig: () => Promise<void>;
  updateConfig: (updates: ConfigUpdate) => Promise<void>;
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

  const updateConfig = useCallback(async (updates: ConfigUpdate) => {
    if (!config) return;

    setSaving(true);
    setSaveError(null);
    try {
      const updated = await saveConfig(updates);
      // 广播给其他 useConfig 实例（含本实例的重新拉取），见文件头注释。
      window.dispatchEvent(new CustomEvent(CONFIG_UPDATED_EVENT));
      // Defensive: client.saveConfig already unwraps `{success, config}`,
      // but guard against regression so a bad server response cannot crash
      // KnowledgeSettingsCard / LLMChannelSwitcher via setConfig of bad shape.
      if (updated && typeof updated === 'object' && 'config' in updated && 'success' in updated) {
        const wrapped = updated as unknown as { success: boolean; config: Config };
        setConfig(wrapped.config);
      } else {
        setConfig(updated);
      }
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

  // 跨实例同步：任一组件保存配置后广播事件，本实例重新拉取服务端
  // 真相源（避免各副本漂移；详见文件头注释）。
  useEffect(() => {
    const handler = () => {
      void loadConfig();
    };
    window.addEventListener(CONFIG_UPDATED_EVENT, handler);
    return () => window.removeEventListener(CONFIG_UPDATED_EVENT, handler);
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
