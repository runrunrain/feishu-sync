/**
 * ClaudeCliChannel - spawn `claude -p` subprocess (v0.2.0 P3, PRIMARY channel)
 *
 * Implements 03 §4.2. This is the PRIMARY channel; on its failure the
 * orchestrator falls back to DirectChannel.
 *
 * Channel contract (P0-Q4 实测 confirmed):
 *   Invocation: `claude -p "<prompt>" --output-format json --max-turns 1
 *                --dangerously-skip-permissions`
 *   Env injection (drives claude CLI's upstream LLM):
 *     ANTHROPIC_BASE_URL = LlmConfig.claudeCompatBaseUrl
 *         (bigmodel Anthropic-protocol path; for bigmodel:
 *          https://open.bigmodel.cn/api/anthropic)
 *     ANTHROPIC_API_KEY  = LlmConfig.apiKey  (shared with DirectChannel)
 *     ANTHROPIC_MODEL    = LlmConfig.model
 *     ANTHROPIC_STREAM   = 'false'           (we need full JSON, not stream)
 *   stdout: single JSON object (see Q4 §2.4.2). Fields consumed:
 *     result, is_error, stop_reason, terminal_reason,
 *     api_error_status, usage, total_cost_usd, duration_ms, session_id
 *
 * Streaming: NOT supported. claude -p returns the full response as a
 * single JSON object after completion; UI shows "运行中..." (caller
 * responsibility). The orchestrator's enableStreaming flag is ignored.
 *
 * stdin: P0-Q4 实测 found claude CLI waits 3s on stdin and prints a
 * warning when no data arrives. We immediately close stdin (end()) to
 * avoid the 3s delay.
 *
 * Error classification (maps to AdaptFinishReason):
 *   - spawn error / non-zero exit / api_error_status != null / is_error
 *       -> 'error'
 *   - timeout (parent-side SIGTERM)
 *       -> 'timeout'
 *   - normal completion
 *       -> 'stop' (we accept 'end_turn' and 'stop' alike)
 *   - non-JSON stdout (e.g. claude printed plain markdown):
 *       -> 'stop' with adaptedMarkdown = stdout (graceful degrade)
 *
 * Application independence: feishu-sync explicitly env-injects the
 * provider credentials, so the claude CLI does NOT depend on the user
 * having pre-configured ~/.claude/settings.json. The same shared
 * LlmConfig drives both channels.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AdaptFinishReason,
  AdaptInput,
  AdaptOutput,
  ClaudeCliConfig,
  ContentBackend,
  LlmConfig,
} from './content-backend.js';

// Q4 实测: claude CLI sets stop_reason='end_turn' on normal completion.
// Other stop reasons (max_tokens -> 'max_tokens', tool_use interruptions)
// are surfaced as 'length' to enable fallback-to-deterministic logic.
const STOP_REASON_END_TURN = 'end_turn';
const STOP_REASON_MAX_TOKENS = 'max_tokens';

// Stdin drain delay observed in P0-Q4 实测. claude prints
// "Warning: no stdin data received in 3s, proceeding without it"
// when stdin stays open without input; we close stdin immediately
// instead of feeding /dev/null.
const STDIN_CLOSE_IMMEDIATE = true;

export class ClaudeCliChannel implements ContentBackend {
  readonly name = 'claude-cli' as const;
  readonly supportsStreaming = false;

  constructor(
    private readonly llm: LlmConfig,
    private readonly claudeCli?: ClaudeCliConfig
  ) {}

  async adapt(input: AdaptInput): Promise<AdaptOutput> {
    const startedAt = Date.now();
    const timeoutMs = input.options.timeoutMs ?? 60_000;
    const temperature = input.options.temperature ?? this.llm.temperature ?? 0.2;

    // Fail fast on misconfiguration so the orchestrator can cleanly
    // fall back to DirectChannel instead of spawning a doomed process.
    if (!this.llm.apiKey) {
      return this.buildErrorOutput(
        'ClaudeCliChannel: apiKey is empty (cannot inject ANTHROPIC_API_KEY)',
        startedAt,
        'error'
      );
    }
    if (!this.llm.claudeCompatBaseUrl) {
      return this.buildErrorOutput(
        'ClaudeCliChannel: claudeCompatBaseUrl is empty (cannot inject ANTHROPIC_BASE_URL)',
        startedAt,
        'error'
      );
    }

    const prompt = this.buildPrompt(input.rawContent, input.localOldContent, temperature);
    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--max-turns',
      '1',
      '--dangerously-skip-permissions',
      ...(this.claudeCli?.extraArgs ?? []),
    ];

    const childEnv = this.buildChildEnv();

    return new Promise<AdaptOutput>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.claudePath(), args, {
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (spawnError) {
        const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
        resolve(
          this.buildErrorOutput(
            `ClaudeCliChannel: failed to spawn claude - ${message}`,
            startedAt,
            'error'
          )
        );
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      // Per P0-Q4 §2.4.3: close stdin immediately to avoid the 3s
      // "no stdin data" warning delay.
      if (STDIN_CLOSE_IMMEDIATE) {
        try {
          child.stdin.end();
        } catch {
          // Ignore EPIPE if the child already closed stdin.
        }
      }

      const settle = (output: AdaptOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(output);
      };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Process may have exited between timeout fire and kill; ignore.
        }
        // Hard kill if SIGTERM didn't take effect within 5s.
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Best effort.
          }
        }, 5_000).unref();
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      });

      child.on('error', (err: Error) => {
        settle(
          this.buildErrorOutput(
            `ClaudeCliChannel: spawn error - ${err.message}`,
            startedAt,
            'error'
          )
        );
      });

      child.on('close', (code: number | null) => {
        const durationMs = Date.now() - startedAt;

        if (timedOut) {
          settle({
            adaptedMarkdown: '',
            durationMs,
            channelName: this.name,
            model: this.llm.claudeCliModel || this.llm.model,
            finishReason: 'timeout',
            errorMessage: `ClaudeCliChannel: timed out after ${timeoutMs}ms`,
          });
          return;
        }

        if (code !== null && code !== 0) {
          settle(
            this.buildErrorOutput(
              `ClaudeCliChannel: claude exited with code ${code}` +
                (stderr ? ` - ${stderr.trim().slice(0, 500)}` : ''),
              startedAt,
              'error'
            )
          );
          return;
        }

        // Try JSON parse; tolerate non-JSON output (claude may print
        // plain markdown if --output-format was overridden).
        const parsed = this.tryParseJson(stdout);
        if (!parsed) {
          settle({
            adaptedMarkdown: stdout || '',
            durationMs,
            channelName: this.name,
            model: this.llm.claudeCliModel || this.llm.model,
            finishReason: stdout ? 'stop' : 'error',
            errorMessage: stdout
              ? undefined
              : 'ClaudeCliChannel: empty stdout from claude',
          });
          return;
        }

        // API-level failure (claude returned JSON but flagged an error).
        if (parsed.is_error === true || parsed.api_error_status !== null) {
          const apiErr =
            typeof parsed.api_error_status === 'object' && parsed.api_error_status
              ? JSON.stringify(parsed.api_error_status)
              : String(parsed.api_error_status ?? '');
          settle(
            this.buildErrorOutput(
              `ClaudeCliChannel: claude reported API error - ${apiErr || 'unknown'}`,
              startedAt,
              'error'
            )
          );
          return;
        }

        const finishReason = this.mapStopReason(parsed.stop_reason);
        const usage = (parsed.usage ?? {}) as {
          input_tokens?: number;
          output_tokens?: number;
        };
        const tokensUsed =
          (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) +
          (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0);

        settle({
          adaptedMarkdown: typeof parsed.result === 'string' ? parsed.result : '',
          tokensUsed,
          durationMs,
          channelName: this.name,
          model: this.llm.claudeCliModel || this.llm.model,
          finishReason,
        });
      });
    });
  }

  /**
   * Resolve the claude executable path. Precedence:
   *   1. claudeCli.claudePath (explicit override)
   *   2. process.env.CLAUDE_CODE_EXECPATH (set by claude code on Windows)
   *   3. PATH lookup of bare 'claude' / 'claude.cmd' on Windows
   */
  private claudePath(): string {
    if (this.claudeCli?.claudePath) return this.claudeCli.claudePath;
    if (process.env.CLAUDE_CODE_EXECPATH) return process.env.CLAUDE_CODE_EXECPATH;
    return process.platform === 'win32' ? 'claude.cmd' : 'claude';
  }

  /**
   * Build the child environment. Inherits process.env and overrides
   * the three Anthropic env vars that drive claude CLI's upstream LLM
   * (P0-Q4 实测 confirmed these are the canonical variable names).
   *
   * We explicitly DISABLE streaming (ANTHROPIC_STREAM=false) because we
   * parse the final JSON result; enabling streaming would corrupt the
   * JSON envelope on stdout.
   */
  private buildChildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Channel-specific override (bigmodel's Anthropic adapter may
    // accept a different alias than the OpenAI adapter).
    const model = this.llm.claudeCliModel || this.llm.model;
    env.ANTHROPIC_BASE_URL = this.llm.claudeCompatBaseUrl;
    env.ANTHROPIC_API_KEY = this.llm.apiKey;
    env.ANTHROPIC_MODEL = model;
    // Pin all tier aliases to the same model so any internal claude
    // tier routing hits the same provider/model.
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    // Disable streaming so stdout is a single JSON envelope.
    env.ANTHROPIC_STREAM = 'false';
    // Disable extended thinking for deterministic, fast single-turn output.
    env.ANTHROPIC_THINKING = '{"type":"disabled"}';
    // Keep max tokens at the provider default if unset; otherwise allow it.
    if (env.ANTHROPIC_MAX_TOKENS === undefined) {
      env.ANTHROPIC_MAX_TOKENS = '8192';
    }
    // Sampling: honor LlmConfig.temperature when provided.
    env.ANTHROPIC_DO_SAMPLE = this.llm.temperature !== undefined && this.llm.temperature < 1 ? 'true' : 'false';
    return env;
  }

  private mapStopReason(raw: unknown): AdaptFinishReason {
    if (raw === STOP_REASON_END_TURN || raw === 'stop') return 'stop';
    if (raw === STOP_REASON_MAX_TOKENS) return 'length';
    // Unknown / null: treat as stop (claude completed normally without
    // surfacing an explicit reason). The orchestrator will accept this
    // as success; if the output is empty, downstream B6 fallback kicks in.
    return 'stop';
  }

  private tryParseJson(stdout: string): Record<string, unknown> | null {
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith('{')) return null;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Maybe nested JSON or trailing noise; try to extract first {...}
      const firstBrace = trimmed.indexOf('{');
      const lastBrace = trimmed.lastIndexOf('}');
      if (firstBrace === -1 || lastBrace === -1 || firstBrace > lastBrace) return null;
      try {
        return JSON.parse(trimmed.substring(firstBrace, lastBrace + 1)) as Record<
          string,
          unknown
        >;
      } catch {
        return null;
      }
    }
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
      model: this.llm.claudeCliModel || this.llm.model,
      finishReason,
      errorMessage,
    };
  }

  /**
   * Few-shot prompt. Mirrors DirectChannel's prompt text so output
   * style stays consistent across channels.
   */
  private buildPrompt(rawContent: string, localOldContent: string | null, temperature: number): string {
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

(temperature=${temperature.toFixed(2)})`;
  }
}
