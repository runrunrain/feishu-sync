/**
 * ContentAdapter - LLM-driven content adaptation
 *
 * Implements the design from 架构设计文档 §6.4 and 技术实现文档 §十:
 * - adaptContent(): Main orchestration (buildFewShotPrompt -> callDeepseek)
 * - buildFewShotPrompt(): Build prompt with local example + Feishu content + format rules
 * - callDeepseek(): OpenAI SDK streaming call to deepseek API
 * - Fallback strategy: Return original content on LLM failure (no throw, pure deterministic)
 *
 * Features:
 * - Temperature 0.2 for low randomness
 * - Streaming with onProgress callback
 * - Fallback to original content on any error
 * - API key never logged
 */

import OpenAI from 'openai';

interface AdaptOptions {
  baseUrl: string;
  apiKey: string;
  model: 'deepseek-chat' | 'deepseek-reasoner';
  temperature: number;
  enableStreaming: boolean;
  onProgress?: (chunk: string) => void;
}

interface AdaptResult {
  adaptedMarkdown: string;
  tokensUsed: number;
  duration: number;
  model: string;
}

export class ContentAdapter {
  /**
   * Adapt content to local style using LLM
   */
  async adaptContent(
    rawContent: string,
    localOldContent: string | null,
    options: AdaptOptions
  ): Promise<AdaptResult> {
    const startTime = Date.now();

    try {
      // 1. Build prompt
      const prompt = this.buildFewShotPrompt(localOldContent, rawContent);

      // 2. Call deepseek
      const client = new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
      });

      let adaptedMarkdown = '';
      let tokensUsed = 0;

      if (options.enableStreaming) {
        // Streaming mode
        const stream = await client.chat.completions.create({
          model: options.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: options.temperature,
          stream: true,
        });

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          adaptedMarkdown += content;
          tokensUsed += content.length;
          options.onProgress?.(content);
        }
      } else {
        // Non-streaming mode
        const response = await client.chat.completions.create({
          model: options.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: options.temperature,
          stream: false,
        });

        adaptedMarkdown = response.choices[0]?.message?.content || '';
        tokensUsed = response.usage?.total_tokens || 0;
      }

      const duration = Date.now() - startTime;

      return {
        adaptedMarkdown,
        tokensUsed,
        duration,
        model: options.model,
      };
    } catch (error) {
      // Fallback: Return original content on any error
      console.warn('[ContentAdapter] LLM adaptation failed, using original content:', error instanceof Error ? error.message : String(error));
      return {
        adaptedMarkdown: rawContent,
        tokensUsed: 0,
        duration: Date.now() - startTime,
        model: options.model,
      };
    }
  }

  /**
   * Build few-shot prompt with local example + format rules
   */
  private buildFewShotPrompt(localExample: string | null, rawContent: string): string {
    const exampleSection = localExample
      ? `=== 风格示例 ===\n${localExample}\n\n`
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
}
