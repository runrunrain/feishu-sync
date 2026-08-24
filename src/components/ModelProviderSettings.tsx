/**
 * ModelProviderSettings
 *
 * Provider + preset editor inspired by amagi-codebox's provider centre, but
 * deliberately scoped to this app's two remote execution protocols:
 * - direct: OpenAI-compatible endpoint/model alias
 * - Claude Code: Anthropic-compatible endpoint/model alias
 *
 * OpenCode is configured in the execution-channel card. When an active
 * profile has a key, the backend passes it to OpenCode only for the current
 * headless child process; the key is never written to OpenCode's local file.
 */

import { useEffect, useState } from 'react';
import {
  Eye,
  EyeOff,
  KeyRound,
  Layers3,
  Loader2,
  Plus,
  Save,
  Server,
  Trash2,
} from 'lucide-react';
import { Card, CardBody, CardHeader } from './common/Card';
import { Button } from './common/Button';
import { Input, Select, Toggle } from './common/Input';
import { useConfig } from '../hooks/useConfig';
import { useToast } from './common/Toast';
import { revealProviderApiKey } from '../api/client';
import type { LlmConfig, LlmModelPreset, LlmProviderConfig } from '../types';

function cloneLlmConfig(llm: LlmConfig): LlmConfig {
  return {
    ...llm,
    providers: llm.providers?.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({ ...model })),
    })),
  };
}

function uniqueId(prefix: string, existing: string[]): string {
  const stem = `${prefix}-${Date.now().toString(36)}`;
  let candidate = stem;
  let suffix = 2;
  while (existing.includes(candidate)) {
    candidate = `${stem}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function makeProvider(existing: LlmProviderConfig[]): LlmProviderConfig {
  const providerId = uniqueId('provider', existing.map((provider) => provider.id));
  const modelId = uniqueId('model', []);
  return {
    id: providerId,
    name: '新提供商',
    enabled: true,
    apiKey: '',
    openAiCompatBaseUrl: '',
    claudeCompatBaseUrl: '',
    defaultModelId: modelId,
    models: [{
      id: modelId,
      name: '默认模型',
      openAiModel: '',
      claudeCliModel: '',
      enabled: true,
    }],
  };
}

export function ModelProviderSettings() {
  const { config, saving, updateConfig } = useConfig();
  const toast = useToast();
  const [local, setLocal] = useState<LlmConfig | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [revealedProviderId, setRevealedProviderId] = useState<string | null>(null);
  const [revealingKey, setRevealingKey] = useState(false);

  useEffect(() => {
    if (!config?.llm) return;
    const next = cloneLlmConfig(config.llm);
    const providers = next.providers ?? [];
    setLocal(next);
    setSelectedProviderId((current) => (
      providers.some((provider) => provider.id === current)
        ? current
        : next.activeProviderId ?? providers[0]?.id ?? ''
    ));
    setShowKey(false);
    setRevealedProviderId(null);
  }, [config]);

  if (!local) return null;

  const providers = local.providers ?? [];
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId)
    ?? providers[0];

  const updateProvider = (providerId: string, updater: (provider: LlmProviderConfig) => LlmProviderConfig) => {
    setLocal((current) => {
      if (!current) return current;
      return {
        ...current,
        providers: (current.providers ?? []).map((provider) => (
          provider.id === providerId ? updater(provider) : provider
        )),
      };
    });
  };

  const concealRevealedKey = (providerId: string) => {
    if (revealedProviderId !== providerId) return;
    // A key obtained from the explicit reveal endpoint should not stay in
    // client state after the user hides it or switches providers. `***` is
    // understood by ConfigManager as "retain the stored secret" on save.
    updateProvider(providerId, (provider) => ({ ...provider, apiKey: '***' }));
    setRevealedProviderId(null);
  };

  const handleKeyVisibility = async () => {
    if (!selectedProvider || revealingKey) return;
    if (showKey) {
      concealRevealedKey(selectedProvider.id);
      setShowKey(false);
      return;
    }

    // An unsaved/just-typed key already exists only in this form, so toggling
    // the native input type is sufficient and makes the eye respond instantly.
    if (selectedProvider.apiKey !== '***') {
      setShowKey(true);
      return;
    }

    setRevealingKey(true);
    try {
      const apiKey = await revealProviderApiKey(selectedProvider.id);
      updateProvider(selectedProvider.id, (provider) => ({ ...provider, apiKey }));
      setRevealedProviderId(selectedProvider.id);
      setShowKey(true);
      toast.push({ type: 'success', message: '已显示保存的 API Key', hint: '再次点击眼睛即可隐藏；密钥不会写入日志。' });
    } catch (error) {
      toast.push({
        type: 'error',
        message: '无法显示保存的 API Key',
        hint: error instanceof Error ? error.message : '请确认该提供商已保存密钥后重试。',
      });
    } finally {
      setRevealingKey(false);
    }
  };

  const addProvider = () => {
    const provider = makeProvider(providers);
    setLocal((current) => {
      if (!current) return current;
      const currentProviders = current.providers ?? [];
      const shouldActivate = currentProviders.length === 0;
      return {
        ...current,
        providers: [...currentProviders, provider],
        activeProviderId: shouldActivate ? provider.id : current.activeProviderId,
        activeModelId: shouldActivate ? provider.defaultModelId : current.activeModelId,
      };
    });
    setSelectedProviderId(provider.id);
    setShowKey(false);
    setRevealedProviderId(null);
  };

  const removeProvider = (provider: LlmProviderConfig) => {
    if (providers.length <= 1) {
      toast.push({
        type: 'warning',
        message: '请至少保留一个提供商',
        hint: '如果只使用 OpenCode，可关闭该提供商而无需删除。',
      });
      return;
    }
    const remaining = providers.filter((item) => item.id !== provider.id);
    const nextSelected = remaining[0];
    setLocal((current) => {
      if (!current) return current;
      const wasActive = current.activeProviderId === provider.id;
      return {
        ...current,
        providers: remaining,
        activeProviderId: wasActive ? nextSelected.id : current.activeProviderId,
        activeModelId: wasActive
          ? (nextSelected.defaultModelId ?? nextSelected.models[0]?.id)
          : current.activeModelId,
      };
    });
    setSelectedProviderId(nextSelected.id);
    setShowKey(false);
    setRevealedProviderId(null);
  };

  const addModel = (provider: LlmProviderConfig) => {
    const model: LlmModelPreset = {
      id: uniqueId('model', provider.models.map((item) => item.id)),
      name: `模型 ${provider.models.length + 1}`,
      openAiModel: '',
      claudeCliModel: '',
      enabled: true,
    };
    updateProvider(provider.id, (current) => ({
      ...current,
      models: [...current.models, model],
      defaultModelId: current.defaultModelId ?? model.id,
    }));
  };

  const updateModel = (
    provider: LlmProviderConfig,
    modelId: string,
    patch: Partial<LlmModelPreset>,
  ) => {
    updateProvider(provider.id, (current) => ({
      ...current,
      models: current.models.map((model) => (
        model.id === modelId ? { ...model, ...patch } : model
      )),
    }));
  };

  const removeModel = (provider: LlmProviderConfig, modelId: string) => {
    if (provider.models.length <= 1) {
      toast.push({ type: 'warning', message: '每个提供商至少需要一个模型预设' });
      return;
    }
    const remaining = provider.models.filter((model) => model.id !== modelId);
    const nextDefault = provider.defaultModelId === modelId
      ? (remaining.find((model) => model.enabled)?.id ?? remaining[0]?.id)
      : provider.defaultModelId;
    updateProvider(provider.id, (current) => ({
      ...current,
      models: remaining,
      defaultModelId: nextDefault,
    }));
    setLocal((current) => {
      if (!current || current.activeProviderId !== provider.id || current.activeModelId !== modelId) {
        return current;
      }
      return { ...current, activeModelId: nextDefault };
    });
  };

  const handleSave = async () => {
    try {
      // This card owns provider profiles only. Sending a narrow patch keeps a
      // concurrently open execution-channel card from being overwritten by a
      // stale copy of the rest of `llm`.
      await updateConfig({
        llm: {
          providers: local.providers,
          activeProviderId: local.activeProviderId,
          activeModelId: local.activeModelId,
        },
      });
      toast.push({ type: 'success', message: '模型提供商与预设已保存' });
    } catch (error) {
      toast.push({
        type: 'error',
        message: '保存模型提供商失败',
        hint: error instanceof Error ? error.message : '',
      });
    }
  };

  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Server className="w-4 h-4 text-seal" />
            <div>
              <h2 className="text-base font-kai font-medium text-ink">模型提供商与预设</h2>
              <p className="mt-0.5 text-xs text-ink-faint">
                按提供商保存端点、密钥与模型别名；可在“执行通道”选择当前生效的预设。
              </p>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={addProvider}>
            <Plus className="w-3.5 h-3.5" />
            添加提供商
          </Button>
        </div>
      </CardHeader>

      <CardBody className="space-y-4">
        <div className="rounded-md border border-jade/30 bg-jade/5 px-3 py-2.5 text-xs text-ink-soft">
          <p>
            direct 使用 OpenAI 兼容端点与模型；Claude Code 无头模式使用 Anthropic 兼容端点与模型。
            同一提供商可为两条协议填写不同模型别名。Z.AI / BigModel 的 Claude Code 无头模式建议使用 glm-4.7；若旧配置仍填写 glm-5.2，应用会仅在 Claude Code 调用时自动映射为 glm-4.7。OpenCode 会在本次无头调用中临时使用当前提供商的密钥（不会写入 OpenCode 配置文件）；未配置密钥时才回退到 OpenCode 本机配置。
          </p>
        </div>

        {providers.length === 0 ? (
          <div className="rounded-md border border-dashed border-line p-6 text-center">
            <Server className="mx-auto h-6 w-6 text-ink-faint" />
            <p className="mt-2 text-sm text-ink-soft">尚未配置远程模型提供商</p>
            <p className="mt-1 text-xs text-ink-faint">添加后即可为 direct 或 Claude Code 选择模型。</p>
            <Button className="mt-4" size="sm" onClick={addProvider}>
              <Plus className="w-3.5 h-3.5" />
              添加第一个提供商
            </Button>
          </div>
        ) : selectedProvider ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-[13rem_1fr]">
            <aside className="space-y-1 md:border-r md:border-line md:pr-4" aria-label="模型提供商列表">
              {providers.map((provider) => {
                const selected = provider.id === selectedProvider.id;
                const active = local.activeProviderId === provider.id;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => {
                      concealRevealedKey(selectedProvider.id);
                      setSelectedProviderId(provider.id);
                      setShowKey(false);
                    }}
                    className={`w-full rounded-md border px-3 py-2.5 text-left transition-colors ${
                      selected
                        ? 'border-seal bg-seal/5'
                        : 'border-transparent hover:border-line hover:bg-paper-2'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-ink">{provider.name || '未命名提供商'}</span>
                      {active && <span className="shrink-0 text-[10px] text-seal">当前</span>}
                    </span>
                    <span className="mt-1 block text-[11px] text-ink-faint">
                      {provider.models.length} 个预设 · {provider.enabled ? '已启用' : '已停用'}
                    </span>
                  </button>
                );
              })}
            </aside>

            <section className="min-w-0 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-ink-soft">
                  <Layers3 className="h-4 w-4 text-jade" />
                  编辑提供商：<span className="font-medium text-ink">{selectedProvider.name || '未命名提供商'}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeProvider(selectedProvider)}
                  disabled={providers.length <= 1}
                  title={providers.length <= 1 ? '请至少保留一个提供商；可改为停用' : '删除当前提供商'}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <Input
                  label="提供商名称"
                  value={selectedProvider.name}
                  onChange={(event) => updateProvider(selectedProvider.id, (provider) => ({
                    ...provider,
                    name: event.target.value,
                  }))}
                  placeholder="例如：智谱 GLM / OpenAI / 公司网关"
                />
                <Toggle
                  label="启用提供商"
                  checked={selectedProvider.enabled}
                  onChange={(enabled) => updateProvider(selectedProvider.id, (provider) => ({
                    ...provider,
                    enabled,
                  }))}
                  helperText="停用后不会被远程通道选用"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <Input
                  label="direct Base URL（OpenAI 兼容）"
                  type="url"
                  value={selectedProvider.openAiCompatBaseUrl}
                  onChange={(event) => updateProvider(selectedProvider.id, (provider) => ({
                    ...provider,
                    openAiCompatBaseUrl: event.target.value,
                  }))}
                  placeholder="https://api.example.com/v1"
                  helperText="选择 direct 通道时使用"
                />
                <Input
                  label="Claude Code Base URL（Anthropic 兼容）"
                  type="url"
                  value={selectedProvider.claudeCompatBaseUrl}
                  onChange={(event) => updateProvider(selectedProvider.id, (provider) => ({
                    ...provider,
                    claudeCompatBaseUrl: event.target.value,
                  }))}
                  placeholder="https://api.example.com/anthropic"
                  helperText="选择 Claude Code 无头模式时使用"
                />
              </div>

              <Input
                label="API Key"
                type={showKey ? 'text' : 'password'}
                value={selectedProvider.apiKey}
                onChange={(event) => {
                  // Once the user edits a revealed value it becomes a new
                  // pending credential, so hiding must not replace it with
                  // the retained-secret sentinel.
                  if (revealedProviderId === selectedProvider.id) {
                    setRevealedProviderId(null);
                  }
                  updateProvider(selectedProvider.id, (provider) => ({
                    ...provider,
                    apiKey: event.target.value,
                  }));
                }}
                placeholder="留空表示该提供商尚未配置凭据"
                leftIcon={<KeyRound className="h-4 w-4" />}
                rightIcon={(
                  <button
                    type="button"
                    onClick={() => void handleKeyVisibility()}
                    className="rounded p-0.5 hover:text-ink disabled:cursor-wait disabled:opacity-60"
                    aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                    title={showKey ? '隐藏密钥' : '显示密钥'}
                    disabled={revealingKey}
                  >
                    {revealingKey
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : showKey
                        ? <EyeOff className="h-4 w-4" />
                        : <Eye className="h-4 w-4" />}
                  </button>
                )}
                helperText={showKey
                  ? '已按本次操作显示密钥；再次点击眼睛即可隐藏。'
                  : '读取设置时会隐藏已保存的密钥；点击眼睛可按需显示。输入空值并保存可清除该提供商的密钥。'}
              />

              <div className="space-y-3 border-t border-line pt-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-ink-soft font-serif">模型预设</p>
                    <p className="mt-0.5 text-xs text-ink-faint">一个预设可为 direct 与 Claude Code 设置不同的模型名。</p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => addModel(selectedProvider)}>
                    <Plus className="h-3.5 w-3.5" />
                    添加模型
                  </Button>
                </div>

                <Select
                  label="该提供商的默认预设"
                  value={selectedProvider.defaultModelId ?? selectedProvider.models[0]?.id ?? ''}
                  onChange={(event) => updateProvider(selectedProvider.id, (provider) => ({
                    ...provider,
                    defaultModelId: event.target.value,
                  }))}
                  options={selectedProvider.models.map((model) => ({
                    value: model.id,
                    label: `${model.name || model.id}${model.enabled ? '' : '（已停用）'}`,
                  }))}
                  helperText="切换到该提供商且未指定其他预设时使用"
                />

                <div className="space-y-3">
                  {selectedProvider.models.map((model, index) => (
                    <div key={model.id} className="rounded-md border border-line bg-paper/40 p-3">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <span className="text-xs text-ink-faint">预设 {index + 1}</span>
                        <div className="flex items-center gap-3">
                          <Toggle
                            label="启用"
                            checked={model.enabled}
                            onChange={(enabled) => updateModel(selectedProvider, model.id, { enabled })}
                          />
                          <button
                            type="button"
                            onClick={() => removeModel(selectedProvider, model.id)}
                            disabled={selectedProvider.models.length <= 1}
                            className="rounded p-1 text-ink-faint hover:bg-seal/10 hover:text-seal disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label={`删除模型预设 ${model.name || model.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                        <Input
                          label="预设名称"
                          value={model.name}
                          onChange={(event) => updateModel(selectedProvider, model.id, { name: event.target.value })}
                          placeholder="例如：GLM 5.2"
                        />
                        <Input
                          label="direct 模型"
                          value={model.openAiModel}
                          onChange={(event) => updateModel(selectedProvider, model.id, { openAiModel: event.target.value })}
                          placeholder="glm-4-flash"
                          helperText={/\bglm-[^\s\[]+\[[^\]]+\]/i.test(model.openAiModel)
                            ? 'GLM API 请填写标准模型代码（例如 glm-5.2）；容量显示后缀会在运行时自动移除。'
                            : undefined}
                        />
                        <Input
                          label="Claude Code 模型"
                          value={model.claudeCliModel}
                          onChange={(event) => updateModel(selectedProvider, model.id, { claudeCliModel: event.target.value })}
                          placeholder="glm-4.7"
                          helperText={/\bglm-[^\s\[]+\[[^\]]+\]/i.test(model.claudeCliModel)
                            ? 'GLM API 请填写标准模型代码（例如 glm-4.7）；容量显示后缀会在运行时自动移除。'
                            : /(?:^|[/.])(?:bigmodel\.cn|z\.ai)(?:[/:]|$)/i.test(`${selectedProvider.openAiCompatBaseUrl} ${selectedProvider.claudeCompatBaseUrl}`)
                              && /^glm-5\.2$/i.test(model.claudeCliModel.trim())
                              ? 'Z.AI Claude Code 通道当前会将 glm-5.2 映射为已验证的 glm-4.7；direct 与 OpenCode 不受影响。'
                              : undefined}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        ) : null}

        <div className="flex justify-end border-t border-line pt-4">
          <Button onClick={handleSave} loading={saving}>
            <Save className="h-4 w-4" />
            保存提供商配置
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
