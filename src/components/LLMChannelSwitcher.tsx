/**
 * LLMChannelSwitcher - LLM 通道切换器（T7，04 §4.3，bigmodel 认知修正版）
 *
 * 认知修正（主上决策3 修订，2026-06-18）：统一使用 bigmodel GLM 作为唯一
 * LLM 提供商。claude CLI 通道走 bigmodel 的 Anthropic 兼容端点（/api/anthropic），
 * direct 通道走 bigmodel 的 OpenAI 兼容端点（/api/paas/v4）。两通道共用一份
 * bigmodel apiKey。
 *
 * 文案严禁出现 "deepseek" 字样（历史迁移说明除外），所有 UI 文本均使用
 * "bigmodel" 表述。
 *
 * 字段（与 server LlmConfig 严格对齐）：
 *   - openAiCompatBaseUrl（direct 端 base URL）
 *   - claudeCompatBaseUrl（claude-cli 端 base URL）
 *   - apiKey（共用一份）
 *   - model（默认模型别名）
 *   - directModel / claudeCliModel（bigmodel 双端点别名差异覆盖，可选）
 *   - temperature
 *   - claudeCli: { claudePath?, extraArgs? }
 *   - primaryChannel: 'claude-cli' | 'direct'
 *   - fallbackOnFailure: boolean
 *
 * 大模型别名差异说明：bigmodel 的 OpenAI paas/v4 端点接受 glm-4-flash/glm-4.5，
 * 而 Anthropic /api/anthropic 端点接受 glm-5.2[1m] 等别名。故提供 channel-specific
 * 覆盖字段。详见 server/src/modules/content-backend.ts LlmConfig 注释。
 */

import { useEffect, useState } from 'react';
import { Sparkles, Zap, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { Button } from './common/Button';
import { Input, Range, Toggle } from './common/Input';
import { ChannelConnectivityTester } from './ChannelConnectivityTester';
import { useConfig } from '../hooks/useConfig';
import { useToast } from './common/Toast';
import type { Config, LlmConfig, ChannelName } from '../types';

const BIGMODEL_OPEN_DEFAULT = 'https://open.bigmodel.cn/api/paas/v4';
const BIGMODEL_ANTHROPIC_DEFAULT = 'https://open.bigmodel.cn/api/anthropic';

const CHANNEL_LABEL: Record<ChannelName, string> = {
  'claude-cli': 'claude CLI 通道（bigmodel Anthropic 兼容端点）',
  'direct': 'direct 通道（bigmodel OpenAI 兼容端点）',
};

export function LLMChannelSwitcher() {
  const { config, saving, updateConfig } = useConfig();
  const toast = useToast();
  const [local, setLocal] = useState<LlmConfig | null>(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (config?.llm) setLocal(config.llm);
  }, [config]);

  if (!config || !local) return null;
  const cur: LlmConfig = { ...local };

  const set = <K extends keyof LlmConfig>(k: K, v: LlmConfig[K]) => {
    setLocal((p) => (p ? { ...p, [k]: v } : p));
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
      // Persist the whole llm shape; server ConfigManager normalizes.
      const next: Partial<Config> = { llm: cur };
      await updateConfig(next);
      toast.push({ type: 'success', message: 'LLM 配置已保存' });
    } catch (err) {
      toast.push({ type: 'error', message: '保存失败', hint: err instanceof Error ? err.message : '' });
    }
  };

  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <Sparkles className="w-4 h-4 text-seal" />
          <h2 className="text-base font-kai font-medium text-ink">LLM 通道（bigmodel GLM）</h2>
        </div>
      </CardHeader>

      <CardBody className="space-y-4">
        {/* Cognitive-correction banner */}
        <div className="p-3 rounded-md border border-jade/30 bg-jade/5 text-xs text-ink-soft">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-jade shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-ink">说明：双通道共用一份 bigmodel 配置</p>
              <p className="mt-1">
                claude CLI 通道走 bigmodel 的 Anthropic 兼容端点（<code className="font-mono text-jade">/api/anthropic</code>），
                direct 通道走 bigmodel 的 OpenAI 兼容端点（<code className="font-mono text-jade">/api/paas/v4</code>），
                共用同一份 bigmodel apiKey。如需迁移历史 deepseek 配置，应用启动时会自动迁移。
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
                  claude CLI（推荐，主通道）
                </span>
                <span className="block text-[11px] text-ink-faint mt-0.5">
                  spawn <code className="font-mono">claude -p</code>，env 注入 bigmodel Anthropic 端点；具备 agent 能力，单次调用约 60-75s
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
                  OpenAI SDK 直连 bigmodel paas/v4 端点；轻量快速，单次调用约 2-3s
                </span>
              </span>
            </label>
          </div>
        </div>

        <Toggle
          label="主通道失败自动降级"
          checked={cur.fallbackOnFailure}
          onChange={(v) => set('fallbackOnFailure', v)}
          helperText="主通道超时/错误时自动切换到另一通道"
        />

        {/* bigmodel shared config */}
        <div className="pt-3 border-t border-line space-y-3">
          <p className="text-sm font-medium text-ink-soft font-serif">bigmodel 配置（两通道共用）</p>

          <Input
            label="direct 通道 Base URL（OpenAI 兼容）"
            type="url"
            value={cur.openAiCompatBaseUrl}
            onChange={(e) => set('openAiCompatBaseUrl', e.target.value)}
            placeholder={BIGMODEL_OPEN_DEFAULT}
            helperText="bigmodel OpenAI 兼容端点"
          />

          <Input
            label="claude CLI 通道 Base URL（Anthropic 兼容）"
            type="url"
            value={cur.claudeCompatBaseUrl}
            onChange={(e) => set('claudeCompatBaseUrl', e.target.value)}
            placeholder={BIGMODEL_ANTHROPIC_DEFAULT}
            helperText="bigmodel Anthropic 兼容端点（claude CLI 通过 env 注入）"
          />

          <div>
            <label className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">API Key（两通道共用）</label>
            <div className="relative">
              <Input
                fullWidth
                type={showKey ? 'text' : 'password'}
                value={cur.apiKey}
                onChange={(e) => set('apiKey', e.target.value)}
                placeholder="<id>.<secret>"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
                aria-label={showKey ? '隐藏密钥' : '显示密钥'}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-seal-2">
              含明文密钥；请勿将 config.json 提交到公共仓库。
            </p>
          </div>

          <Input
            label="默认模型别名"
            type="text"
            value={cur.model}
            onChange={(e) => set('model', e.target.value)}
            placeholder="glm-4-flash"
            helperText="两通道共用别名；如需分别覆盖，使用下方字段"
          />

          {/* Optional channel-specific overrides */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              label="direct 模型覆盖（可选）"
              type="text"
              value={cur.directModel ?? ''}
              onChange={(e) => set('directModel', e.target.value || undefined)}
              placeholder="glm-4-flash / glm-4.5"
              helperText="bigmodel paas/v4 端可用别名"
            />
            <Input
              label="claude-cli 模型覆盖（可选）"
              type="text"
              value={cur.claudeCliModel ?? ''}
              onChange={(e) => set('claudeCliModel', e.target.value || undefined)}
              placeholder="glm-5.2[1m]"
              helperText="bigmodel /api/anthropic 端可用别名"
            />
          </div>

          <Range
            label="温度（temperature）"
            min="0"
            max="1"
            step="0.1"
            value={String(cur.temperature ?? 0.2)}
            onChange={(e) => set('temperature', parseFloat(e.target.value) || 0.2)}
            helperText="低温度更聚焦，高温度更有创造性"
          />
        </div>

        {/* claude CLI process control */}
        <div className="pt-3 border-t border-line space-y-3">
          <p className="text-sm font-medium text-ink-soft font-serif">claude CLI 进程控制（可选）</p>
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
            placeholder="留空则使用系统 PATH"
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
