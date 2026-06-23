/**
 * ClaudeCliChannel - spawn `claude -p` subprocess (v0.2.0 P3, PRIMARY channel)
 *
 * Implements 03 §4.2. This is the PRIMARY channel; on its failure the
 * orchestrator falls back to DirectChannel.
 *
 * Channel contract (P0-Q4 实测 confirmed + v020-r2 stdin-prompt hardening):
 *   Invocation: `claude -p --output-format json --max-turns 1
 *                --dangerously-skip-permissions`  (no prompt positional arg)
 *   Prompt delivery: STDIN — `child.stdin.write(prompt); child.stdin.end();`
 *     claude CLI reads the prompt from stdin when no positional prompt is
 *     supplied on the command line. Verified 2026-06-23: stdin prompt
 *     round-trips through claude CLI to bigmodel and returns
 *     is_error=false, stop_reason=end_turn.
 *   Why STDIN instead of positional argv:
 *     Node `spawn(cmd, args, { shell: true })` on Windows concatenates
 *     args into the cmd.exe command line WITHOUT escaping (Node DEP0190).
 *     A prompt containing `|`, `&`, `>`, `<`, backtick, `$`, `"` or `'`
 *     would be interpreted by cmd.exe as shell metacharacters, breaking
 *     the prompt and creating an injection surface (rawContent is
 *     user-controlled feishu doc content). Passing the prompt via stdin
 *     bypasses cmd.exe argv parsing entirely — the prompt never enters
 *     the command line, so shell metacharacters are inert. This makes
 *     BOTH the .exe path AND the .cmd+shell:true fallback path safe.
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
 * stdin lifecycle: prompt is written to stdin immediately after spawn
 * and stdin is closed (end()) right after the write. This both feeds
 * the prompt AND signals EOF, so claude CLI never enters its 3-second
 * "no stdin data" wait (P0-Q4 §2.4.3).
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

import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
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

/**
 * Resolved claude executable descriptor.
 *
 * `command`  - what to pass to spawn()
 * `useShell` - whether spawn() must set `shell: true`.
 *
 * On Windows, the claude code CLI is typically shipped as a `.cmd`
 * npm shim (C:\Users\<u>\AppData\Roaming\npm\claude.cmd). Node's
 * child_process.spawn() REFUSES to launch `.cmd`/`.bat` shims without
 * `shell: true` since the CVE-2024-27980 mitigation; doing so throws
 * EINVAL synchronously. The fix prefers a real `.exe` path (set by
 * the claude code launcher in CLAUDE_CODE_EXECPATH) so we can spawn
 * directly without a shell — that keeps the prompt safely in argv
 * (no cmd.exe injection surface). If no `.exe` is available, we fall
 * back to spawning the `.cmd` shim with `shell: true`.
 */
interface ClaudeExecutable {
  command: string;
  useShell: boolean;
}

export class ClaudeCliChannel implements ContentBackend {
  readonly name = 'claude-cli' as const;
  readonly supportsStreaming = false;

  constructor(
    private readonly llm: LlmConfig,
    private readonly claudeCli?: ClaudeCliConfig
  ) {}

  async adapt(input: AdaptInput): Promise<AdaptOutput> {
    const startedAt = Date.now();
    // Default timeout is the LlmConfig.timeoutMs (10 minutes by default);
    // callers can still override per-call via AdaptOptions.timeoutMs.
    // See LlmConfig.timeoutMs rationale in types/index.ts.
    const timeoutMs = input.options.timeoutMs ?? this.llm.timeoutMs ?? 600_000;
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
    // Prompt is delivered via STDIN, not argv. Args carry only flags.
    // This is the v020-r2 prompt-injection hardening: when spawn runs
    // with shell:true (Windows .cmd fallback), Node concatenates args
    // into the cmd.exe command line WITHOUT escaping (Node DEP0190),
    // so any `|`, `&`, `$`, backtick, or quote inside the prompt would
    // be interpreted by cmd.exe. By keeping the prompt out of argv we
    // eliminate the shell-injection surface for BOTH the .exe path and
    // the .cmd+shell:true fallback path. See report §3.3 for details.
    const args = [
      '-p',
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
        const executable = this.resolveClaudeExecutable();
        const spawnOptions: SpawnOptions = {
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        };
        if (executable.useShell) {
          // Required for launching .cmd/.bat npm shims on Windows.
          // SAFE because the prompt is delivered via stdin, not argv:
          // cmd.exe never sees the prompt, so its metacharacters
          // (`|`, `&`, `$`, backtick, quotes, newlines) are inert.
          // Only the hard-coded flag list passes through argv, and
          // every flag is a non-undefined string literal.
          spawnOptions.shell = true;
        }
        child = spawn(executable.command, args, spawnOptions) as ChildProcessWithoutNullStreams;
        // We always set stdio: ['pipe','pipe','pipe'] above (even when
        // shell:true), so stdin/stdout/stderr are guaranteed non-null
        // at runtime despite SpawnOptions' wider ChildProcess return
        // type. The cast narrows the type for ergonomic .stdin.end().
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

      // Feed the prompt via stdin and immediately half-close so claude
      // CLI sees EOF and does not enter its 3s "no stdin data" wait
      // (P0-Q4 §2.4.3). Writing happens AFTER spawn succeeds; if spawn
      // threw EINVAL it was caught above and we never reach here.
      //
      // Why stdin.write + end instead of just end():
      //   - The prompt is the actual task payload; without it claude has
      //     no task to run. We write then end to deliver prompt + EOF.
      // Why not worry about backpressure:
      //   - Prompts are < 100KB (typical <10KB); OS pipe buffer is 64KB+
      //     so a single write() drains synchronously into the kernel.
      //   - For pathological prompt sizes the write still completes; the
      //     'drain' event would only matter for sustained streaming.
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch {
        // Ignore EPIPE if the child already closed stdin before we wrote.
        // The child will still emit 'close' with a non-zero code that
        // surfaces as an error finishReason.
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
   * Resolve the claude executable descriptor. Precedence:
   *   1. claudeCli.claudePath (explicit user override; used as-is, no
   *      shell — caller is responsible for pointing at a real binary)
   *   2. process.env.CLAUDE_CODE_EXECPATH (claude code sets this to the
   *      actual .exe when feishu-sync is launched from within claude
   *      code; .exe can be spawned directly without shell)
   *   3. Windows: 'claude.cmd' (npm shim) with shell:true
   *      Other platforms: 'claude' (no shell)
   *
   * Why prefer .exe over .cmd: Node refuses to spawn .cmd/.bat without
   * shell:true (CVE-2024-27980 mitigation), which throws EINVAL. The
   * .exe path is the true binary, immune to EINVAL and free of cmd.exe
   * argv-parsing quirks.
   *
   * Why the .cmd + shell:true fallback is now safe (v020-r2):
   *   Node `spawn(cmd, args, { shell: true })` on Windows CONCATENATES
   *   args into the cmd.exe command line WITHOUT escaping (per Node
   *   DEP0190). If we passed the prompt as an argv element, its
   *   markdown `|`, newlines, quotes, backticks, `$` would be
   *   interpreted by cmd.exe, corrupting the prompt and creating an
   *   injection surface (rawContent is user-controlled feishu content).
   *   We therefore deliver the prompt via STDIN (`child.stdin.write`)
   *   and pass only flags in argv. Because the prompt never enters the
   *   command line, shell metacharacters are inert. This makes both
   *   the .exe path and the .cmd+shell:true fallback path safe; the
   *   useShell flag now only affects HOW claude is launched, not
   *   whether the prompt is safe.
   *   See detect-arg-fix MEMORY for the related "undefined argv
   *   collapses to positional" trap — all argv entries here are
   *   guaranteed non-undefined strings (hard-coded flag list + typed
   *   extraArgs: string[]).
   */
  private resolveClaudeExecutable(): ClaudeExecutable {
    // 1. Explicit user override.
    if (this.claudeCli?.claudePath) {
      return { command: this.claudeCli.claudePath, useShell: false };
    }
    // 2. claude code launcher exposes the .exe via this env var.
    //    Verified on main上's machine: points to
    //    C:\Users\<u>\AppData\Roaming\npm\node_modules\@anthropic-ai\
    //    claude-code\bin\claude.exe (real PE binary, spawn-safe).
    if (process.env.CLAUDE_CODE_EXECPATH) {
      return { command: process.env.CLAUDE_CODE_EXECPATH, useShell: false };
    }
    // 3. Fallback: PATH lookup. On Windows the global npm shim is
    //    `claude.cmd`; spawning it without shell:true throws EINVAL.
    if (process.platform === 'win32') {
      return { command: 'claude.cmd', useShell: true };
    }
    return { command: 'claude', useShell: false };
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
