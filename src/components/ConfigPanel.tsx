/**
 * Configuration Panel
 * Full configuration form for all settings
 */

import { useState, useEffect } from 'react';
import { useConfig } from '../hooks/useConfig';
import { Button } from './common/Button';
import { Card, CardHeader, CardBody, CardFooter } from './common/Card';
import type { Config } from '../types';

export function ConfigPanel() {
  const { config, loading, error, saving, saveError, updateConfig } = useConfig();
  const [localConfig, setLocalConfig] = useState<Partial<Config>>({});

  // Initialize local config when loaded
  useEffect(() => {
    if (config) {
      setLocalConfig(config);
    }
  }, [config]);

  const handleChange = (field: keyof Config, value: any) => {
    setLocalConfig(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    try {
      await updateConfig(localConfig);
    } catch (err) {
      // Error is already handled by useConfig
    }
  };

  const handleReset = () => {
    if (config) {
      setLocalConfig(config);
    }
  };

  const handleOpenDataDirectory = async () => {
    if (typeof window !== 'undefined' && window.desktop) {
      try {
        await window.desktop.openDataDirectory();
      } catch (err) {
        console.error('Failed to open data directory:', err);
      }
    }
  };

  if (loading) {
    return (
      <Card>
        <CardBody className="flex items-center justify-center py-12">
          <div className="animate-spin h-6 w-6 border-2 border-accent border-t-transparent rounded-full" />
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardBody className="py-12 text-center">
          <p className="text-error mb-4">{error}</p>
          <Button onClick={() => window.location.reload()} variant="secondary">Retry</Button>
        </CardBody>
      </Card>
    );
  }

  if (!config) return null;

  const currentConfig = { ...config, ...localConfig };

  return (
    <div className="space-y-6">
      {/* LLM Configuration */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">LLM Settings</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Base URL
            </label>
            <input
              type="url"
              value={currentConfig.llm.baseUrl}
              onChange={(e) => handleChange('llm', { ...currentConfig.llm, baseUrl: e.target.value })}
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
              placeholder="https://api.deepseek.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              API Key
            </label>
            <input
              type="password"
              value={currentConfig.llm.apiKey}
              onChange={(e) => handleChange('llm', { ...currentConfig.llm, apiKey: e.target.value })}
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
              placeholder="sk-..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Model
            </label>
            <select
              value={currentConfig.llm.model}
              onChange={(e) => handleChange('llm', { ...currentConfig.llm, model: e.target.value as 'deepseek-chat' | 'deepseek-reasoner' })}
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <option value="deepseek-chat">deepseek-chat</option>
              <option value="deepseek-reasoner">deepseek-reasoner</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Temperature: {currentConfig.llm.temperature}
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={currentConfig.llm.temperature}
              onChange={(e) => handleChange('llm', { ...currentConfig.llm, temperature: parseFloat(e.target.value) })}
              className="w-full h-2 bg-bg-surface rounded-lg appearance-none cursor-pointer"
            />
          </div>
        </CardBody>
      </Card>

      {/* Sync Configuration */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Sync Settings</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Poll Interval (minutes): {currentConfig.pollIntervalMinutes}
            </label>
            <input
              type="number"
              min="5"
              max="1440"
              value={currentConfig.pollIntervalMinutes}
              onChange={(e) => handleChange('pollIntervalMinutes', parseInt(e.target.value) || 30)}
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
            <p className="text-xs text-text-tertiary mt-1">Between 5 and 1440 minutes</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Knowledge Base Root
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={currentConfig.knowledgeBaseRoot}
                onChange={(e) => handleChange('knowledgeBaseRoot', e.target.value)}
                className="flex-1 px-3 py-2 bg-bg-surface border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
                placeholder="D:\WorkPace\公司知识库"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={handleOpenDataDirectory}
              >
                Open
              </Button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Watched Root URLs
            </label>
            <div className="space-y-2">
              {currentConfig.watchedRootUrls.map((url, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => {
                      const newUrls = [...currentConfig.watchedRootUrls];
                      newUrls[index] = e.target.value;
                      handleChange('watchedRootUrls', newUrls);
                    }}
                    className="flex-1 px-3 py-2 bg-bg-surface border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
                    placeholder="https://..."
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const newUrls = currentConfig.watchedRootUrls.filter((_, i) => i !== index);
                      handleChange('watchedRootUrls', newUrls);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleChange('watchedRootUrls', [...currentConfig.watchedRootUrls, ''])}
              >
                Add URL
              </Button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Lark CLI Path (optional)
            </label>
            <input
              type="text"
              value={currentConfig.larkCliPath || ''}
              onChange={(e) => handleChange('larkCliPath', e.target.value || undefined)}
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
              placeholder="Leave empty to use PATH"
            />
          </div>
        </CardBody>
      </Card>

      {/* Application Settings */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Application</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-text-primary">Auto Start</label>
              <p className="text-xs text-text-tertiary">Start application on system boot</p>
            </div>
            <button
              onClick={() => handleChange('enableAutoStart', !currentConfig.enableAutoStart)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${currentConfig.enableAutoStart ? 'bg-accent' : 'bg-bg-surface'}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${currentConfig.enableAutoStart ? 'translate-x-6' : 'translate-x-1'}`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-text-primary">Notifications</label>
              <p className="text-xs text-text-tertiary">Show notifications for sync events</p>
            </div>
            <button
              onClick={() => handleChange('enableNotifications', !currentConfig.enableNotifications)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${currentConfig.enableNotifications ? 'bg-accent' : 'bg-bg-surface'}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${currentConfig.enableNotifications ? 'translate-x-6' : 'translate-x-1'}`}
              />
            </button>
          </div>
        </CardBody>
        <CardFooter className="flex justify-between items-center">
          <div>
            {saveError && (
              <p className="text-error text-sm">{saveError}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={handleReset} disabled={saving}>
              Reset
            </Button>
            <Button onClick={handleSave} loading={saving}>
              Save
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
