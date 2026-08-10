/**
 * LLMChannelSwitcher - document-organisation execution routing.
 *
 * Provider endpoints, credentials and protocol-specific model aliases live
 * in ModelProviderSettings. This card chooses which local/remote execution
 * channel runs during sync and which saved remote provider preset is active.
 */

import { useEffect, useState } from 'react';
import { Sparkles, Zap, AlertCircle, Layers3, RefreshCw, Terminal } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { Button } from './common/Button';
import { Input, Range, Select, Toggle } from './common/Input';
import { ChannelConnectivityTester } from './ChannelConnectivityTester';
import { OpenCodeSetupCard } from './OpenCodeSetupCard';
import { ClaudeCodeSetupCard } from './ClaudeCodeSetupCard';
import { useConfig } from '../hooks/useConfig';
import { useToast } from './common/Toast';
import type { LlmConfig, ChannelName } from '../types';

const CHANNEL_LABEL: Record<ChannelName, string> = {
  'claude-cli': 'Claude Code 无头通道（Anthropic 兼容）',
  'direct': 'direct 通道（OpenAI 兼容）',
  'opencode': 'OpenCode 本地无头通道',
};

export function LLMChannelSwitcher() {
  const { config, saving, updateConfig, refresh } = useConfig();
  const toast = useToast();
  const [local, setLocal] = useState<LlmConfig | null>(null);

  useEffect(() => {
    if (config?.llm) setLocal(config.llm);
  }, [config]);

  if (!config || !local) return null;
  const cur: LlmConfig = { ...local };

  const set = <K extends keyof LlmConfig>(k: K, v: LlmConfig[K]) => {
    setLocal((p) => (p ? { ...p, [k]: v } : p));
  };

  const enabledProviders = (cur.providers ?? []).filter((provider) => provider.enabled);
  const activeProvider = enabledProviders.find((provider) => provider.id === cur.activeProviderId)
    ?? enabledProviders[0];
  const enabledModels = activeProvider?.models.filter((model) => model.enabled) ?? [];
  const activeModel = enabledModels.find((model) => model.id === cur.activeModelId)
    ?? enabledModels.find((model) => model.id === activeProvider?.defaultModelId)
    ?? enabledModels[0];

  const setActiveProvider = (providerId: string) => {
    const provider = enabledProviders.find((item) => item.id === providerId);
    if (!provider) return;
    const model = provider.models.find((item) => item.enabled && item.id === provider.defaultModelId)
      ?? provider.models.find((item) => item.enabled)
      ?? provider.models[0];
    setLocal((current) => current ? {
      ...current,
      activeProviderId: provider.id,
      activeModelId: model?.id,
    } : current);
  };

  const setActiveModel = (modelId: string) => {
    setLocal((current) => current ? { ...current, activeModelId: modelId } : current);
  };

  const handlePrimary = (channel: ChannelName) => {
    set('primaryChannel', channel);
    toast.push({
      type: 'info',
      message: `已切换主通道：${CHANNEL_LABEL[channel]}`,
      hint: '下次同步生效',
    });
  };

  const handleSave = async () => {
    try {
      // This card owns execution routing, not provider/profile CRUD. Keep
      // the payload narrow so it cannot overwrite a profile edit made in the
      // sibling provider card before its own useConfig instance refreshes.
      const next = {
        llm: {
          primaryChannel: cur.primaryChannel,
          fallbackOnFailure: cur.fallbackOnFailure,
          contentAdaptationEnabled: cur.contentAdaptationEnabled,
          temperature: cur.temperature,
          timeoutMs: cur.timeoutMs,
          activeProviderId: cur.activeProviderId,
          activeModelId: cur.activeModelId,
          claudeCli: cur.claudeCli,
          opencode: cur.opencode,
        },
      };
      await updateConfig(next);
      toast.push({ type: 'success', message: 'LLM 配置已保存' });
    } catch (err) {
      toast.push({ type: 'error', message: '保存失败', hint: err instanceof Error ? err.message : '' });
    }
  };

  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-4 h-4 text-seal" />
            <h2 className="text-base font-kai font-medium text-ink">文档整理通道</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={saving}>
            <RefreshCw className="h-3.5 w-3.5" />
            重新读取
          </Button>
        </div>
      </CardHeader>

      <CardBody className="space-y-4">
        <div className="p-3 rounded-md border border-jade/30 bg-jade/5 text-xs text-ink-soft">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-jade shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-ink">说明：提供商、模型与执行通道分开配置</p>
              <p className="mt-1">
                此处选择同步整理时如何执行；上方“模型提供商与预设”决定远程调用的 API Key、端点和模型别名。
                OpenCode 在当前提供商已配置密钥时，仅为本次无头进程临时注入配置，不会写入 OpenCode 本机文件。
              </p>
            </div>
          </div>
        </div>

        {/* Channel radios */}
        <div>
          <p className="text-sm font-medium text-ink-soft mb-2 font-serif">主通道选择</p>
          <div className="space-y-2">
            <label
              className={`flex items-start gap-2.5 p-3 rounded-md border cursor-pointer transition-colors ${
                cur.primaryChannel === 'claude-cli'
                  ? 'border-seal bg-seal/5'
                  : 'border-line bg-card-bg hover:bg-paper-2'
              }`}
            >
              <input
                type="radio"
                name="primaryChannel"
                className="mt-1"
                checked={cur.primaryChannel === 'claude-cli'}
                onChange={() => handlePrimary('claude-cli')}
              />
              <span className="flex-1">
                <span className="flex items-center gap-1.5 text-sm text-ink">
                  <Sparkles className="w-3.5 h-3.5 text-seal" />
                  Claude Code 无头模式
                </span>
                <span className="block text-[11px] text-ink-faint mt-0.5">
                  spawn <code className="font-mono">claude -p</code>；Z.AI 使用隔离的无头环境与其 Anthropic 兼容鉴权，不执行工具
                </span>
              </span>
            </label>

            <label
              className={`flex items-start gap-2.5 p-3 rounded-md border cursor-pointer transition-colors ${
                cur.primaryChannel === 'direct'
                  ? 'border-seal bg-seal/5'
                  : 'border-line bg-card-bg hover:bg-paper-2'
              }`}
            >
              <input
                type="radio"
                name="primaryChannel"
                className="mt-1"
                checked={cur.primaryChannel === 'direct'}
                onChange={() => handlePrimary('direct')}
              />
              <span className="flex-1">
                <span className="flex items-center gap-1.5 text-sm text-ink">
                  <Zap className="w-3.5 h-3.5 text-jade" />
                  direct（直连，备选）
                </span>
                <span className="block text-[11px] text-ink-faint mt-0.5">
                  OpenAI SDK 直连当前提供商的 OpenAI 兼容端点；适合轻量、快速的整理任务
                </span>
              </span>
            </label>

            <label
              className={`flex items-start gap-2.5 p-3 rounded-md border cursor-pointer transition-colors ${
                cur.primaryChannel === 'opencode'
                  ? 'border-seal bg-seal/5'
                  : 'border-line bg-card-bg hover:bg-paper-2'
              }`}
            >
              <input
                type="radio"
                name="primaryChannel"
                className="mt-1"
                checked={cur.primaryChannel === 'opencode'}
                onChange={() => handlePrimary('opencode')}
              />
              <span className="flex-1">
                <span className="flex items-center gap-1.5 text-sm text-ink">
                  <Terminal className="w-3.5 h-3.5 text-jade" />
                  OpenCode（本机无头整理）
                </span>
                <span className="block text-[11px] text-ink-faint mt-0.5">
                  使用隔离的本机 OpenCode 无头进程；正文通过受限临时附件传入，不会写入命令行参数或读取用户的 OpenCode 配置
                </span>
              </span>
            </label>
          </div>
        </div>

        <Toggle
          label="主通道失败自动降级"
          checked={cur.fallbackOnFailure}
          onChange={(v) => set('fallbackOnFailure', v)}
          disabled={cur.primaryChannel === 'opencode'}
          helperText={cur.primaryChannel === 'opencode'
            ? 'OpenCode 失败时不会自动转发到远程通道，会保留确定性格式重建结果'
            : '主通道超时/错误时自动切换到另一通道'}
        />

        <Toggle
          label="同步时整理 Markdown 正文"
          checked={cur.contentAdaptationEnabled === true}
          onChange={(v) => set('contentAdaptationEnabled', v)}
          helperText="默认关闭；开启后才会在每篇同步文档完成格式重建后调用当前主通道"
        />

        <div className="space-y-3 border-t border-line pt-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-soft font-serif">
            <Layers3 className="h-4 w-4 text-jade" />
            当前远程模型
          </div>
          {enabledProviders.length === 0 ? (
            <p className="rounded-md border border-seal/30 bg-seal/5 p-3 text-xs text-seal-2">
              没有启用的模型提供商。请先在上方“模型提供商与预设”添加或启用一个提供商；本机 OpenCode 不受影响。
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Select
                label="提供商"
                value={activeProvider?.id ?? ''}
                onChange={(event) => setActiveProvider(event.target.value)}
                options={enabledProviders.map((provider) => ({
                  value: provider.id,
                  label: provider.name || provider.id,
                }))}
                helperText="用于 direct 与 Claude Code 无头模式"
              />
              <Select
                label="模型预设"
                value={activeModel?.id ?? ''}
                onChange={(event) => setActiveModel(event.target.value)}
                options={enabledModels.map((model) => ({
                  value: model.id,
                  label: model.name || model.id,
                }))}
                disabled={enabledModels.length === 0}
                helperText={enabledModels.length === 0
                  ? '当前提供商没有启用的模型预设'
                  : `direct：${activeModel?.openAiModel || '未设置'} · Claude Code：${activeModel?.claudeCliModel || '未设置'}${/^(?:glm-5\.2)$/i.test(activeModel?.claudeCliModel ?? '') && /(?:bigmodel\.cn|z\.ai)/i.test(`${activeProvider?.openAiCompatBaseUrl ?? ''} ${activeProvider?.claudeCompatBaseUrl ?? ''}`) ? '（运行时使用 glm-4.7）' : ''}`}
              />
            </div>
          )}

          <Range
            label="温度（temperature）"
            min="0"
            max="1"
            step="0.1"
            value={String(cur.temperature ?? 0.2)}
            onChange={(event) => set('temperature', parseFloat(event.target.value) || 0.2)}
            helperText="适用于当前远程通道；低温度更聚焦，高温度更有创造性"
          />
          <Input
            label="单篇整理最长等待时间（分钟）"
            type="number"
            min="1"
            max="15"
            step="1"
            value={String(Math.max(1, Math.min(15, Math.round((cur.timeoutMs ?? 600_000) / 60_000))))}
            onChange={(event) => {
              const minutes = Number.parseInt(event.target.value, 10);
              if (!Number.isFinite(minutes)) return;
              set('timeoutMs', Math.max(1, Math.min(15, minutes)) * 60_000);
            }}
            helperText="默认 10 分钟。大模型在排队、长推理或整理较长文档时可能需要数分钟；仅在超过此时间后才判定超时。"
          />
        </div>

        {/* OpenCode process control */}
        <div className="pt-3 border-t border-line space-y-3">
          <p className="text-sm font-medium text-ink-soft font-serif">OpenCode 本机无头模式</p>
          <OpenCodeSetupCard />
          <Input
            label="OpenCode 可执行文件绝对路径（可选）"
            type="text"
            value={cur.opencode?.executablePath ?? ''}
            onChange={(e) => {
              const next = { ...cur.opencode ?? {} };
              if (e.target.value.trim()) next.executablePath = e.target.value.trim();
              else delete next.executablePath;
              set('opencode', Object.keys(next).length > 0 ? next : undefined);
            }}
            placeholder="留空则自动检测 PATH、登录 shell 和全局 npm"
            helperText="保存后点击“检查安装”会按该路径优先验证；必须是绝对路径"
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              label="OpenCode 模型（可选）"
              type="text"
              value={cur.opencode?.model ?? ''}
              onChange={(e) => {
                const next = { ...cur.opencode ?? {} };
                if (e.target.value.trim()) next.model = e.target.value.trim();
                else delete next.model;
                set('opencode', Object.keys(next).length > 0 ? next : undefined);
              }}
              placeholder="glm-5.2；留空则从当前提供商推导"
              helperText="填写模型 ID；智谱 Coding Plan 会使用 OpenCode 原生适配器，其他兼容端点使用临时提供商；均不写入 OpenCode 本机配置"
            />
            <Input
              label="OpenCode agent（可选）"
              type="text"
              value={cur.opencode?.agent ?? ''}
              onChange={(e) => {
                const next = { ...cur.opencode ?? {} };
                if (e.target.value.trim()) next.agent = e.target.value.trim();
                else delete next.agent;
                set('opencode', Object.keys(next).length > 0 ? next : undefined);
              }}
              placeholder="留空用 OpenCode 默认 agent"
            />
          </div>
        </div>

        {/* claude CLI process control */}
        <div className="pt-3 border-t border-line space-y-3">
          <p className="text-sm font-medium text-ink-soft font-serif">Claude Code 无头模式</p>
          <ClaudeCodeSetupCard />
          <Input
            label="claude 可执行文件路径"
            type="text"
            value={cur.claudeCli?.claudePath ?? ''}
            onChange={(e) => {
              const next = { ...cur.claudeCli ?? {} };
              if (e.target.value) next.claudePath = e.target.value;
              else delete next.claudePath;
              set('claudeCli', Object.keys(next).length > 0 ? next : undefined);
            }}
            placeholder="留空则自动检测 PATH、常见 npm 安装目录"
          />
          <Input
            label="附加 CLI 参数（空格分隔）"
            type="text"
            value={(cur.claudeCli?.extraArgs ?? []).join(' ')}
            onChange={(e) => {
              const args = e.target.value.trim() ? e.target.value.trim().split(/\s+/) : [];
              const next = { ...cur.claudeCli ?? {} };
              if (args.length > 0) next.extraArgs = args;
              else delete next.extraArgs;
              set('claudeCli', Object.keys(next).length > 0 ? next : undefined);
            }}
            placeholder="--max-turns 1"
          />
        </div>

        {/* Connectivity tester */}
        <div className="pt-3 border-t border-line">
          <ChannelConnectivityTester
            channel={cur.primaryChannel}
            llm={cur}
            claudeCli={cur.claudeCli}
            opencode={cur.opencode}
          />
        </div>

        <div className="flex justify-end pt-2 border-t border-line">
          <Button onClick={handleSave} loading={saving}>
            保存
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
