/**
 * ModelProviderSettings
 *
 * Provider + preset editor（v0.2.9 单通道版）：每个提供商一个 OpenAI 兼容
 * 端点 + 密钥 + 若干模型别名预设；文档整理经 direct 通道调用当前选中的
 * 提供商/预设。claude-cli / opencode 本地无头通道已移除。
 */

import { useEffect, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  KeyRound,
  Layers3,
  Loader2,
  Plus,
  Server,
  Trash2,
} from 'lucide-react';
import { Card, CardBody, CardHeader } from './common/Card';
import { Button } from './common/Button';
import { Input, Select, Toggle } from './common/Input';
import { useConfig } from '../hooks/useConfig';
import { useSettingsForm } from '../hooks/settingsDraft';
import { useToast } from './common/Toast';
import { revealProviderApiKey } from '../api/client';
import type { LlmConfig, LlmModelPreset, LlmProviderConfig } from '../types';

const NEW_PRESET_CONTEXT_WINDOW = 200_000;

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
    anthropicAuthType: 'auth-token',
    protocol: 'openai-completions',
    openAiCompatBaseUrl: '',
    defaultModelId: modelId,
    models: [{
      id: modelId,
      name: '默认模型',
      openAiModel: '',
      enabled: true,
      contextWindow: NEW_PRESET_CONTEXT_WINDOW,
    }],
  };
}

export function ModelProviderSettings() {
  const { config } = useConfig();
  const toast = useToast();
  const [local, setLocal] = useState<LlmConfig | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [revealedProviderId, setRevealedProviderId] = useState<string | null>(null);
  const [revealingKey, setRevealingKey] = useState(false);
  const revealedKey = useRef<string | null>(null);
  const localRef = useRef<LlmConfig | null>(null);
  const acceptedProviders = useRef<LlmProviderConfig[] | undefined>(undefined);
  localRef.current = local;
  useEffect(() => {
    if (!config?.llm) return;
    const next = cloneLlmConfig(config.llm);
    const providers = next.providers ?? [];
    const currentProviders = localRef.current?.providers?.map((provider) => provider.id === revealedProviderId && provider.apiKey === revealedKey.current
      ? { ...provider, apiKey: '***' } : provider);
    // An unrelated draft update must not erase unsaved provider edits. A
    // successful staging/save is allowed to refresh the matching form.
    if (currentProviders && acceptedProviders.current
      && JSON.stringify(currentProviders) !== JSON.stringify(acceptedProviders.current)
      && JSON.stringify(currentProviders) !== JSON.stringify(providers)) return;
    acceptedProviders.current = providers;
    setLocal(next);
    setSelectedProviderId((current) => (
      providers.some((provider) => provider.id === current)
        ? current
        : next.activeProviderId ?? providers[0]?.id ?? ''
    ));
    setShowKey(false);
    setRevealedProviderId(null);
    revealedKey.current = null;
    // Only changes to profiles can refresh this editor; other draft fields
    // must not reset a partially entered provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.llm.providers]);

  const providers = local?.providers ?? [];
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId)
    ?? providers[0];

  useSettingsForm('md-provider', () => {
    if (!local || !config) return null;
    const safeProviders = providers.map((provider) => provider.id === revealedProviderId && provider.apiKey === revealedKey.current
      ? { ...provider, apiKey: '***' } : provider);
    const profilesChanged = JSON.stringify(safeProviders) !== JSON.stringify(config.llm.providers ?? []);
    if (!profilesChanged) return null;
    if (providers.some((p) => p.models.some((m) =>
      (m.contextWindow !== undefined && (!Number.isInteger(m.contextWindow) || m.contextWindow < 1024))
      || (m.maxTokens !== undefined && (!Number.isInteger(m.maxTokens) || m.maxTokens < 1))
      || (m.maxTokens !== undefined && m.contextWindow !== undefined && m.maxTokens > m.contextWindow)))) {
      throw new Error('模型提供商：上下文窗口须为不小于 1024 的整数，最大输出须为正整数且不超过上下文窗口');
    }
    return {
      llm: { providers: safeProviders },
    };
  });

  if (!local) return null;

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
    updateProvider(providerId, (provider) => provider.apiKey === revealedKey.current ? { ...provider, apiKey: '***' } : provider);
    revealedKey.current = null;
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
      revealedKey.current = apiKey;
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
    const remaining = providers.filter((item) => item.id !== provider.id);
    const nextSelected = remaining[0];
    setLocal((current) => {
      if (!current) return current;
      const wasActive = current.activeProviderId === provider.id;
      return {
        ...current,
        providers: remaining,
        activeProviderId: wasActive ? nextSelected?.id : current.activeProviderId,
        activeModelId: wasActive
          ? (nextSelected?.defaultModelId ?? nextSelected?.models[0]?.id)
          : current.activeModelId,
      };
    });
    setSelectedProviderId(nextSelected?.id ?? '');
    setShowKey(false);
    setRevealedProviderId(null);
  };

  const addModel = (provider: LlmProviderConfig) => {
    const model: LlmModelPreset = {
      id: uniqueId('model', provider.models.map((item) => item.id)),
      name: `模型 ${provider.models.length + 1}`,
      openAiModel: '',
      enabled: true,
      contextWindow: NEW_PRESET_CONTEXT_WINDOW,
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

  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 basis-56 items-start gap-2">
            <Server className="w-4 h-4 mt-0.5 shrink-0 text-seal" />
            <div>
              <h2 className="text-base font-kai font-medium text-ink">模型提供商与预设</h2>
              <p className="mt-0.5 text-xs text-ink-faint">
                提供商保存连接与密钥，模型预设保存模型代码与运行参数；Agent、标准库构建与原始文档整理可直接使用。
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={addProvider}>
              <Plus className="w-3.5 h-3.5" />
              添加提供商
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardBody className="space-y-4">
        <div className="rounded-md border border-jade/30 bg-jade/5 px-3 py-2.5 text-xs text-ink-soft">
          <p>
            配置仅保存在本应用。支持 OpenAI Chat Completions、Responses 和 Anthropic；也可在「Agent 标准库 → 运行时与模型」切换为本地 Pi 配置。
          </p>
        </div>

        {providers.length === 0 ? (
          <div className="rounded-md border border-dashed border-line px-4 py-6 text-center">
            <Server className="mx-auto h-6 w-6 text-ink-faint" />
            <p className="mt-2 text-sm text-ink-soft">尚未配置远程模型提供商</p>
            <p className="mt-1 text-xs text-ink-faint">添加后即可为 Agent、标准库构建与原始文档整理选择模型。</p>
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
                  title="删除当前提供商"
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
                  placeholder="例如：公司网关"
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

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-ink">常规请求默认接口</legend>
                {(['openai', 'anthropic'] as const).map((kind) => <label key={kind} className="inline-flex items-center gap-1.5 mr-4 text-sm text-ink-soft">
                  <input type="radio" name="provider-default-interface" checked={(selectedProvider.protocol === 'anthropic-messages') === (kind === 'anthropic')}
                    onChange={() => updateProvider(selectedProvider.id, (provider) => {
                      const previous = provider.protocol ?? 'openai-completions';
                      const openAiProtocol = provider.openAiProtocol ?? (previous === 'openai-responses' ? 'openai-responses' : 'openai-completions');
                      const next = kind === 'anthropic' ? 'anthropic-messages' : openAiProtocol;
                      const urls = { ...provider.protocolBaseUrls, [previous]: provider.openAiCompatBaseUrl };
                      const other = openAiProtocol === 'openai-completions' ? 'openai-responses' : 'openai-completions';
                      return { ...provider, openAiProtocol, protocol: next, protocolBaseUrls: urls,
                        openAiCompatBaseUrl: urls[next] ?? (kind === 'openai' ? urls[other] : '') ?? '' };
                    })} />{kind === 'openai' ? 'OpenAI' : 'Anthropic'}
                </label>)}
              </fieldset>
              <div className="space-y-3 rounded-md border border-line p-3">
              <h3 className="text-sm font-medium text-ink">OpenAI</h3>
              <Select label="OpenAI 接口协议" value={selectedProvider.openAiProtocol ?? (selectedProvider.protocol === 'openai-responses' ? 'openai-responses' : 'openai-completions')} options={[
                { value: 'openai-completions', label: 'Chat Completions' },
                { value: 'openai-responses', label: 'Responses' },
              ]} onChange={(e) => {
                const next = e.target.value as 'openai-completions' | 'openai-responses';
                updateProvider(selectedProvider.id, (provider) => {
                  if (provider.protocol === 'anthropic-messages') return { ...provider, openAiProtocol: next };
                  const previous = provider.protocol ?? 'openai-completions';
                  const urls = { ...provider.protocolBaseUrls, [previous]: provider.openAiCompatBaseUrl };
                  return { ...provider, openAiProtocol: next, protocol: next, protocolBaseUrls: urls, openAiCompatBaseUrl: urls[next] ?? provider.openAiCompatBaseUrl };
                });
              }} helperText="选择 OpenAI 请求使用的协议。" />
              <Input label="OpenAI Base URL" type="url"
                value={(selectedProvider.protocol ?? 'openai-completions') !== 'anthropic-messages' ? selectedProvider.openAiCompatBaseUrl : selectedProvider.protocolBaseUrls?.[selectedProvider.openAiProtocol ?? 'openai-completions'] ?? selectedProvider.protocolBaseUrls?.['openai-completions'] ?? selectedProvider.protocolBaseUrls?.['openai-responses'] ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  updateProvider(selectedProvider.id, (provider) => ({ ...provider,
                    openAiCompatBaseUrl: provider.protocol === 'anthropic-messages' ? provider.openAiCompatBaseUrl : value,
                    protocolBaseUrls: { ...provider.protocolBaseUrls, 'openai-completions': value, 'openai-responses': value } }));
                }}
                placeholder="https://api.openai.com/v1"
                helperText="供 OpenAI Chat Completions 和 Responses 使用；具体协议由上方选择。" />
              </div>
              <div className="space-y-3 rounded-md border border-line p-3">
              <h3 className="text-sm font-medium text-ink">Anthropic</h3>
              <Input label="Anthropic Messages Base URL" type="url"
                value={selectedProvider.protocol === 'anthropic-messages' ? selectedProvider.openAiCompatBaseUrl : selectedProvider.protocolBaseUrls?.['anthropic-messages'] ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  updateProvider(selectedProvider.id, (provider) => ({ ...provider,
                    openAiCompatBaseUrl: provider.protocol === 'anthropic-messages' ? value : provider.openAiCompatBaseUrl,
                    protocolBaseUrls: { ...provider.protocolBaseUrls, 'anthropic-messages': value } }));
                }}
                placeholder="https://api.anthropic.com"
                helperText="Claude Code 使用此地址；留空表示不支持该协议。" />
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
                    <p className="mt-0.5 text-xs text-ink-faint">填写服务商的模型代码，并按需设置上下文窗口、输出上限与思考能力。</p>
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
                  options={selectedProvider.models.length ? selectedProvider.models.map((model) => ({
                    value: model.id,
                    label: `${model.name || model.id}${model.enabled ? '' : '（已停用）'}`,
                  })) : [{ value: '', label: '尚无模型预设' }]}
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
                            className="rounded p-1 text-ink-faint hover:bg-seal/10 hover:text-seal disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label={`删除模型预设 ${model.name || model.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        <Input
                          label="预设名称"
                          value={model.name}
                          onChange={(event) => updateModel(selectedProvider, model.id, { name: event.target.value })}
                          placeholder="例如：日常整理"
                        />
                        <Input
                          label="模型代码"
                          value={model.openAiModel}
                          onChange={(event) => updateModel(selectedProvider, model.id, { openAiModel: event.target.value, thinkingLevels: undefined })}
                          placeholder="填写服务商的模型代码"
                          helperText={/\bglm-[^\s[]+\[[^\]]+\]/i.test(model.openAiModel)
                            ? 'GLM API 请填写标准模型代码（例如 glm-5.2）；容量显示后缀会在运行时自动移除。'
                            : undefined}
                        />
                      </div>
                      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                        <Input label="上下文窗口（tokens）" type="number" min={1024} step={1} value={model.contextWindow ?? ''} placeholder="默认 128000"
                          onChange={(e) => updateModel(selectedProvider, model.id, { contextWindow: e.target.value ? Number(e.target.value) : undefined })} />
                        <Input label="最大输出（tokens）" type="number" min={1} value={model.maxTokens ?? ''} placeholder="默认 8192"
                          onChange={(e) => updateModel(selectedProvider, model.id, { maxTokens: e.target.value ? Number(e.target.value) : undefined })} />
                        <Toggle label="支持思考模式" checked={model.reasoning ?? false} onChange={(reasoning) => updateModel(selectedProvider, model.id, { reasoning })} />
                      </div>
                      {model.reasoning ? <div className="mt-3">
                        <p className="text-sm text-ink-soft">支持的思考档位</p>
                        <p className="mt-1 text-xs text-ink-faint">第三方模型未提供可验证的档位信息时，请根据服务商说明选择；关闭始终可用。</p>
                        <div className="mt-2 flex flex-wrap gap-3">
                          {(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((level) => <label key={level} className="flex items-center gap-1 text-xs text-ink-soft">
                            <input type="checkbox" checked={model.thinkingLevels?.includes(level) ?? false} onChange={(event) => updateModel(selectedProvider, model.id, {
                              thinkingLevels: event.target.checked ? [...(model.thinkingLevels ?? []).filter((item) => item !== level), level] : (model.thinkingLevels ?? []).filter((item) => item !== level),
                            })} />{level}
                          </label>)}
                        </div>
                      </div> : null}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        ) : null}

      </CardBody>
    </Card>
  );
}
