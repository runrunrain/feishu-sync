/**
 * DirectChannel - OpenAI SDK 直连 LLM provider (v0.2.0 P3, fallback channel)
 *
 * Implements 03 §4.2 (DeepseekDirectChannel renamed DirectChannel after
 * the bigmodel cognitive correction). This is the FALLBACK channel;
 * the primary is ClaudeCliChannel. Logic was extracted from the legacy
 * ContentAdapter (which hardcoded OpenAI SDK calls).
 *
 * Channel contract:
 *   - Endpoint: `LlmConfig.openAiCompatBaseUrl` (OpenAI-protocol adapter;
 *     for bigmodel this is `https://open.bigmodel.cn/api/paas/v4`).
 *   - Auth: `Authorization: Bearer <apiKey>`.
 *   - Model: `LlmConfig.model` (e.g. `glm-4-flash`).
 *
 * Streaming is supported (and preferred when the orchestrator passes
 * onProgress). Non-streaming mode is used when enableStreaming=false or
 * when onProgress is absent.
 *
 * Error classification:
 *   - Network/SDK error  -> finishReason='error'
 *   - Timeout (AbortController) -> finishReason='timeout'
 *   - Normal completion   -> finishReason='stop' (or 'length' if truncated)
 *
 * Verified P3 实测 (2026-06-18):
 *   curl -H "Authorization: Bearer <full-key>" \
 *        https://open.bigmodel.cn/api/paas/v4/chat/completions
 *   with `model: glm-4-flash` returned standard OpenAI ChatCompletion.
 *   Same key drives claude CLI via the Anthropic adapter, confirming
 *   both channels share ONE `LlmConfig`.
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

  constructor(private readonly llm: LlmConfig) {}

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

    const client = this.getClient();
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
      const model = this.llm.directModel || this.llm.model;

      let adaptedMarkdown = '';
      let tokensUsed = 0;
      let finishReason: AdaptFinishReason = 'stop';

      if (wantStreaming) {
        const stream = await client.chat.completions.create(
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: options.temperature,
            stream: true,
          },
          { signal: controller.signal }
        );

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            adaptedMarkdown += content;
            tokensUsed += content.length;
            options.onProgress?.(content);
          }
        }
      } else {
        const response = await client.chat.completions.create(
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: options.temperature,
            stream: false,
          },
          { signal: controller.signal }
        );

        adaptedMarkdown = response.choices[0]?.message?.content || '';
        tokensUsed = response.usage?.total_tokens || 0;
        const rawFinish = response.choices[0]?.finish_reason;
        if (rawFinish === 'length') finishReason = 'length';
        else if (rawFinish && rawFinish !== 'stop') finishReason = 'stop';
      }

      return {
        adaptedMarkdown,
        tokensUsed,
        durationMs: Date.now() - startedAt,
        channelName: this.name,
        model: this.llm.directModel || this.llm.model,
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
      const message = error instanceof Error ? error.message : String(error);
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
      // previous 60s ceiling so bigmodel glm-5.2[1m] has enough headroom
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
    finishReason: AdaptFinishReason
  ): AdaptOutput {
    return {
      adaptedMarkdown: '',
      durationMs: Date.now() - startedAt,
      channelName: this.name,
      model: this.llm.directModel || this.llm.model,
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
