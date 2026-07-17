/**
 * LarkCliClient - Encapsulates all lark-cli subprocess calls
 *
 * Implements the design from 飞书认证架构专项设计 §五:
 * - checkAuthReady(): version + auth status + required scopes validation
 * - listWikiNodes(): wiki +node-list with space-id and parent-node-token
 * - getNode(): wiki +node-get returning space_id, obj_token, obj_edit_time, has_child
 * - api(): generic lark-cli api command fallback
 * - QPS throttling: token bucket (wiki 10, docx 5, sheets 5)
 * - Error classification: 99991400 (rate limit), 40403 (no permission), timeout, auth errors
 *
 * IMPORTANT: This module must NOT contain any Feishu token variables.
 * All token management is delegated to lark-cli.
 */

import { execFile } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'util';
import type { LarkCliNodeInfo, LarkCliConfig } from '../types/index.js';

const execFileAsync = promisify(execFile);

export type LarkCliErrorCode =
  | 'auth'
  | 'permission'
  | 'rate_limited'
  | 'timeout'
  | 'parse'
  | 'upstream';

/** Structured error surfaced consistently by every lark-cli command path. */
export class LarkCliError extends Error {
  constructor(
    message: string,
    public readonly code: LarkCliErrorCode,
    public readonly retryable: boolean,
    public readonly upstreamCode?: string,
  ) {
    super(message);
    this.name = 'LarkCliError';
  }
}

export interface LarkCliExecutionOptions {
  /**
   * A controlled working directory for shortcuts whose file arguments must
   * be relative (notably docs +media-download / +media-preview).
   */
  cwd?: string;
}

export interface MediaOutputTarget {
  directory: string;
  outputName: string;
  requestedPath: string;
}

/**
 * lark-cli refuses absolute --output values. Convert a caller's absolute
 * staging path into a safe cwd + basename pair without allowing `..` to
 * escape that staging directory.
 */
export function resolveMediaOutputTarget(outputPath: string): MediaOutputTarget {
  if (typeof outputPath !== 'string' || outputPath.trim().length === 0) {
    throw new Error('媒体输出路径不能为空');
  }
  const requestedPath = path.resolve(outputPath);
  const directory = path.dirname(requestedPath);
  const outputName = path.basename(requestedPath);
  if (!outputName || outputName === '.' || outputName === path.sep) {
    throw new Error(`媒体输出文件名无效: ${outputPath}`);
  }
  return { directory, outputName, requestedPath };
}

function isPathInsideDirectory(directory: string, candidate: string): boolean {
  // macOS reports many temp paths through /private even when the caller used
  // /var or /tmp. Canonicalize existing paths before enforcing containment so
  // a valid lark-cli saved_path is not mistaken for an escape.
  const canonical = (value: string): string => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const relative = path.relative(canonical(directory), canonical(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export class LarkCliClient {
  private qpsLimiter: Map<string, number[]> = new Map();

  constructor(private config: LarkCliConfig) {}

  /**
   * Execute a command through the sole subprocess/timeout/parser/error path.
   * Higher-level helpers below are intentionally thin wrappers so callers
   * never duplicate lark-cli invocation policy.
   */
  async execute(
    args: string[],
    apiType: 'wiki' | 'docx' | 'sheets' = 'wiki',
    executionOptions?: LarkCliExecutionOptions,
  ): Promise<any> {
    await this.throttle(apiType);
    return this.execLarkCli(args, executionOptions);
  }

  async fetchDocumentMarkdown(objToken: string): Promise<any> {
    return this.execute([
      'docs', '+fetch', '--api-version', 'v2', '--doc', objToken,
      '--doc-format', 'markdown', '--detail', 'simple',
    ], 'docx');
  }

  /** Read the authoritative XML presentation body for a Slides object. */
  async fetchSlidesXml(xmlPresentationId: string): Promise<any> {
    return this.execute([
      'slides', 'xml_presentations', 'get', '--as', 'user',
      '--params', JSON.stringify({
        xml_presentation_id: xmlPresentationId,
        revision_id: -1,
      }),
      '--format', 'json',
    ], 'docx');
  }

  async downloadMedia(
    token: string,
    outputPath: string,
    type: 'media' | 'whiteboard' = 'media',
  ): Promise<string> {
    return this.fetchMediaToPath('download', token, outputPath, type);
  }

  async previewMedia(token: string, outputPath: string): Promise<string> {
    return this.fetchMediaToPath('preview', token, outputPath, 'media');
  }

  private async fetchMediaToPath(
    operation: 'download' | 'preview',
    token: string,
    outputPath: string,
    type: 'media' | 'whiteboard',
  ): Promise<string> {
    const target = resolveMediaOutputTarget(outputPath);
    const args = [
      'docs',
      operation === 'download' ? '+media-download' : '+media-preview',
      '--token',
      token,
      '--output',
      target.outputName,
    ];
    if (operation === 'download' && type === 'whiteboard') {
      args.push('--type', 'whiteboard');
    }
    const result = await this.execute(args, 'docx', { cwd: target.directory });
    const reportedPath = typeof result?.data?.saved_path === 'string'
      ? path.resolve(result.data.saved_path)
      : target.requestedPath;
    if (!isPathInsideDirectory(target.directory, reportedPath)) {
      throw new LarkCliError(
        `lark-cli 返回了输出目录外的媒体路径: ${reportedPath}`,
        'upstream',
        false,
      );
    }
    return reportedPath;
  }

  async getWorkbookInfo(spreadsheetToken: string): Promise<any> {
    return this.execute([
      'sheets', '+workbook-info', '--spreadsheet-token', spreadsheetToken,
      '--format', 'json',
    ], 'sheets');
  }

  async getSheetCsv(options: {
    spreadsheetToken: string;
    sheetId: string;
    range: string;
  }): Promise<any> {
    return this.execute([
      'sheets', '+csv-get', '--spreadsheet-token', options.spreadsheetToken,
      '--sheet-id', options.sheetId, '--range', options.range,
      '--include-row-prefix=false', '--format', 'json',
    ], 'sheets');
  }

  /**
   * Check if lark-cli is ready (version + authentication + scope validation)
   */
  async checkAuthReady(): Promise<{ ready: boolean; error?: string }> {
    try {
      // 1. Check if lark-cli is installed
      const versionResult = await this.execLarkCli(['--version']);
      if (!versionResult.ok) {
        return { ready: false, error: 'lark-cli 未安装，请执行 npm install -g lark-cli' };
      }

      // 2. Check authentication status
      const statusResult = await this.execLarkCli(['auth', 'status']);
      if (!statusResult.data || !statusResult.data.identity) {
        return { ready: false, error: '未认证，请执行 lark-cli auth login' };
      }

      if (statusResult.data.identity !== 'user') {
        return { ready: false, error: `认证身份不是 user，当前身份: ${statusResult.data.identity}` };
      }

      // 3. Check required scopes (scopes are space-separated string in identities.user.scope)
      const scopesString = statusResult.data.identities?.user?.scope || '';
      const currentScopes = scopesString.split(' ').filter((s: string) => s.length > 0);
      const missingScopes = this.config.requiredScopes.filter((s) => !currentScopes.includes(s));
      if (missingScopes.length > 0) {
        return { ready: false, error: `缺少权限：${missingScopes.join(', ')}，请执行 lark-cli auth login --scope` };
      }

      return { ready: true };
    } catch (error) {
      return { ready: false, error: `认证检查失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * List wiki subtree nodes (supporting pagination and recursion)
   * Uses --page-all with ndjson format to handle large knowledge bases
   * Returns flat array of all nodes under the parent
   */
  async listWikiNodes(options: {
    spaceId?: string;
    parentNodeToken?: string;
    pageSize?: number;
  }): Promise<LarkCliNodeInfo[]> {
    const args = ['wiki', '+node-list', '--format', 'ndjson', '--page-all'];
    if (options.spaceId) args.push('--space-id', options.spaceId);
    if (options.parentNodeToken) args.push('--parent-node-token', options.parentNodeToken);
    if (options.pageSize) args.push('--page-size', String(options.pageSize));

    const result = await this.execute(args, 'wiki');

    // ndjson format: returns { data: { has_more, nodes: [...] } } wrapped in ok: true
    // The nodes array is already in result.data.nodes
    return result.data?.nodes || [];
  }

  /**
   * Get node details (supports URL/node_token/obj_token)
   * Returns space_id, obj_token, obj_edit_time, has_child, etc.
   *
   * v0.2.0 defensive guard: reject non-string/empty input at the
   * boundary. Previously, an undefined rootUrl from the detect
   * endpoint flowed here and was passed to execFile with shell:true,
   * which collapsed `['--node-token', undefined, '--format', 'json']`
   * into a command line that lark-cli parsed as a positional arg
   * "json" (see detect.ts header + change-notification-service.ts
   * header). Throwing here gives a clear, attributable error instead
   * of the misleading upstream message. This guard touches only the
   * public getNode signature; the auth/QPS/execLarkCli surface
   * (architecture red line I1) is unchanged.
   */
  async getNode(nodeTokenOrUrl: string): Promise<LarkCliNodeInfo> {
    if (typeof nodeTokenOrUrl !== 'string' || nodeTokenOrUrl.trim().length === 0) {
      throw new Error(
        `getNode requires a non-empty string (URL or token); received: ${String(nodeTokenOrUrl)}`
      );
    }
    const args = ['wiki', '+node-get', '--node-token', nodeTokenOrUrl, '--format', 'json'];
    const result = await this.execute(args, 'wiki');

    // obj_edit_time NaN defense (diagnosis §2.2 根因 D): lark-cli returns an
    // empty string or undefined for permission-restricted / missing fields.
    // parseInt on those inputs yields NaN, which used to propagate as toxic
    // data — `NaN > localTime` is always false, silently turning "cloud
    // edited" into "no change reported". Coerce non-finite results to null
    // so the upstream compareWithLocalRecords treats them as "unknown" and
    // skips the modified branch (consistent with the existing
    // `node.obj_edit_time || null` coercion at change-detector.ts:516).
    const parsedEditTime = parseInt(result.data.obj_edit_time, 10);
    const objEditTime = Number.isFinite(parsedEditTime) ? parsedEditTime : null;

    // Map fields based on actual lark-cli output (validated by 实测)
    return {
      node_token: result.data.node_token,
      obj_token: result.data.obj_token,
      obj_type: result.data.obj_type,
      title: result.data.title,
      space_id: result.data.space_id,
      obj_edit_time: objEditTime,
      has_child: result.data.has_child,
    };
  }

  /**
   * Generic OpenAPI call (fallback)
   */
  async api(method: 'GET' | 'POST', apiPath: string, options?: {
    params?: Record<string, any>;
    data?: Record<string, any>;
    as?: 'user' | 'bot';
  }): Promise<any> {
    const args = ['api', method, apiPath, '--format', 'json'];
    if (options?.as) args.push('--as', options.as);
    if (options?.params) args.push('--params', JSON.stringify(options.params));
    if (options?.data) args.push('--data', JSON.stringify(options.data));

    return this.execute(args, 'wiki');
  }

  /**
   * Execute lark-cli subprocess (core encapsulation)
   */
  private async execLarkCli(
    args: string[],
    executionOptions?: LarkCliExecutionOptions,
  ): Promise<any> {
    const larkCliPath = this.config.larkCliPath || this.getDefaultLarkCliPath();
    const timeout = this.config.timeout || 30000;

    try {
      const { stdout, stderr } = await execFileAsync(larkCliPath, args, {
        timeout,
        encoding: 'utf-8',
        shell: process.platform === 'win32', // Use shell on Windows for .cmd files
        ...(executionOptions?.cwd ? { cwd: executionOptions.cwd } : {}),
      });

      // Detect authentication errors
      if (this.detectAuthError(stderr)) {
        throw new LarkCliError('认证失效，请执行 lark-cli auth login', 'auth', false);
      }

      return this.parseJsonOutput(stdout);
    } catch (error: any) {
      if (error instanceof LarkCliError) throw error;
      const errorStderr = typeof error?.stderr === 'string' ? error.stderr : '';
      const errorStdout = typeof error?.stdout === 'string' ? error.stdout : '';
      const rawMessage = `${errorStderr}\n${errorStdout}\n${error?.message ?? ''}`.trim();
      if (error?.killed && error?.signal === 'SIGTERM') {
        throw new LarkCliError('lark-cli 执行超时', 'timeout', true);
      }
      throw this.classifyError(rawMessage || '未知 lark-cli 错误');
    }
  }

  /**
   * Parse lark-cli JSON output with robust error handling
   * - Strips BOM, ANSI codes, and surrounding whitespace
   * - Extracts complete JSON values from log-prefixed output
   * - Merges multi-line NDJSON pages (not just the first/last brace span)
   * - Preserves original output in error message for debugging
   * - Handles both ok-result format (from api commands) and direct data format (from auth/wiki commands)
   */
  private parseJsonOutput(stdout: string): any {
    // Remove BOM (UTF-8) and ANSI escape codes
    const cleaned = stdout
      .replace(/^﻿/, '') // BOM
      .replace(/\x1b\[[0-9;]*m/g, '') // ANSI escape codes
      .trim();

    // Handle non-JSON output (e.g., version command). Log-prefixed JSON is
    // handled below by extractJsonValues rather than being mistaken for text.
    if (!cleaned.includes('{') && !cleaned.includes('[')) {
      return {
        ok: true,
        data: { version: cleaned },
      };
    }

    const values = this.extractJsonValues(cleaned);
    if (values.length === 0) {
      throw new LarkCliError('解析 lark-cli 输出失败：未找到有效 JSON 结构', 'parse', false);
    }

    const parsed: any[] = [];
    for (const value of values) {
      try {
        parsed.push(JSON.parse(value));
      } catch {
        // A log line may contain braces that are not JSON. Continue looking
        // for valid complete values; fail only when none are valid.
      }
    }
    if (parsed.length === 0) {
      throw new LarkCliError('解析 lark-cli 输出失败：JSON 格式无效', 'parse', false);
    }

    const normalized = parsed.map((value) => this.normalizeJsonResult(value));
    if (normalized.length === 1) return normalized[0];

    // NDJSON `--page-all` can emit a record per page. Preserve every array
    // field (notably data.nodes) and keep the latest scalar metadata.
    const mergedData: Record<string, unknown> = {};
    for (const result of normalized) {
      const data = result.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value)) {
          const prior = Array.isArray(mergedData[key]) ? mergedData[key] : [];
          mergedData[key] = [...prior, ...value];
        } else if (key === 'has_more' && typeof value === 'boolean') {
          // Pagination state is a scalar from the latest page; OR-ing would
          // incorrectly report true after a final page says false.
          mergedData[key] = value;
        } else {
          mergedData[key] = value;
        }
      }
    }
    return { ok: true, data: mergedData };
  }

  private normalizeJsonResult(value: any): { ok: true; data: any } {
    if (!value || typeof value !== 'object') {
      throw new LarkCliError('lark-cli 返回了非对象 JSON', 'parse', false);
    }
    if (value.ok === false || (typeof value.code === 'number' && value.code !== 0)) {
      const nestedError = value.error && typeof value.error === 'object'
        ? value.error as Record<string, unknown>
        : null;
      const message = String(
        value.msg ?? value.message ?? nestedError?.message ?? value.error ?? 'lark-cli 返回错误',
      );
      const upstreamCode = value.code == null
        ? (nestedError?.code == null ? undefined : String(nestedError.code))
        : String(value.code);
      throw this.classifyError(`${upstreamCode ?? ''} ${message}`.trim(), upstreamCode);
    }
    if (value.ok === true) return value;
    // Some lark-cli commands emit `{ data: ... }` without an `ok` wrapper;
    // normalize that shape without introducing the historic `data.data`
    // nesting. Raw command payloads (e.g. `{ nodes: [...] }`) still become
    // the data object directly.
    if ('data' in value) return { ok: true, data: value.data };
    return { ok: true, data: value };
  }

  /**
   * Extract balanced JSON object/array values while respecting quoted braces.
   * This safely handles ANSI-stripped logs before/after JSON and NDJSON pages.
   */
  private extractJsonValues(input: string): string[] {
    const values: string[] = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let opening = '';

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (start < 0) {
        if (char === '{' || char === '[') {
          start = index;
          depth = 1;
          opening = char;
          inString = false;
          escaped = false;
        }
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          const expectedEnd = opening === '{' ? '}' : ']';
          if (char === expectedEnd) values.push(input.slice(start, index + 1));
          start = -1;
          opening = '';
        }
      }
    }
    return values;
  }

  private classifyError(message: string, upstreamCode?: string): LarkCliError {
    const normalized = message.toLowerCase();
    if (/(?:99991400|rate limit|qps|限频|限流)/i.test(message)) {
      return new LarkCliError('QPS 限频，请稍后重试', 'rate_limited', true, upstreamCode ?? '99991400');
    }
    if (/(?:40403|131006|permission|forbidden|access denied|无权限)/i.test(message)) {
      return new LarkCliError('无权限访问该节点', 'permission', false, upstreamCode);
    }
    if (/(?:not authenticated|token expired|unauthorized|认证)/i.test(normalized)) {
      return new LarkCliError('认证失效，请执行 lark-cli auth login', 'auth', false, upstreamCode);
    }
    if (/(?:timeout|timed out|超时)/i.test(normalized)) {
      return new LarkCliError('lark-cli 执行超时', 'timeout', true, upstreamCode);
    }
    return new LarkCliError(`lark-cli 执行失败：${message}`, 'upstream', true, upstreamCode);
  }

  /**
   * Detect authentication errors from stderr
   */
  private detectAuthError(stderr: string): boolean {
    if (!stderr) return false;
    return stderr.includes('not authenticated') ||
           stderr.includes('token expired') ||
           stderr.includes('unauthorized');
  }

  /**
   * QPS throttling (token bucket algorithm)
   */
  private async throttle(apiType: 'wiki' | 'docx' | 'sheets'): Promise<void> {
    const limit = { wiki: 10, docx: 5, sheets: 5 }[apiType];
    const now = Date.now();
    const calls = this.qpsLimiter.get(apiType) || [];

    // Remove calls older than 1 second
    const recentCalls = calls.filter((t) => now - t < 1000);

    if (recentCalls.length >= limit) {
      const oldestCall = recentCalls[0];
      const waitTime = 1000 - (now - oldestCall);
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    recentCalls.push(now);
    this.qpsLimiter.set(apiType, recentCalls);
  }

  /**
   * Get default lark-cli executable path based on platform
   */
  private getDefaultLarkCliPath(): string {
    // On Windows, use lark-cli.cmd; on Unix, use lark-cli
    // On Windows with spawn EINVAL, try lark-cli.cmd first, then lark-cli
    if (process.platform === 'win32') {
      return 'lark-cli.cmd';
    }
    return 'lark-cli';
  }
}
