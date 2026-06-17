/**
 * Configuration Panel - 按设计系统重新设计
 * 卡片化表单，分组显示，定制输入框样式
 */

import { useState, useEffect } from 'react';
import { useConfig } from '../hooks/useConfig';
import { Button } from './common/Button';
import { Card, CardHeader, CardBody, CardFooter } from './common/Card';
import { Input, Select, Toggle, Range } from './common/Input';
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
        <CardBody className="space-y-5">
          <Input
            label="Base URL"
            type="url"
            value={currentConfig.llm.baseUrl}
            onChange={(e) => handleChange('llm', { ...currentConfig.llm, baseUrl: e.target.value })}
            placeholder="https://api.deepseek.com"
          />

          <Input
            label="API Key"
            type="password"
            value={currentConfig.llm.apiKey}
            onChange={(e) => handleChange('llm', { ...currentConfig.llm, apiKey: e.target.value })}
            placeholder="sk-..."
          />

          <Select
            label="Model"
            value={currentConfig.llm.model}
            onChange={(e) => handleChange('llm', { ...currentConfig.llm, model: e.target.value as 'deepseek-chat' | 'deepseek-reasoner' })}
            options={[
              { value: 'deepseek-chat', label: 'deepseek-chat' },
              { value: 'deepseek-reasoner', label: 'deepseek-reasoner' },
            ]}
          />

          <Range
            label="Temperature"
            min="0"
            max="1"
            step="0.1"
            value={currentConfig.llm.temperature}
            onChange={(e) => handleChange('llm', { ...currentConfig.llm, temperature: parseFloat(e.target.value) })}
            helperText="Lower = more focused, Higher = more creative"
          />
        </CardBody>
      </Card>

      {/* Sync Configuration */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Sync Settings</h2>
        </CardHeader>
        <CardBody className="space-y-5">
          <Input
            label="Poll Interval (minutes)"
            type="number"
            min="5"
            max="1440"
            value={currentConfig.pollIntervalMinutes}
            onChange={(e) => handleChange('pollIntervalMinutes', parseInt(e.target.value) || 30)}
            helperText="Between 5 and 1440 minutes"
          />

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              Knowledge Base Root
            </label>
            <div className="flex gap-2">
              <Input
                fullWidth
                type="text"
                value={currentConfig.knowledgeBaseRoot}
                onChange={(e) => handleChange('knowledgeBaseRoot', e.target.value)}
                placeholder="D:\WorkPace\公司知识库"
              />
              <Button
                variant="secondary"
                size="md"
                onClick={handleOpenDataDirectory}
              >
                Open
              </Button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              Watched Root URLs
            </label>
            <div className="space-y-2">
              {currentConfig.watchedRootUrls.map((url, index) => (
                <div key={index} className="flex gap-2">
                  <Input
                    fullWidth
                    type="url"
                    value={url}
                    onChange={(e) => {
                      const newUrls = [...currentConfig.watchedRootUrls];
                      newUrls[index] = e.target.value;
                      handleChange('watchedRootUrls', newUrls);
                    }}
                    placeholder="https://..."
                  />
                  <Button
                    variant="ghost"
                    size="md"
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

          <Input
            label="Lark CLI Path (optional)"
            type="text"
            value={currentConfig.larkCliPath || ''}
            onChange={(e) => handleChange('larkCliPath', e.target.value || undefined)}
            placeholder="Leave empty to use PATH"
          />
        </CardBody>
      </Card>

      {/* Application Settings */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Application</h2>
        </CardHeader>
        <CardBody className="space-y-5">
          <Toggle
            label="Auto Start"
            checked={currentConfig.enableAutoStart}
            onChange={(checked) => handleChange('enableAutoStart', checked)}
            helperText="Start application on system boot"
          />

          <Toggle
            label="Notifications"
            checked={currentConfig.enableNotifications}
            onChange={(checked) => handleChange('enableNotifications', checked)}
            helperText="Show notifications for sync events"
          />
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
