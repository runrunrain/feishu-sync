import Anthropic from '@anthropic-ai/sdk';
import { providerModelParameters, type ModelSelection } from './model-selection.js';
/** Source document adaptation via the selected provider's native SDK protocol.
 * Preserves the DirectChannel contract, prompt, timeout and deterministic sync fallback.
 */

import OpenAI from 'openai';
import type {
  AdaptFinishReason,
  AdaptInput,
  AdaptOptions,
  AdaptOutput,
  ContentBackend,
  LlmConfig,
} from './content-backend.js';
import { resolveActiveLlmConfig } from './content-backend.js';

export class DirectChannel implements ContentBackend {
  readonly name = 'direct' as const;
  readonly supportsStreaming = true;

  /**
   * Cached OpenAI client; constructed lazily. Re-built if the apiKey or
   * baseUrl changes between calls (defensive against config hot-swap).
   */
  private client: OpenAI | null = null;
  private cachedKey: string | null = null;
  private cachedBaseUrl: string | null = null;

  private readonly llm: LlmConfig;
  private readonly thinking: ModelSelection['thinkingLevel'];
  private anthropic: Anthropic | null = null;

  constructor(llm: LlmConfig, selection?: ModelSelection) {
    // Provider profiles are resolved once per channel instance. Registries
    // are rebuilt for each sync, so this is both deterministic and avoids a
    // document in the same batch switching provider halfway through.
    const resolved = resolveActiveLlmConfig(llm, selection);
    this.llm = { ...resolved, ...providerModelParameters(resolved, selection) };
    this.thinking = selection?.thinkingLevel ?? 'off';
  }

  async adapt(input: AdaptInput): Promise<AdaptOutput> {
    const startedAt = Date.now();
    const options = this.resolveOptions(input.options);
    const prompt = this.buildPrompt(input.rawContent, input.localOldContent);

    // Skip the network call entirely when the channel is misconfigured;
    // this lets the orchestrator cleanly fall back to claude-cli without
    // waiting for a 401 from the server.
    if (!this.llm.apiKey) {
      return this.buildErrorOutput('DirectChannel: apiKey is empty', startedAt, 'error');
    }
    if (!this.llm.openAiCompatBaseUrl) {
      return this.buildErrorOutput(
        'DirectChannel: openAiCompatBaseUrl is empty',
        startedAt,
        'error'
      );
    }
    const model = this.llm.directModel || this.llm.model;
    if (!model) {
      return this.buildErrorOutput(
        'DirectChannel: no OpenAI-compatible model is selected for the active provider',
        startedAt,
        'error',
      );
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.llm.timeoutMs ?? 600_000
    );

    try {
      const wantStreaming = options.enableStreaming === true && !!options.onProgress;
      // Channel-specific model override takes precedence (bigmodel's
      // OpenAI-compat endpoint uses a different alias space than the
      // Anthropic-compat one).
      let adaptedMarkdown = '';
      let tokensUsed = 0;
      let finishReason: AdaptFinishReason = 'stop';

      const protocol = this.llm.protocol ?? 'openai-completions';
      const maxTokens = this.llm.maxTokens!;
      const effort = this.thinking === 'minimal' ? 'low' : this.thinking === 'off' ? undefined : this.thinking;
      const reasoning = this.llm.reasoning && effort;
      const emit = (text: string) => { if (text) { adaptedMarkdown += text; if (wantStreaming) options.onProgress?.(text); } };
      if (protocol === 'anthropic-messages') {
        this.anthropic ??= new Anthropic({ apiKey: this.llm.apiKey, baseURL: this.llm.openAiCompatBaseUrl, maxRetries: 0 });
        const params: Anthropic.MessageCreateParamsNonStreaming = {
          model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }],
          ...(reasoning ? { thinking: { type: 'enabled', budget_tokens: Math.max(1024, Math.min(maxTokens - 1, effort === 'high' ? 8192 : effort === 'medium' ? 4096 : 1024)) } as const } : { temperature: options.temperature }),
        };
        if (wantStreaming) {
          let complete = false; let inputTokens = 0;
          const stream = await this.anthropic.messages.create({ ...params, stream: true }, { signal: controller.signal });
          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') emit(event.delta.text);
            if (event.type === 'message_start') { inputTokens = event.message.usage.input_tokens; tokensUsed = inputTokens + event.message.usage.output_tokens; }
            if (event.type === 'message_delta') { tokensUsed = inputTokens + event.usage.output_tokens; if (event.delta.stop_reason === 'max_tokens') finishReason = 'length'; }
            if (event.type === 'message_stop') complete = true;
          }
          if (!complete) throw new Error('Anthropic stream ended before message_stop');
        } else {
          const response = await this.anthropic.messages.create(params, { signal: controller.signal });
          for (const block of response.content) if (block.type === 'text') emit(block.text);
          tokensUsed = response.usage.input_tokens + response.usage.output_tokens;
          if (response.stop_reason === 'max_tokens') finishReason = 'length';
        }
      } else if (protocol === 'openai-responses') {
        const params = { model, input: [{ role: 'user' as const, content: prompt }], max_output_tokens: maxTokens,
          ...(reasoning ? { reasoning: { effort } } : { temperature: options.temperature }) };
        if (wantStreaming) {
          let complete = false;
          const stream = await this.getClient().responses.create({ ...params, stream: true }, { signal: controller.signal });
          for await (const event of stream) {
            if (event.type === 'response.output_text.delta') emit(event.delta);
            if (event.type === 'response.completed' || event.type === 'response.incomplete') {
              complete = true;
              tokensUsed = event.response.usage?.total_tokens ?? 0;
              if (event.response.incomplete_details?.reason === 'max_output_tokens') finishReason = 'length';
            }
            if (event.type === 'response.failed') throw new Error(event.response.error?.message ?? 'Responses request failed');
          }
          if (!complete) throw new Error('Responses stream ended before a terminal event');
        } else {
          const response = await this.getClient().responses.create({ ...params, stream: false }, { signal: controller.signal });
          emit(response.output_text); tokensUsed = response.usage?.total_tokens ?? 0;
          if (response.status === 'failed') throw new Error(response.error?.message ?? 'Responses request failed');
          if (response.incomplete_details?.reason === 'max_output_tokens') finishReason = 'length';
        }
      } else if (protocol === 'openai-completions') {
        const params = { model, messages: [{ role: 'user' as const, content: prompt }],
          ...(reasoning ? { reasoning_effort: effort, max_completion_tokens: maxTokens } : { temperature: options.temperature, max_tokens: maxTokens }) };
        if (wantStreaming) {
          let complete = false;
          const stream = await this.getClient().chat.completions.create({ ...params, stream: true, stream_options: { include_usage: true } }, { signal: controller.signal });
          for await (const chunk of stream) {
            emit(chunk.choices[0]?.delta?.content ?? '');
            if (chunk.choices[0]?.finish_reason) complete = true;
            if (chunk.choices[0]?.finish_reason === 'length') finishReason = 'length';
            if (chunk.usage) tokensUsed = chunk.usage.total_tokens;
          }
          if (!complete) throw new Error('Chat stream ended before finish_reason');
        } else {
          const response = await this.getClient().chat.completions.create({ ...params, stream: false }, { signal: controller.signal });
          emit(response.choices[0]?.message?.content ?? ''); tokensUsed = response.usage?.total_tokens ?? 0;
          if (response.choices[0]?.finish_reason === 'length') finishReason = 'length';
        }
      } else throw new Error('Unsupported provider protocol');

      return {
        adaptedMarkdown,
        tokensUsed,
        durationMs: Date.now() - startedAt,
        channelName: this.name,
        model,
        finishReason,
      };
    } catch (error) {
      if (this.isAbortError(error)) {
        return this.buildErrorOutput(
          `DirectChannel: timed out after ${options.timeoutMs ?? this.llm.timeoutMs ?? 600_000}ms`,
          startedAt,
          'timeout'
        );
      }
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = this.llm.apiKey ? rawMessage.split(this.llm.apiKey).join('***') : rawMessage;
      return this.buildErrorOutput(
        `DirectChannel: SDK call failed - ${message}`,
        startedAt,
        'error'
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Resolve per-call options against LlmConfig defaults.
   */
  private resolveOptions(options: AdaptOptions): Required<Pick<AdaptOptions, 'temperature' | 'timeoutMs'>> & {
    enableStreaming?: boolean;
    onProgress?: (chunk: string) => void;
  } {
    return {
      temperature: options.temperature ?? this.llm.temperature ?? 0.2,
      // Default timeout is LlmConfig.timeoutMs (10 minutes); raises the
      // previous 60s ceiling so bigmodel glm-5.2 has enough headroom
      // to complete under load without prematurely aborting to fallback.
      timeoutMs: options.timeoutMs ?? this.llm.timeoutMs ?? 600_000,
      enableStreaming: options.enableStreaming,
      onProgress: options.onProgress,
    };
  }

  /**
   * Lazily construct the OpenAI client; rebuild on credential change.
   */
  private getClient(): OpenAI {
    if (
      this.client &&
      this.cachedKey === this.llm.apiKey &&
      this.cachedBaseUrl === this.llm.openAiCompatBaseUrl
    ) {
      return this.client;
    }
    this.client = new OpenAI({
      apiKey: this.llm.apiKey,
      baseURL: this.llm.openAiCompatBaseUrl,
      maxRetries: 0,
    });
    this.cachedKey = this.llm.apiKey;
    this.cachedBaseUrl = this.llm.openAiCompatBaseUrl;
    return this.client;
  }

  /**
   * Few-shot prompt with local style example + format rules. Preserved
   * verbatim from the legacy ContentAdapter so output style stays stable
   * across the deepseek -> bigmodel migration.
   */
  private buildPrompt(rawContent: string, localOldContent: string | null): string {
    const exampleSection = localOldContent
      ? `=== 风格示例 ===\n${localOldContent}\n\n`
      : '';

    return `# 任务指令

你是一个飞书文档到本地 Markdown 格式转换专家。请根据飞书原始内容和本地风格示例，生成符合本地规范的 Markdown 文档。

## 输入格式

${exampleSection}=== 飞书新内容 ===
${rawContent}

## 输出要求

1. **保持格式一致性**：遵循示例中的标题层级、表格布局、段落结构
2. **表格重构规则**：
   - 将表格数据转换为 | 分隔的 Markdown 表格
   - 表头使用 | Title | Column1 | Column2 |
   - 数据行使用 | content | data | value |
   - 保持列对齐，每行末尾保留空格
3. **层级处理**：
   - A 列内容作为 H1 标题
   - B 列内容作为 H2 标题（如果非空）
   - C 列作为表格标题（如果符合表格特征）
   - D 列作为段落内容
4. **稀疏宽表处理**：低填充率列转换为段落，高填充率列保持表格格式

## 输出格式

请直接输出转换后的 Markdown 内容，不要包含任何额外说明。
`;
  }

  private buildErrorOutput(
    errorMessage: string,
    startedAt: number,
    finishReason: AdaptFinishReason,
    model = this.llm.directModel || this.llm.model,
  ): AdaptOutput {
    return {
      adaptedMarkdown: '',
      durationMs: Date.now() - startedAt,
      channelName: this.name,
      model,
      finishReason,
      errorMessage,
    };
  }

  private isAbortError(error: unknown): boolean {
    if (error instanceof Error) {
      if (error.name === 'AbortError') return true;
      // OpenAI SDK wraps aborts into APIUserAbortError
      if (/abort/i.test(error.message)) return true;
    }
    return false;
  }
}
