/**
 * Local OpenCode document-organisation channel.
 *
 * This channel executes `opencode --pure run --format json` in a fresh,
 * private temporary directory for each document. The document body is written
 * to an attachment file rather than argv/stdin, so Feishu content cannot be
 * interpreted as a shell argument. We intentionally omit `--auto`: a model
 * permission request is rejected by OpenCode's non-interactive mode instead
 * of being silently approved. `--pure` additionally excludes external
 * plugins while retaining the user's locally configured OpenCode provider.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  AdaptFinishReason,
  AdaptInput,
  AdaptOutput,
  ContentBackend,
  LlmConfig,
  OpenCodeCliConfig,
} from './content-backend.js';
import { resolveActiveLlmConfig } from './content-backend.js';
import {
  OpenCodeCliService,
  type OpenCodeInvocation,
} from './opencode-cli-service.js';

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;

const ORGANISE_PROMPT = `你是本地 Markdown 文档整理助手。

本次任务的输入以附件提供：source.md 是需要整理的文档；如存在 style-example.md，请只把它当作格式风格参考。

要求：
1. 只输出整理完成的完整 Markdown 正文，不要代码围栏、解释、前后缀或文件名。
2. 保留事实、链接、图片引用、表格数据和 YAML/HTML 元数据；不要凭空补写内容。
3. 可以统一标题、列表、空行、表格和层级，使其贴近 style-example.md 的样式。
4. 不要修改任何文件、不要执行命令、不要联网；若无法完成，请输出原文而不是说明。
`;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
  error?: string;
}

interface ParsedOpenCodeOutput {
  markdown: string | null;
  error?: string;
}

interface OpenCodeRuntimeSettings {
  /** JSON for OPENCODE_CONFIG_CONTENT; contains a key and must never be logged. */
  configContent?: string;
  /** Fully-qualified provider/model string passed via --model when known. */
  model?: string;
  /**
   * Provider-scoped credentials which cannot be represented in the generic
   * config overlay.  These values are injected only into the short-lived
   * child environment and must never be persisted or logged.
   */
  env?: Record<string, string>;
}

const SENSITIVE_ENV_NAME = /(?:^|_)(?:api_?)?key(?:s)?$|token|secret|password|credential|authorization|cookie|session|openrouter|private/i;
const RUNTIME_PROVIDER_ID = 'feishu-sync-runtime';
const ZHIPU_CODING_PLAN_PROVIDER_ID = 'zhipuai-coding-plan';

/**
 * OpenCode needs a complete provider declaration for a temporary custom
 * OpenAI-compatible provider. Merely adding `options` to a built-in provider
 * leaves the model catalogue unresolved in current OpenCode versions, which
 * surfaces only as the unhelpful "Unexpected server error". Keep the runtime
 * provider isolated from the user's own OpenCode profiles so this app never
 * overwrites or shadows a saved credential.
 */
function normalizeOpenCodeModel(model: string): string {
  // Claude-compatible GLM aliases can carry a capacity suffix such as
  // `glm-5.2[1m]`; OpenCode's zhipuai catalog expects the canonical name.
  const normalized = model.trim().replace(/\[[^\]]+\]$/, '');
  // Older settings described this field as `provider/model`. The app now
  // owns the temporary provider whenever it injects a key, so accept the
  // common legacy built-in prefixes while preserving model IDs that contain
  // a slash for other providers.
  return normalized.replace(/^(?:zhipuai|openai|feishu-sync-runtime)\//i, '');
}

/**
 * OpenCode ships a dedicated Zhipu Coding Plan provider.  Its URL differs
 * from the regular Zhipu API and, importantly, it supplies the model's
 * capability metadata (tool-call/attachment shape) expected by OpenCode.
 * A generic OpenAI-compatible provider can send a request the Coding Plan
 * endpoint accepts only partially, resulting in its opaque upstream error.
 */
function isZhipuCodingPlanEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return /(?:^|\.)(?:bigmodel\.cn|z\.ai)$/i.test(url.hostname)
      && /\/api\/coding\/paas\/v4\/?$/i.test(url.pathname);
  } catch {
    return /(?:bigmodel\.cn|z\.ai).*\/api\/coding\/paas\/v4\/?$/i.test(value);
  }
}

/**
 * Construct a per-process OpenCode overlay from the active provider. The
 * returned JSON is intentionally ephemeral and is never persisted or logged.
 * If no active key exists we return no overlay so an existing local OpenCode
 * setup keeps working unchanged.
 */
export function buildOpenCodeRuntimeSettings(
  llm: LlmConfig,
  opencode?: OpenCodeCliConfig,
): OpenCodeRuntimeSettings {
  const effective = resolveActiveLlmConfig(llm);
  const configuredModel = opencode?.model?.trim();
  const sourceModel = configuredModel || effective.directModel || effective.model;
  const normalizedModel = sourceModel ? normalizeOpenCodeModel(sourceModel) : '';

  if (!effective.apiKey.trim()) {
    return { model: configuredModel || undefined };
  }

  if (isZhipuCodingPlanEndpoint(effective.openAiCompatBaseUrl)) {
    const model = normalizedModel
      ? `${ZHIPU_CODING_PLAN_PROVIDER_ID}/${normalizedModel}`
      : undefined;
    return {
      model,
      // Do not override the built-in provider declaration: OpenCode's native
      // Coding Plan adapter carries the endpoint and capability metadata.
      configContent: JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        ...(model ? { model } : {}),
      }),
      env: { ZHIPU_API_KEY: effective.apiKey },
    };
  }

  const model = normalizedModel ? `${RUNTIME_PROVIDER_ID}/${normalizedModel}` : undefined;
  const baseURL = effective.openAiCompatBaseUrl.trim();
  const options: Record<string, string> = { apiKey: effective.apiKey };
  if (baseURL) options.baseURL = baseURL;

  return {
    model,
    configContent: JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      ...(model ? { model } : {}),
      provider: {
        [RUNTIME_PROVIDER_ID]: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Feishu Sync temporary provider',
          options,
          ...(normalizedModel
            ? { models: { [normalizedModel]: { name: normalizedModel } } }
            : {}),
        },
      },
    }),
  };
}

/**
 * Start from the host environment but remove ambient credentials. The only
 * credential OpenCode can receive from this app is the explicit, scoped
 * runtime overlay created above. This prevents an unrelated shell key from
 * silently changing the selected provider or leaking into a plugin.
 */
function buildOpenCodeChildEnv(
  runtime: OpenCodeRuntimeSettings,
  workspace: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name === 'OPENCODE_CONFIG_CONTENT' || SENSITIVE_ENV_NAME.test(name)) continue;
    env[name] = value;
  }
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  env.OPENCODE_DISABLE_PRUNE = '1';
  env.OPENCODE_AUTO_SHARE = 'false';
  // `--pure` prevents third-party plugins, but it intentionally still reads
  // the user's OpenCode config, agents and instructions. Those can inject a
  // large unrelated tool catalogue into a document-formatting request (and
  // can make an otherwise valid Coding Plan request fail upstream). Keep the
  // child fully self-contained: only OPENCODE_CONFIG_CONTENT below is used.
  // XDG roots are supported by OpenCode on macOS/Linux; HOME stays intact so
  // a script-style CLI can still locate its bundled Node runtime.
  const xdgRoot = path.join(workspace, '.opencode-runtime');
  env.XDG_CONFIG_HOME = path.join(xdgRoot, 'config');
  env.XDG_DATA_HOME = path.join(xdgRoot, 'data');
  env.XDG_CACHE_HOME = path.join(xdgRoot, 'cache');
  env.XDG_STATE_HOME = path.join(xdgRoot, 'state');
  if (runtime.configContent) env.OPENCODE_CONFIG_CONTENT = runtime.configContent;
  for (const [name, value] of Object.entries(runtime.env ?? {})) env[name] = value;
  return env;
}

function clampTimeout(value: number | undefined): number {
  const candidate = typeof value === 'number' && Number.isFinite(value)
    ? value
    : DEFAULT_TIMEOUT_MS;
  return Math.max(5_000, Math.min(candidate, MAX_TIMEOUT_MS));
}

function compactError(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = redactError(value.replace(/\s+/g, ' ').trim());
  return compact ? compact.slice(0, 400) : undefined;
}

/** Keep provider diagnostics useful without allowing a echoed credential out. */
function redactError(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ak|api)[-_][A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|authorization|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function extractError(value: unknown): string | undefined {
  if (typeof value === 'string') return compactError(value);
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.message === 'string') return compactError(record.message);
  const data = asRecord(record.data);
  if (typeof data?.message === 'string') return compactError(data.message);
  const nested = record.error;
  if (nested && nested !== value) {
    const nestedMessage = extractError(nested);
    if (nestedMessage) return nestedMessage;
  }
  return typeof record.name === 'string' ? compactError(record.name) : undefined;
}

/** Exported for deterministic parser tests; OpenCode emits NDJSON in json mode. */
export function parseOpenCodeRunOutput(stdout: string): ParsedOpenCodeOutput {
  let lastText: string | null = null;
  let lastError: string | undefined;
  let parsedEvent = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const event = asRecord(JSON.parse(line));
      if (!event) continue;
      parsedEvent = true;
      const payload = asRecord(event.data) ?? event;
      const type = typeof event.type === 'string' ? event.type : typeof payload.type === 'string' ? payload.type : '';
      if (type === 'text') {
        const part = asRecord(payload.part);
        const text = part && part.type === 'text' && typeof part.text === 'string'
          ? part.text
          : typeof payload.text === 'string'
            ? payload.text
            : null;
        if (text && text.trim()) lastText = text;
      } else if (type === 'error') {
        lastError = extractError(payload.error) ?? extractError(event.error) ?? 'OpenCode 返回错误事件';
      }
    } catch {
      // json mode should only emit NDJSON. We retain a plain-text fallback
      // below for backwards-compatible CLI versions, but do not mix it into
      // a successfully parsed event stream.
    }
  }

  if (lastText) return { markdown: stripOuterFence(lastText) };
  if (lastError) return { markdown: null, error: lastError };
  if (!parsedEvent && stdout.trim()) return { markdown: stripOuterFence(stdout.trim()) };
  return { markdown: null, error: 'OpenCode 未返回文档内容' };
}

function stripOuterFence(markdown: string): string {
  const trimmed = markdown.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```\s*$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Adapts reconstructed Markdown through the user's local OpenCode setup.
 * It never calls the network itself and never installs OpenCode; provider
 * access is wholly delegated to the locally configured OpenCode CLI.
 */
export class OpenCodeCliChannel implements ContentBackend {
  readonly name = 'opencode' as const;
  readonly supportsStreaming = false;
  private resolution: Promise<Awaited<ReturnType<OpenCodeCliService['resolve']>>> | null = null;

  constructor(
    private readonly llm: LlmConfig,
    private readonly opencode: OpenCodeCliConfig | undefined,
    private readonly cliService = new OpenCodeCliService(),
  ) {}

  async adapt(input: AdaptInput): Promise<AdaptOutput> {
    const startedAt = Date.now();
    const runtime = buildOpenCodeRuntimeSettings(this.llm, this.opencode);
    const model = runtime.model || this.opencode?.model || 'OpenCode 本机默认模型';
    const timeoutMs = clampTimeout(
      input.options.timeoutMs ?? this.opencode?.timeoutMs ?? this.llm.timeoutMs,
    );

    if (Buffer.byteLength(input.rawContent, 'utf-8') > MAX_ATTACHMENT_BYTES) {
      return this.errorOutput(
        `OpenCode 文档超过 ${(MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0)}MB 限制，未执行整理`,
        startedAt,
        'error',
        model,
      );
    }

    const invalidOption = this.invalidOption();
    if (invalidOption) return this.errorOutput(invalidOption, startedAt, 'error', model);

    const resolution = await this.getResolution();
    if (!resolution.invocation) {
      return this.errorOutput(
        resolution.status.error || '未检测到可执行的 OpenCode',
        startedAt,
        'error',
        model,
      );
    }

    let workspace: string | null = null;
    try {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-sync-opencode-'));
      // Protect temporary source files from other local users on POSIX. This
      // is best effort because Windows does not implement POSIX modes.
      await fs.chmod(workspace, 0o700).catch(() => undefined);
      await fs.writeFile(path.join(workspace, 'source.md'), input.rawContent, {
        encoding: 'utf-8',
        mode: 0o600,
      });
      const hasStyleExample = !!input.localOldContent?.trim();
      if (hasStyleExample) {
        await fs.writeFile(path.join(workspace, 'style-example.md'), input.localOldContent!, {
          encoding: 'utf-8',
          mode: 0o600,
        });
      }

      // Pre-create the isolated XDG roots rather than letting OpenCode fall
      // back to a host-level config directory if one path cannot be created.
      const runtimeRoot = path.join(workspace, '.opencode-runtime');
      await Promise.all([
        fs.mkdir(path.join(runtimeRoot, 'config'), { recursive: true, mode: 0o700 }),
        fs.mkdir(path.join(runtimeRoot, 'data'), { recursive: true, mode: 0o700 }),
        fs.mkdir(path.join(runtimeRoot, 'cache'), { recursive: true, mode: 0o700 }),
        fs.mkdir(path.join(runtimeRoot, 'state'), { recursive: true, mode: 0o700 }),
      ]);

      const args = this.buildArgs(workspace, hasStyleExample, runtime.model);
      const result = await this.runOpenCode(
        resolution.invocation,
        args,
        workspace,
        timeoutMs,
        buildOpenCodeChildEnv(runtime, workspace),
      );
      if (result.timedOut) {
        return this.errorOutput(
          `OpenCode 整理超时（${Math.round(timeoutMs / 1000)} 秒）`,
          startedAt,
          'timeout',
          model,
        );
      }
      if (result.outputExceeded) {
        return this.errorOutput(
          `OpenCode 输出超过 ${(MAX_OUTPUT_BYTES / 1024 / 1024).toFixed(0)}MB 限制`,
          startedAt,
          'error',
          model,
        );
      }
      if (result.error || result.code !== 0) {
        // OpenCode emits structured error events on stdout even when it exits
        // non-zero. Prefer that sanitized message over a bare exit code so
        // Settings can tell a credential/upstream failure from a spawn bug.
        const structuredError = parseOpenCodeRunOutput(result.stdout).error;
        return this.errorOutput(
          compactError(result.error)
            || structuredError
            || `OpenCode 退出码 ${result.code ?? 'unknown'}${compactError(result.stderr) ? `：${compactError(result.stderr)}` : ''}`,
          startedAt,
          'error',
          model,
        );
      }

      const parsed = parseOpenCodeRunOutput(result.stdout);
      if (!parsed.markdown) {
        return this.errorOutput(parsed.error || 'OpenCode 未返回文档内容', startedAt, 'error', model);
      }
      return {
        adaptedMarkdown: parsed.markdown,
        durationMs: Date.now() - startedAt,
        channelName: this.name,
        model,
        finishReason: 'stop',
      };
    } catch (error) {
      return this.errorOutput(
        `OpenCode 临时工作区失败：${compactError(error instanceof Error ? error.message : String(error)) ?? 'unknown error'}`,
        startedAt,
        'error',
        model,
      );
    } finally {
      if (workspace) {
        await fs.rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
          .catch((error: unknown) => {
            console.warn('[OpenCodeCliChannel] failed to clean temporary workspace:', compactError(
              error instanceof Error ? error.message : String(error),
            ));
          });
      }
    }
  }

  private getResolution() {
    if (!this.resolution) {
      this.resolution = this.cliService.resolve(this.opencode?.executablePath);
    }
    return this.resolution;
  }

  private invalidOption(): string | null {
    for (const [label, value] of [
      ['OpenCode 模型', this.opencode?.model],
      ['OpenCode agent', this.opencode?.agent],
    ] as const) {
      if (value !== undefined && (!value.trim() || value.includes('\u0000') || value.length > 256)) {
        return `${label}配置无效`;
      }
    }
    return null;
  }

  private buildArgs(workspace: string, hasStyleExample: boolean, runtimeModel?: string): string[] {
    // OpenCode 1.18 parses `--file` as an array option. If the positional
    // message follows it, yargs treats that message as one more attachment
    // and errors with "File not found: <prompt>". Keep the user-visible
    // positional immediately after `run`, then append all options/files.
    const args = [
      '--pure',
      'run',
      // Static application prompt only. Document content remains in
      // attachment files and is never interpolated into the command line.
      ORGANISE_PROMPT,
      '--format',
      'json',
      '--dir',
      workspace,
      '--title',
      'Feishu Sync 文档整理',
      '--file',
      'source.md',
    ];
    if (hasStyleExample) args.push('--file', 'style-example.md');
    if (runtimeModel) args.push('--model', runtimeModel);
    if (this.opencode?.agent?.trim()) args.push('--agent', this.opencode.agent.trim());
    return args;
  }

  private runOpenCode(
    invocation: OpenCodeInvocation,
    args: string[],
    cwd: string,
    timeoutMs: number,
    env: NodeJS.ProcessEnv,
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(invocation.command, args, {
          cwd,
          // A .cmd npm shim requires cmd.exe on Windows. The only variable
          // data in argv are app-created temp paths and validated settings;
          // raw document content is never supplied to the shell.
          shell: invocation.useShell,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        });
      } catch (error) {
        resolve({
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          outputExceeded: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let outputExceeded = false;
      let settled = false;
      const append = (current: string, chunk: Buffer | string): string => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        if (Buffer.byteLength(current, 'utf-8') + Buffer.byteLength(text, 'utf-8') > MAX_OUTPUT_BYTES) {
          outputExceeded = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // Best effort; the close event will settle.
          }
          return current;
        }
        return current + text;
      };
      const settle = (value: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Best effort.
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Best effort.
          }
        }, 5_000).unref();
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = append(stderr, chunk);
      });
      child.on('error', (error: Error) => {
        settle({
          code: null,
          stdout,
          stderr,
          timedOut,
          outputExceeded,
          error: error.message,
        });
      });
      child.on('close', (code: number | null) => {
        settle({ code, stdout, stderr, timedOut, outputExceeded });
      });
    });
  }

  private errorOutput(
    errorMessage: string,
    startedAt: number,
    finishReason: AdaptFinishReason,
    model: string,
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
}
