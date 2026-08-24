/**
 * ClaudeCliChannel - spawn `claude -p` subprocess (v0.2.0 P3, PRIMARY channel)
 *
 * Implements 03 §4.2. This is the PRIMARY channel; on its failure the
 * orchestrator falls back to DirectChannel.
 *
 * Channel contract (P0-Q4 实测 confirmed + v020-r2 stdin-prompt hardening):
 *   Invocation: `claude -p --output-format json --max-turns 1`.
 *     Generic Anthropic-compatible providers run in `--bare` mode. Z.AI's
 *     Coding Plan uses `ANTHROPIC_AUTH_TOKEN`, which Claude Code deliberately
 *     excludes in `--bare`; it instead runs in a private empty cwd/config
 *     directory with tools disabled and no session persistence.
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
 *     Generic providers: ANTHROPIC_API_KEY + ANTHROPIC_MODEL.
 *     Z.AI Coding Plan: ANTHROPIC_AUTH_TOKEN + current
 *       https://api.z.ai/api/anthropic endpoint and tier mappings.
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
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AdaptFinishReason,
  AdaptInput,
  AdaptOutput,
  ClaudeCliConfig,
  ContentBackend,
  LlmConfig,
} from './content-backend.js';
import { resolveActiveLlmConfig } from './content-backend.js';
import {
  buildClaudeCliEnvironment,
  resolveClaudeCliInvocation,
  type ClaudeCliInvocation,
} from './claude-cli-service.js';

// Q4 实测: claude CLI sets stop_reason='end_turn' on normal completion.
// Other stop reasons (max_tokens -> 'max_tokens', tool_use interruptions)
// are surfaced as 'length' to enable fallback-to-deterministic logic.
const STOP_REASON_END_TURN = 'end_turn';
const STOP_REASON_MAX_TOKENS = 'max_tokens';

interface ClaudeRuntime {
  model: string;
  baseUrl: string;
  /** Z.AI Coding Plan requires AUTH_TOKEN, which `--bare` intentionally excludes. */
  usesZaiCodingAuth: boolean;
}

interface ClaudeWorkspace {
  root: string;
  configDir: string;
}

function isZaiAnthropicEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return /(?:^|\.)(?:bigmodel\.cn|z\.ai)$/i.test(url.hostname);
  } catch {
    return /(?:^|\.)(?:bigmodel\.cn|z\.ai)(?:[/:]|$)/i.test(value);
  }
}

/** Z.AI's current Claude Code endpoint; old BigModel hostnames remain input-compatible. */
function canonicalZaiAnthropicEndpoint(value: string): string {
  return isZaiAnthropicEndpoint(value)
    ? 'https://api.z.ai/api/anthropic'
    : value.trim();
}

/**
 * GLM-5.2 is available through the OpenAI-compatible coding endpoint but is
 * not a documented Claude Code tier mapping. Use the current stable Claude
 * Code mapping for the Z.AI gateway; direct/OpenCode retain their own model.
 */
function resolveZaiClaudeCodeModel(value: string): string {
  const model = value.trim().replace(/\[[^\]]+\]$/, '');
  return /^glm-5\.2$/i.test(model) ? 'glm-4.7' : model;
}

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
type ClaudeExecutable = ClaudeCliInvocation;

export class ClaudeCliChannel implements ContentBackend {
  readonly name = 'claude-cli' as const;
  readonly supportsStreaming = false;
  private readonly llm: LlmConfig;

  constructor(
    llm: LlmConfig,
    private readonly claudeCli?: ClaudeCliConfig
  ) {
    // See resolveActiveLlmConfig: a selected provider/preset must drive the
    // env injected into Claude Code, not merely appear as Settings metadata.
    this.llm = resolveActiveLlmConfig(llm);
  }

  async adapt(input: AdaptInput): Promise<AdaptOutput> {
    const startedAt = Date.now();
    // Default timeout is the LlmConfig.timeoutMs (10 minutes by default);
    // callers can still override per-call via AdaptOptions.timeoutMs.
    // See LlmConfig.timeoutMs rationale in types/index.ts.
    const timeoutMs = input.options.timeoutMs ?? this.llm.timeoutMs ?? 600_000;
    const temperature = input.options.temperature ?? this.llm.temperature ?? 0.2;
    const runtime = this.resolveRuntime();

    // Fail fast on misconfiguration so the orchestrator can cleanly
    // fall back to DirectChannel instead of spawning a doomed process.
    if (!this.llm.apiKey) {
      return this.buildErrorOutput(
        'ClaudeCliChannel: apiKey is empty (cannot inject provider credential)',
        startedAt,
        'error',
        undefined,
        runtime.model,
      );
    }
    if (!runtime.baseUrl) {
      return this.buildErrorOutput(
        'ClaudeCliChannel: claudeCompatBaseUrl is empty (cannot inject ANTHROPIC_BASE_URL)',
        startedAt,
        'error',
        undefined,
        runtime.model,
      );
    }
    if (!runtime.model) {
      return this.buildErrorOutput(
        'ClaudeCliChannel: no Anthropic-compatible model is selected for the active provider',
        startedAt,
        'error',
        undefined,
        runtime.model,
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
    const extraArgs = this.claudeCli?.extraArgs ?? [];
    const invalidExtraArg = this.validateExtraArgs(extraArgs);
    if (invalidExtraArg) {
      return this.buildErrorOutput(invalidExtraArg, startedAt, 'error', undefined, runtime.model);
    }

    const args = ['-p'];
    // Claude Code's `--bare` intentionally ignores ANTHROPIC_AUTH_TOKEN.
    // Z.AI Coding Plan therefore uses an isolated empty workspace/config
    // instead; generic API-key providers retain the stricter bare mode.
    if (!runtime.usesZaiCodingAuth) args.push('--bare');
    args.push(
      '--no-session-persistence',
      '--output-format',
      'json',
      '--max-turns',
      '1',
      // The task is a pure text transformation. Disabling tools keeps the
      // headless process from reading/writing the local machine or making an
      // unrelated network/tool call while formatting a synced document.
      '--tools',
      '',
      ...extraArgs,
    );

    const executable = this.resolveClaudeExecutable();
    if (!executable) {
      return this.buildErrorOutput(
        'Claude Code 未检测到。请安装 Claude Code，或在设置中填写其可执行文件绝对路径。',
        startedAt,
        'error',
        undefined,
        runtime.model,
      );
    }

    let workspace: ClaudeWorkspace | undefined;
    if (runtime.usesZaiCodingAuth) {
      try {
        workspace = await this.createIsolatedWorkspace();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.buildErrorOutput(
          `ClaudeCliChannel: failed to create isolated workspace - ${message}`,
          startedAt,
          'error',
          undefined,
          runtime.model,
        );
      }
    }
    const childEnv = this.buildChildEnv(executable, runtime, workspace?.configDir, timeoutMs);

    return new Promise<AdaptOutput>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        const spawnOptions: SpawnOptions = {
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          ...(workspace ? { cwd: workspace.root } : {}),
        };
        // A failed Claude request can leave a helper/session descendant alive
        // after it has already written its JSON envelope. Give the job a
        // dedicated POSIX process group so the timeout/early-completion path
        // can clean up the whole invocation rather than leaking a headless
        // process in the desktop app.
        if (process.platform !== 'win32') {
          spawnOptions.detached = true;
        }
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
            'error',
            undefined,
            runtime.model,
          )
        );
        void this.cleanupWorkspace(workspace);
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
        this.terminateChild(child, 'SIGTERM');
        // Hard kill if SIGTERM didn't take effect within 5s.
        setTimeout(() => {
          this.terminateChild(child, 'SIGKILL');
        }, 5_000).unref();
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        // Claude may write a complete JSON result but keep a helper process
        // alive. Do not make Settings/sync wait for that unrelated teardown:
        // once we have a complete envelope, return it and terminate the job
        // process group. This also exposes upstream API errors immediately.
        const parsed = this.tryParseJson(stdout);
        if (parsed && this.isClaudeEnvelope(parsed)) {
          const output = this.outputFromEnvelope(parsed, startedAt, undefined, stderr, runtime.model);
          this.terminateChild(child, 'SIGTERM');
          settle(output);
        }
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      });

      child.on('error', (err: Error) => {
        settle(
          this.buildErrorOutput(
            `ClaudeCliChannel: spawn error - ${err.message}`,
            startedAt,
            'error',
            undefined,
            runtime.model,
          )
        );
        void this.cleanupWorkspace(workspace);
      });

      child.on('close', (code: number | null) => {
        void this.cleanupWorkspace(workspace);
        const durationMs = Date.now() - startedAt;

        if (timedOut) {
          settle({
            adaptedMarkdown: '',
            durationMs,
            channelName: this.name,
            model: runtime.model,
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
              'error',
              undefined,
              runtime.model,
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
            model: runtime.model,
            finishReason: stdout ? 'stop' : 'error',
            errorMessage: stdout
              ? undefined
              : 'ClaudeCliChannel: empty stdout from claude',
          });
          return;
        }

        settle(this.outputFromEnvelope(parsed, startedAt, durationMs, stderr, runtime.model));
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
  private resolveClaudeExecutable(): ClaudeExecutable | null {
    return resolveClaudeCliInvocation(this.claudeCli?.claudePath);
  }

  private resolveRuntime(): ClaudeRuntime {
    const requestedModel = this.llm.claudeCliModel || this.llm.model;
    const usesZaiCodingAuth = isZaiAnthropicEndpoint(this.llm.claudeCompatBaseUrl);
    return {
      model: usesZaiCodingAuth
        ? resolveZaiClaudeCodeModel(requestedModel)
        : requestedModel,
      baseUrl: usesZaiCodingAuth
        ? canonicalZaiAnthropicEndpoint(this.llm.claudeCompatBaseUrl)
        : this.llm.claudeCompatBaseUrl.trim(),
      usesZaiCodingAuth,
    };
  }

  /**
   * `--bare` rejects ANTHROPIC_AUTH_TOKEN, so Z.AI jobs need non-bare mode.
   * Run that mode in an empty private cwd and a private CLAUDE_CONFIG_DIR to
   * retain the same no-hooks/no-user-config isolation without mutating the
   * user's Claude files.
   */
  private async createIsolatedWorkspace(): Promise<ClaudeWorkspace> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-sync-claude-'));
    const configDir = path.join(root, 'config');
    await fs.chmod(root, 0o700).catch(() => undefined);
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    return { root, configDir };
  }

  private async cleanupWorkspace(workspace: ClaudeWorkspace | undefined): Promise<void> {
    if (!workspace) return;
    await fs.rm(workspace.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      .catch(() => undefined);
  }

  /** Kill the dedicated POSIX process group, falling back to the child. */
  private terminateChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The process may already have exited or platform policy may reject
        // a group signal. Fall through to the direct child best effort.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Best effort.
    }
  }

  private isClaudeEnvelope(parsed: Record<string, unknown>): boolean {
    return Object.prototype.hasOwnProperty.call(parsed, 'result')
      || Object.prototype.hasOwnProperty.call(parsed, 'is_error')
      || Object.prototype.hasOwnProperty.call(parsed, 'api_error_status')
      || Object.prototype.hasOwnProperty.call(parsed, 'stop_reason');
  }

  /** Convert Claude's terminal JSON into a safe channel result. */
  private outputFromEnvelope(
    parsed: Record<string, unknown>,
    startedAt: number,
    durationMs = Date.now() - startedAt,
    stderr = '',
    model = this.resolveRuntime().model,
  ): AdaptOutput {
    // `undefined !== null` used to classify ordinary envelopes that omit the
    // optional field as errors. Only a non-null value is a provider failure.
    if (parsed.is_error === true || parsed.api_error_status != null) {
      const apiErr = this.safeProviderDiagnostic(
        parsed.api_error_status
          ?? parsed.error
          ?? parsed.errors
          ?? parsed.message
          ?? parsed.result
          ?? stderr,
      );
      return this.buildErrorOutput(
        `ClaudeCliChannel: claude reported API error - ${apiErr || 'unknown'}`,
        startedAt,
        'error',
        durationMs,
        model,
      );
    }

    const finishReason = this.mapStopReason(parsed.stop_reason);
    const usage = (parsed.usage ?? {}) as {
      input_tokens?: number;
      output_tokens?: number;
    };
    const tokensUsed =
      (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) +
      (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0);
    return {
      adaptedMarkdown: typeof parsed.result === 'string' ? parsed.result : '',
      tokensUsed,
      durationMs,
      channelName: this.name,
      model,
      finishReason,
    };
  }

  /** Provider payloads can echo credentials; keep only a short redacted hint. */
  private safeProviderDiagnostic(value: unknown): string {
    const raw = typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value);
    return raw
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk|ak|api)[-_][A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]')
      .replace(/(["']?(?:api[_-]?key|authorization|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
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
  private buildChildEnv(
    executable: ClaudeExecutable,
    runtime: ClaudeRuntime,
    configDir: string | undefined,
    timeoutMs: number,
  ): NodeJS.ProcessEnv {
    // The resolver's environment helper ensures a script-style global npm
    // shim can locate its sibling Node runtime even when Electron was opened
    // from Finder with a minimal PATH.
    const env = buildClaudeCliEnvironment(executable);
    env.ANTHROPIC_BASE_URL = runtime.baseUrl;
    // Never inherit an unrelated credential from the Electron parent.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    if (runtime.usesZaiCodingAuth) {
      // Z.AI's documented Claude Code integration authenticates with this
      // token variable. `--bare` is intentionally omitted for this mode and
      // adapt() supplies an empty private config/cwd instead.
      env.ANTHROPIC_AUTH_TOKEN = this.llm.apiKey;
      delete env.ANTHROPIC_MODEL;
      if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = runtime.model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = runtime.model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = runtime.model;
      env.API_TIMEOUT_MS = String(Math.max(180_000, timeoutMs));
      // These generic Anthropic tuning variables are not part of Z.AI's
      // documented Claude Code integration; omit inherited values.
      delete env.ANTHROPIC_MAX_TOKENS;
      delete env.ANTHROPIC_DO_SAMPLE;
    } else {
      env.ANTHROPIC_API_KEY = this.llm.apiKey;
      env.ANTHROPIC_MODEL = runtime.model;
      // Pin all tier aliases to the same model so any internal claude
      // tier routing hits the same provider/model.
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = runtime.model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = runtime.model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = runtime.model;
      // Keep max tokens at the provider default if unset; otherwise allow it.
      if (env.ANTHROPIC_MAX_TOKENS === undefined) {
        env.ANTHROPIC_MAX_TOKENS = '8192';
      }
      // Sampling: honor LlmConfig.temperature when provided.
      env.ANTHROPIC_DO_SAMPLE = this.llm.temperature !== undefined && this.llm.temperature < 1 ? 'true' : 'false';
    }
    // Disable streaming so stdout is a single JSON envelope.
    env.ANTHROPIC_STREAM = 'false';
    // Disable extended thinking for deterministic, fast single-turn output.
    env.ANTHROPIC_THINKING = '{"type":"disabled"}';
    return env;
  }

  /**
   * Extra arguments are a user-facing escape hatch, not part of the document
   * protocol. Reject flags that could change prompt/output/auth/tool safety
   * invariants; ordinary diagnostic flags remain usable.
   */
  private validateExtraArgs(extraArgs: string[]): string | null {
    for (const arg of extraArgs) {
      if (typeof arg !== 'string' || /[\r\n]/.test(arg)) {
        return 'claude CLI 附加参数包含无效换行';
      }
      if (/^(?:-p|--print|--output-format(?:=|$)|--model(?:=|$)|--tools(?:=|$)|--allowed-tools(?:=|$)|--disallowed-tools(?:=|$)|--bare|--dangerously-skip-permissions|--permission-mode(?:=|$))$/i.test(arg)) {
        return `claude CLI 附加参数不允许覆盖受控安全参数：${arg}`;
      }
    }
    return null;
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
    finishReason: AdaptFinishReason,
    durationMs = Date.now() - startedAt,
    model = this.resolveRuntime().model,
  ): AdaptOutput {
    return {
      adaptedMarkdown: '',
      durationMs,
      channelName: this.name,
      model,
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
