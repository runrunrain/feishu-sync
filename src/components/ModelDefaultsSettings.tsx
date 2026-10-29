import { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import { useConfig } from '../hooks/useConfig';
import { useSettingsForm } from '../hooks/settingsDraft';
import { Card, CardBody, CardHeader } from './common/Card';
import { Select, Toggle } from './common/Input';

export function ModelDefaultsSettings() {
  const { config } = useConfig();
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [adaptationEnabled, setAdaptationEnabled] = useState(false);
  const activeProviderId = config?.llm.activeProviderId;
  const activeModelId = config?.llm.activeModelId;
  const contentAdaptationEnabled = config?.llm.contentAdaptationEnabled;

  useEffect(() => {
    setProviderId(activeProviderId ?? '');
    setModelId(activeModelId ?? '');
    setAdaptationEnabled(contentAdaptationEnabled === true);
  }, [activeProviderId, activeModelId, contentAdaptationEnabled]);

  useSettingsForm('md-defaults', () => {
    if (!config?.llm) return null;
    if (providerId === (config.llm.activeProviderId ?? '') && modelId === (config.llm.activeModelId ?? '') && adaptationEnabled === (config.llm.contentAdaptationEnabled === true)) return null;
    return { llm: { activeProviderId: providerId || undefined, activeModelId: modelId || undefined, contentAdaptationEnabled: adaptationEnabled } };
  });

  if (!config?.llm) return null;

  const providers = (config.llm.providers ?? []).filter((provider) => provider.enabled);
  const provider = providers.find((item) => item.id === providerId);
  const models = (provider?.models ?? []).filter((model) => model.enabled);

  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 basis-56 items-start gap-2">
            <Settings className="mt-0.5 h-4 w-4 shrink-0 text-seal" />
            <div>
              <h2 className="text-base font-kai font-medium text-ink">默认模型与文档整理</h2>
              <p className="mt-0.5 text-xs text-ink-faint">设置应用默认模型，以及同步时是否整理原始文档。</p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {providers.length === 0 ? (
          <p className="text-sm text-ink-soft">请先在「模型提供商与预设」中配置并启用提供商。</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select label="应用默认提供商" value={providerId} options={[
              ...(!provider ? [{ value: providerId, label: '请选择可用的提供商' }] : []),
              ...providers.map((item) => ({ value: item.id, label: item.name })),
            ]} onChange={(event) => {
              const next = providers.find((item) => item.id === event.target.value);
              setProviderId(event.target.value);
              setModelId(next?.models.find((model) => model.enabled && model.id === next.defaultModelId)?.id
                ?? next?.models.find((model) => model.enabled)?.id ?? '');
            }} />
            <Select label="应用默认模型预设" value={modelId} options={[
              ...(!models.some((model) => model.id === modelId) ? [{ value: modelId, label: '请选择可用的模型预设' }] : []),
              ...models.map((model) => ({ value: model.id, label: model.name })),
            ]} onChange={(event) => setModelId(event.target.value)} />
          </div>
        )}
        <Toggle label="同步时整理原始文档" ariaLabel="同步时整理原始文档" checked={adaptationEnabled}
          onChange={setAdaptationEnabled} helperText="使用相同的应用提供商与模型预设；整理失败时保留确定性转换结果。" />
      </CardBody>
    </Card>
  );
}
