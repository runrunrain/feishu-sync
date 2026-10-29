/**
 * VisionChannel — 图片理解直连通道（设计 §3.2，S2）
 *
 * 与 DirectChannel 同构但独立实现：按 ModelSelection 换 provider/模型、
 * 三协议（openai-completions / openai-responses / anthropic-messages）
 * SDK 直连、超时与错误分类。差异面：
 *   - 输入是「图片字节 + 提示词」（多模态 content 块），无风格 few-shot；
 *   - 不做流式（描述生成无需增量）；
 *   - 与原文整理通道（DirectChannel）互不影响——不 import / 不修改其本体，
 *     仅复用共享的 resolveActiveLlmConfig 与 model-selection 纯函数，
 *     耦合评估：请求体构造协议差异大（image 块 vs 纯文本 prompt + 流式
 *     事件机），抽共享层收益低于耦合成本，S2 维持独立实现。
 *
 * 契约（沿 DirectChannel 的 finishReason 模式思想）：describe() 永不抛
 * 异常——配置缺失/网络失败/超时一律返回 { finishReason: 'error'|'timeout' }
 * 结果对象，由调用方（VisionDescriber → 构建链）决定兜底；错误消息一律
 * 脱敏 apiKey（split-join 技法与 direct-channel 一致）。
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { anthropicClientAuth, providerModelParameters, type ModelSelection } from '../../modules/model-selection.js';
import { resolveActiveLlmConfig, type LlmConfig } from '../../modules/content-backend.js';

export type VisionImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface VisionRequest {
  bytes: Buffer;
  mime: VisionImageMime;
  prompt: string;
}

export type VisionFinishReason = 'stop' | 'length' | 'error' | 'timeout';

export interface VisionResult {
  text: string;
  finishReason: VisionFinishReason;
  /** 实际生效的模型别名（provider 预设的 openAiModel） */
  model: string;
  latencyMs: number;
  errorMessage?: string;
}

export interface VisionCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export class VisionChannel {
  private readonly llm: LlmConfig;
  private openai: OpenAI | null = null;
  private anthropic: Anthropic | null = null;
  private cachedKey: string | null = null;
  private cachedBaseUrl: string | null = null;

  constructor(llm: LlmConfig, selection: ModelSelection = {}) {
    const resolved = resolveActiveLlmConfig(llm, selection);
    this.llm = { ...resolved, ...providerModelParameters(resolved, selection) };
  }

  /** 单图描述。永不抛异常；apiKey 出现在任何错误消息前先脱敏。 */
  async describe(req: VisionRequest, opts: VisionCallOptions): Promise<VisionResult> {
    const startedAt = Date.now();
    const model = this.llm.directModel || this.llm.model;
    const error = (message: string, finishReason: VisionFinishReason): VisionResult => ({
      text: '',
      finishReason,
      model,
      latencyMs: Date.now() - startedAt,
      errorMessage: `VisionChannel: ${this.redact(message)}`,
    });

    // 配置缺失时跳过网络调用，立即返回配置错误（与 DirectChannel 一致）
    if (!this.llm.apiKey) return error('apiKey is empty', 'error');
    if (!this.llm.openAiCompatBaseUrl) return error('openAiCompatBaseUrl is empty', 'error');
    if (!model) return error('no model is selected for the active provider', 'error');
    if (!req.prompt.trim()) return error('prompt is empty', 'error');
    if (!req.bytes?.length) return error('image bytes are empty', 'error');

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const base64 = req.bytes.toString('base64');
      const dataUrl = `data:${req.mime};base64,${base64}`;
      const protocol = this.llm.protocol ?? 'openai-completions';
      const maxTokens = this.llm.maxTokens ?? 2048;
      const temperature = this.llm.temperature ?? 0.2;
      if (protocol === 'anthropic-messages') {
        const response = await this.getAnthropic().messages.create(
          {
            model,
            max_tokens: maxTokens,
            temperature,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: req.prompt },
                { type: 'image', source: { type: 'base64', media_type: req.mime, data: base64 } },
              ],
            }],
          },
          { signal: controller.signal },
        );
        const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
        return {
          text,
          finishReason: response.stop_reason === 'max_tokens' ? 'length' : 'stop',
          model,
          latencyMs: Date.now() - startedAt,
        };
      }
      if (protocol === 'openai-responses') {
        const response = await this.getOpenAI().responses.create(
          {
            model,
            max_output_tokens: maxTokens,
            input: [{
              role: 'user',
              content: [
                { type: 'input_text', text: req.prompt },
                { type: 'input_image', image_url: dataUrl, detail: 'auto' },
              ],
            }],
          },
          { signal: controller.signal },
        );
        if (response.status === 'failed') {
          return error(response.error?.message ?? 'Responses request failed', 'error');
        }
        if (response.status === 'incomplete' && response.incomplete_details?.reason !== 'max_output_tokens') {
          return error(`Responses incomplete: ${response.incomplete_details?.reason ?? 'unknown'}`, 'error');
        }
        return {
          text: response.output_text,
          finishReason: response.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop',
          model,
          latencyMs: Date.now() - startedAt,
        };
      }
      // 默认 openai-completions
      const response = await this.getOpenAI().chat.completions.create(
        {
          model,
          temperature,
          max_tokens: maxTokens,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: req.prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          }],
        },
        { signal: controller.signal },
      );
      const raw: unknown = response.choices[0]?.message?.content;
      const text = typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? (raw as Array<{ type?: string; text?: string }>).filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
          : '';
      return {
        text,
        finishReason: response.choices[0]?.finish_reason === 'length' ? 'length' : 'stop',
        model,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      if (timedOut) {
        return error(`timed out after ${opts.timeoutMs}ms`, 'timeout');
      }
      if (opts.signal?.aborted) {
        return error('aborted by caller', 'error');
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      return error(`SDK call failed - ${rawMessage}`, 'error');
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** 错误消息脱敏：把 apiKey 全量替换为 ***（技法沿 direct-channel）。 */
  private redact(message: string): string {
    return this.llm.apiKey ? message.split(this.llm.apiKey).join('***') : message;
  }

  private getOpenAI(): OpenAI {
    if (this.openai && this.cachedKey === this.llm.apiKey && this.cachedBaseUrl === this.llm.openAiCompatBaseUrl) {
      return this.openai;
    }
    this.openai = new OpenAI({
      apiKey: this.llm.apiKey,
      baseURL: this.llm.openAiCompatBaseUrl,
      maxRetries: 0,
    });
    this.cachedKey = this.llm.apiKey;
    this.cachedBaseUrl = this.llm.openAiCompatBaseUrl;
    return this.openai;
  }

  private getAnthropic(): Anthropic {
    this.anthropic ??= new Anthropic({
      ...anthropicClientAuth(this.llm),
      baseURL: this.llm.openAiCompatBaseUrl,
      maxRetries: 0,
    });
    return this.anthropic;
  }
}
