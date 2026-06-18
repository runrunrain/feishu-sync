/**
 * ChannelConnectivityTester - 当前通道连通性测试（T7，决策3：真实调 bigmodel）
 *
 * 测试当前选中通道（claude-cli / direct），发送极短 hello 请求，
 * 3s 超时，结果 Toast 反馈（成功 jade / 失败 seal-2，详情入日志不展开堆栈）。
 *
 * 调用 POST /api/llm/test-channel，后端真实执行：
 *   - claude-cli 通道：spawn `claude -p "hello"`，env 注入 bigmodel Anthropic
 *   - direct 通道：POST bigmodel paas/v4 chat/completions
 * 两通道共用同一份 bigmodel apiKey。
 *
 * 【阻塞说明】后端 server 截至当前未实现 /api/llm/test-channel 路由。
 * 前端按预期契约实现；缺失端点时 Toast 提示并保留按钮可重试。
 */

import { useState } from 'react';
import { Zap, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Button } from './common/Button';
import { useToast } from './common/Toast';
import { appLogger } from '../utils/appLogger';
import { testLlmChannel, APIError } from '../api/client';
import type { ChannelName, ChannelTestRequest, LlmConfig } from '../types';

interface ChannelConnectivityTesterProps {
  channel: ChannelName;
  llm: Pick<
    LlmConfig,
    | 'openAiCompatBaseUrl'
    | 'claudeCompatBaseUrl'
    | 'apiKey'
    | 'model'
    | 'directModel'
    | 'claudeCliModel'
    | 'temperature'
  >;
  claudeCli?: { claudePath?: string; extraArgs?: string[] };
}

const CHANNEL_TEXT: Record<ChannelName, string> = {
  'claude-cli': 'claude CLI 通道（spawn claude -p）',
  'direct': 'direct 通道（OpenAI SDK 直连）',
};

export function ChannelConnectivityTester({ channel, llm, claudeCli }: ChannelConnectivityTesterProps) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const toast = useToast();

  const handleTest = async () => {
    setStatus('testing');
    setErrorText(null);
    setDurationMs(null);

    const body: ChannelTestRequest = {
      channel,
      llm: {
        openAiCompatBaseUrl: llm.openAiCompatBaseUrl,
        claudeCompatBaseUrl: llm.claudeCompatBaseUrl,
        apiKey: llm.apiKey,
        model: llm.model,
        directModel: llm.directModel,
        claudeCliModel: llm.claudeCliModel,
        temperature: llm.temperature,
      },
      claudeCli,
    };

    appLogger.info('channel-test', `testing ${channel}`, { hasKey: !!llm.apiKey });

    try {
      const res = await testLlmChannel(body);
      setDurationMs(res.durationMs);
      if (res.success) {
        setStatus('ok');
        toast.push({
          type: 'success',
          message: `${CHANNEL_TEXT[channel]}连通正常`,
          hint: `用时 ${(res.durationMs / 1000).toFixed(1)}s · 模型 ${res.model}`,
        });
        appLogger.info('channel-test', `${channel} ok`, { durationMs: res.durationMs, tokens: res.tokensUsed });
      } else {
        setStatus('fail');
        setErrorText(res.error ?? '未知错误');
        toast.push({
          type: 'error',
          message: `${CHANNEL_TEXT[channel]}连通失败`,
          hint: res.error ?? '错误详情见日志',
        });
        appLogger.error('channel-test', `${channel} failed`, res.error);
      }
    } catch (err) {
      const missing =
        err instanceof APIError && (err.statusCode === 404 || err.statusCode === 405);
      setStatus('fail');
      if (missing) {
        setErrorText('后端尚未实现 /api/llm/test-channel 路由');
        toast.push({
          type: 'warning',
          message: '后端尚未实现测试端点',
          hint: '请联系开发者补充 /api/llm/test-channel 路由',
        });
        appLogger.warn('channel-test', 'endpoint missing');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorText(msg);
        toast.push({
          type: 'error',
          message: `${CHANNEL_TEXT[channel]}连通失败`,
          hint: msg,
        });
        appLogger.error('channel-test', 'unexpected error', err);
      }
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-ink-soft font-serif">测试当前通道连通性</p>
          <p className="text-[11px] text-ink-faint mt-0.5">
            真实发送极短 hello 请求（约 1k token，3s 超时）验证连通。
            当前通道：<span className="text-seal font-sans-ui">{CHANNEL_TEXT[channel]}</span>
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleTest}
          loading={status === 'testing'}
          disabled={status === 'testing' || !llm.apiKey}
        >
          {status === 'testing' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Zap className="w-3.5 h-3.5" />
          )}
          测试当前通道
        </Button>
      </div>

      {!llm.apiKey && (
        <p className="text-[11px] text-seal-2">
          请先填写 bigmodel apiKey 后再测试
        </p>
      )}

      {status === 'ok' && durationMs != null && (
        <div className="flex items-center gap-2 text-xs text-jade">
          <CheckCircle2 className="w-3.5 h-3.5" />
          连通正常 · 用时 {(durationMs / 1000).toFixed(1)}s
        </div>
      )}

      {status === 'fail' && (
        <div className="flex items-start gap-2 text-xs text-seal-2">
          <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="break-words">{errorText ?? '连通失败 · 错误详情见日志'}</span>
        </div>
      )}
    </div>
  );
}
