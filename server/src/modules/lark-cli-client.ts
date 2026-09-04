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
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'util';
import { SCOPE_ALIAS_GROUPS } from './config-manager.js';

/**
 * Windows shell 引号包裹（2026-09 实测事故：`C:\Program Files\nodejs\npm.cmd`
 * 含空格，spawn(shell:true) 把 file 裸拼进命令行，cmd.exe 把 `C:\Program`
 * 当命令 → 「不是内部或外部命令」→ npm_failed）。仅在 win32 且路径含空格
 * 时包裹双引号；已包裹/无空格/非 Win 原样返回。
 */
export function quoteWindowsExecutablePath(
  file: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return file;
  if (!/\s/.test(file)) return file;
  if (file.length >= 2 && file.startsWith('"') && file.endsWith('"')) return file;
  return `"${file}"`;
}

/**
 * Windows shell 参数引号包裹（2026-09 实测事故：表格浮动图片下载的
 * `--output ①idea-点子&印象_A1_…` 含 `&`，execFile(shell:true) 把 args
 * 数组裸 join 后整条交 cmd.exe，`&` 是命令分隔符 → 后半段被当作命令执行
 * → 「不是内部或外部命令」，三层下载全挂）。对含 cmd 元字符（空格 & | < >
 * ^ ( ) ; , ' ` =）的参数包裹双引号；已含双引号的参数（如 --data JSON）
 * 不动——cmd /s 模式下引号对的传递已验证可工作，再包一层反而破坏 JSON。
 * 非 Win 原样返回（无 shell，args 数组直接传递）。
 */
export function quoteWindowsShellArguments(
  args: string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32') return args;
  return args.map((arg) => {
    if (arg.includes('"')) return arg; // JSON 类参数，维持现状行为
    if (!/[\s&|<>^();,'`=]/.test(arg)) return arg;
    if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) return arg;
    return `"${arg}"`;
  });
}
import type { LarkCliNodeInfo, LarkCliConfig } from '../types/index.js';

const execFileAsync = promisify(execFile);

export type LarkCliErrorCode =
  | 'auth'
  | 'permission'
  | 'deleted'
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

export interface LarkCliAuthReadiness {
  ready: boolean;
  error?: string;
  larkCliVersion?: string;
  currentScopes?: string[];
  missingScopes?: string[];
  identity?: string;
}

/** A document reference accepted by Drive's batch metadata endpoint. */
export interface LarkCliDocumentMetaRequest {
  docToken: string;
  docType: string;
}

/** The small, content-free subset used by fast change detection. */
export interface LarkCliDocumentMeta {
  docToken: string;
  docType: string;
  latestModifyTime: number | null;
  title: string;
}

export interface LarkCliDocumentMetaBatchResult {
  metas: LarkCliDocumentMeta[];
  failed: Array<{ docToken: string; code?: number }>;
}

export interface LarkCliExecutableResolutionOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

type LarkCliApiType = 'wiki' | 'docx' | 'sheets' | 'drive' | 'auth';

// A Drive metadata request can describe 200 documents at once, so a low
// command rate is still substantially faster than individual node-get calls.
// Keep this deliberately below the observed tenant-side burst ceiling: the
// desktop poller, a manual recovery, and a sync may all share one lark-cli
// identity. The queue below serializes processes; these limits shape their
// aggregate request rate so a recovery does not cause 99991400/QPS failures.
const API_QPS_LIMITS: Record<LarkCliApiType, number> = {
  wiki: 3,
  docx: 2,
  sheets: 2,
  drive: 1,
  auth: 1,
};
/** Cross-endpoint ceiling: per-API buckets alone cannot prevent a burst. */
const GLOBAL_QPS_LIMIT = 3;
const GLOBAL_QPS_BUCKET = '__all_lark_cli_requests__';
const MAX_DRIVE_META_BATCH_SIZE = 200;

function isExplicitExecutablePath(value: string): boolean {
  return path.isAbsolute(value) || value.includes('/') || value.includes('\\');
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the first executable matching `names` within a PATH-style value.
 * Exported for reuse by LarkCliManager's npm discovery, which mirrors the
 * same desktop-PATH discovery problem (Finder-launched apps lack the user's
 * shell PATH). Splitting on path.delimiter makes it equally usable for a
 * synthesized directory list.
 */
export function findExecutableOnPath(
  names: string[],
  pathValue: string | undefined,
): string | null {
  if (!pathValue) return null;
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 获取 Node/npm/lark-cli 的全平台全版本管理器候选目录。
 * 覆盖现代 Node 环境：fnm, nvm, volta, pnpm, asdf, Homebrew, ~/.local/bin, ~/.npm-global/bin 等。
 *
 * 2026-09 E2BIG 修复：所有「按目录扫描」的候选均限量——multishell 是
 * 会话级临时目录，只取 mtime 最近的 8 个（实测重度用户机器上有 15 万个
 * 累积目录，全量拼入 PATH 会以 spawn E2BIG 炸掉子进程，且 readdirSync
 * 15 万项本身就是性能炸弹）；已安装版本取最新 5 个。发现阶段的语义
 * 不变：最近的 multishell / 最新的版本就是活跃可用的那份。
 */
const FNM_MULTISHELL_SCAN_LIMIT = 8;
const NODE_VERSION_SCAN_LIMIT = 5;

function recentDirectoriesBy(dir: string, limit: number): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const full = path.join(dir, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          /* raced deletion */
        }
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((entry) => entry.full);
  } catch {
    return [];
  }
}

export function getNodeRuntimeCandidateDirectories(
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') {
    return [
      env.APPDATA ? path.join(env.APPDATA, 'npm') : '',
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'npm') : '',
      path.join(homeDir, 'AppData', 'Roaming', 'npm'),
      path.join(homeDir, '.volta', 'bin'),
      path.join(homeDir, 'AppData', 'Local', 'pnpm'),
    ].filter(Boolean);
  }

  const dirs: string[] = [];

  // 1. fnm (Fast Node Manager) - current、最近的 multishells 与最新版本
  dirs.push(path.join(homeDir, '.local', 'share', 'fnm', 'current', 'bin'));
  try {
    const fnmVersionsDir = path.join(homeDir, '.local', 'share', 'fnm', 'node-versions');
    if (fs.existsSync(fnmVersionsDir)) {
      const versions = fs.readdirSync(fnmVersionsDir).sort().reverse()
        .slice(0, NODE_VERSION_SCAN_LIMIT);
      for (const v of versions) {
        dirs.push(path.join(fnmVersionsDir, v, 'installation', 'bin'));
      }
    }
  } catch {
    /* ignore */
  }
  for (const shellDir of recentDirectoriesBy(
    path.join(homeDir, '.local', 'state', 'fnm_multishells'),
    FNM_MULTISHELL_SCAN_LIMIT,
  )) {
    dirs.push(path.join(shellDir, 'bin'));
  }

  // 2. nvm - versions 目录与 current
  dirs.push(path.join(homeDir, '.nvm', 'current', 'bin'));
  try {
    const nvmVersionsDir = path.join(homeDir, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmVersionsDir)) {
      const versions = fs.readdirSync(nvmVersionsDir).sort().reverse()
        .slice(0, NODE_VERSION_SCAN_LIMIT);
      for (const v of versions) {
        dirs.push(path.join(nvmVersionsDir, v, 'bin'));
      }
    }
  } catch {
    /* ignore */
  }

  // 3. volta
  dirs.push(path.join(homeDir, '.volta', 'bin'));

  // 4. pnpm
  dirs.push(path.join(homeDir, 'Library', 'pnpm'));
  dirs.push(path.join(homeDir, '.local', 'share', 'pnpm'));

  // 5. asdf
  dirs.push(path.join(homeDir, '.asdf', 'shims'));
  dirs.push(path.join(homeDir, '.asdf', 'bin'));

  // 6. Homebrew / 系统全局
  dirs.push('/opt/homebrew/bin');
  dirs.push('/usr/local/bin');

  // 7. 用户本地免权限目录及标准位置
  dirs.push(path.join(homeDir, '.local', 'node', 'bin'));
  dirs.push(path.join(homeDir, '.local', 'bin'));
  dirs.push(path.join(homeDir, '.npm-global', 'bin'));

  return dirs.filter(Boolean);
}

/**
 * Resolve lark-cli without assuming Electron inherited the user's shell PATH.
 *
 * A macOS app launched from Finder normally receives only the system PATH,
 * while package managers commonly install lark-cli under ~/.local/node/bin or
 * ~/.npm-global/bin. The bare command worked in a terminal but failed in the
 * packaged application with `spawn lark-cli ENOENT`.
 */
export function resolveLarkCliExecutable(
  configuredPath?: string,
  options: LarkCliExecutableResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const executableNames = platform === 'win32'
    ? ['lark-cli.cmd', 'lark-cli.exe', 'lark-cli']
    : ['lark-cli'];
  const defaultCommand = executableNames[0];
  const preferred = configuredPath?.trim() || env.LARK_CLI_PATH?.trim();

  if (preferred) {
    // An explicit filesystem path is intentional. Keep it intact so a bad
    // user setting produces a precise execution error instead of silently
    // selecting a different installation.
    if (isExplicitExecutablePath(preferred)) return path.resolve(preferred);
    const fromPath = findExecutableOnPath([preferred], env.PATH ?? env.Path);
    if (fromPath) return fromPath;
    // `lark-cli` is the documented default. If it is not on PATH, continue
    // with the desktop-specific discovery locations below.
    if (preferred !== defaultCommand) return preferred;
  }

  const fromPath = findExecutableOnPath(executableNames, env.PATH ?? env.Path);
  if (fromPath) return fromPath;

  const candidateDirectories = getNodeRuntimeCandidateDirectories(homeDir, env, platform);

  for (const directory of candidateDirectories) {
    if (!directory) continue;
    for (const name of executableNames) {
      const candidate = path.join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }

  // Preserve the familiar executable name in the final error if none of the
  // supported locations exists. execFile will classify this as a clear
  // installation/path problem below.
  return defaultCommand;
}

/**
 * Ensure a script-style lark-cli can find the Node runtime next to it.
 * Global npm shims frequently use `#!/usr/bin/env node`; resolving the shim
 * alone is insufficient when Finder's PATH omits its bin directory.
 */
export function buildLarkCliEnvironment(
  executablePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!isExplicitExecutablePath(executablePath)) return { ...environment };

  const executableDirectory = path.dirname(path.resolve(executablePath));
  const pathKey = process.platform === 'win32' && environment.Path ? 'Path' : 'PATH';
  const currentPath = environment[pathKey] ?? environment.PATH ?? environment.Path ?? '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  const nextPath = [
    executableDirectory,
    ...entries.filter((entry) => entry !== executableDirectory),
  ].join(path.delimiter);

  return { ...environment, [pathKey]: nextPath };
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
  /**
   * The CLI process is shared by UI reads, the desktop poller and explicit
   * actions. Serializing invocation removes the last cross-root race that a
   * per-endpoint token bucket alone cannot prevent.
   */
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(private config: LarkCliConfig) {}

  /**
   * Apply a configuration change without requiring the desktop process to
   * restart. This is used after the Settings page saves the required scope
   * set. lark-cli 路径已不可配置（2026-10），不再经由该入口更新。
   */
  updateConfig(config: Partial<LarkCliConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Execute a command through the sole subprocess/timeout/parser/error path.
   * Higher-level helpers below are intentionally thin wrappers so callers
   * never duplicate lark-cli invocation policy.
   */
  async execute(
    args: string[],
    apiType: LarkCliApiType = 'wiki',
    executionOptions?: LarkCliExecutionOptions,
  ): Promise<any> {
    const pending = this.commandQueue.then(
      async () => {
        await this.throttle(apiType);
        return this.execLarkCli(args, executionOptions);
      },
      async () => {
        await this.throttle(apiType);
        return this.execLarkCli(args, executionOptions);
      },
    );
    // Keep the queue alive after a failed command; callers still receive the
    // original rejection through `pending`.
    this.commandQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
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
   * List a sub-sheet's floating images (sheets +float-image-list).
   * Returns the raw response; sheet-media.parseSheetFloatImages does the
   * tolerant normalization (snake/camel keys, missing sheets wrap, etc.).
   */
  async getSheetFloatImages(options: {
    spreadsheetToken: string;
    sheetId: string;
  }): Promise<any> {
    return this.execute([
      'sheets', '+float-image-list',
      '--spreadsheet-token', options.spreadsheetToken,
      '--sheet-id', options.sheetId,
      '--format', 'json',
    ], 'sheets');
  }

  /**
   * Check if lark-cli is ready (version + authentication + scope validation)
   */
  async checkAuthReady(): Promise<LarkCliAuthReadiness> {
    try {
      // 1. Check if lark-cli is installed
      const versionResult = await this.execute(['--version'], 'auth');
      const larkCliVersion = typeof versionResult.data?.version === 'string'
        ? versionResult.data.version
        : undefined;
      if (!versionResult.ok) {
        return {
          ready: false,
          error: 'lark-cli 未安装，请执行 npm install -g lark-cli',
          larkCliVersion,
        };
      }

      // 2. Check authentication status
      const statusResult = await this.execute(['auth', 'status'], 'auth');
      if (!statusResult.data || !statusResult.data.identity) {
        return {
          ready: false,
          error: '未认证，请执行 lark-cli auth login',
          larkCliVersion,
        };
      }

      const identity = statusResult.data.identity;
      if (identity !== 'user') {
        return {
          ready: false,
          error: `认证身份不是 user，当前身份: ${identity}`,
          larkCliVersion,
          identity,
        };
      }

      // 3. Check required scopes (scopes are space-separated string in identities.user.scope).
      //    SCOPE_ALIAS_GROUPS：飞书新旧 scope 名交替期，授权端可能只授予组内
      //    某一个名字（如旧 docx:document:readonly vs 新 docs:document:read）。
      //    组内任一命中即视为满足，避免对新名的误报阻断认证（2026-09 实测
      //    「缺少权限：docs:document:read」即旧授权只持旧名触发；2026-10 起
      //    默认需求集已不再要求该名，此兑底仅为手改配置/旧 token 兼容）。
      const scopesString = statusResult.data.identities?.user?.scope || '';
      const currentScopes = scopesString.split(' ').filter((s: string) => s.length > 0);
      const currentScopeSet = new Set(currentScopes);
      const isScopeSatisfied = (scope: string): boolean => {
        if (currentScopeSet.has(scope)) return true;
        return SCOPE_ALIAS_GROUPS.some(
          (group) => group.includes(scope) && group.some((alias) => currentScopeSet.has(alias)),
        );
      };
      const missingScopes = this.config.requiredScopes.filter((s) => !isScopeSatisfied(s));
      if (missingScopes.length > 0) {
        return {
          ready: false,
          error: `缺少权限：${missingScopes.join(', ')}。请在应用内点击「开始飞书认证」重新授权补齐；若重新授权后仍缺失，多为 lark-cli 版本过旧（应用凭据未发布该权限时授权端会静默丢弃不授），可尝试「更新 lark-cli」后重试`,
          larkCliVersion,
          currentScopes,
          missingScopes,
          identity,
        };
      }

      return {
        ready: true,
        larkCliVersion,
        currentScopes,
        missingScopes: [],
        identity,
      };
    } catch (error) {
      return {
        ready: false,
        error: `认证检查失败：${error instanceof Error ? error.message : String(error)}`,
      };
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

    // Two ndjson generations must both resolve to a node array:
    // - ≤1.0.72 page shape: `{ ok, data: { has_more, nodes: [...] } }` per page,
    //   merged by parseJsonOutput's page-merger into data.nodes.
    // - ≥1.0.89 bare entity stream: parseJsonOutput aggregates it into
    //   data.records (see the incident note there).
    const data = result?.data;
    if (Array.isArray(data?.records) && !Array.isArray(data?.nodes)) {
      return data.records as LarkCliNodeInfo[];
    }
    return data?.nodes || [];
  }

  /**
   * Read document metadata in batches of up to 200 without downloading any
   * document body. `latest_modify_time` is the authoritative signal used by
   * the fast detector to answer whether an already-mapped cloud document
   * changed.
   */
  async getDocumentMetas(
    requests: LarkCliDocumentMetaRequest[],
  ): Promise<LarkCliDocumentMetaBatchResult> {
    if (requests.length === 0) return { metas: [], failed: [] };
    if (requests.length > MAX_DRIVE_META_BATCH_SIZE) {
      throw new Error(
        `drive metadata batch exceeds ${MAX_DRIVE_META_BATCH_SIZE} documents: ${requests.length}`,
      );
    }

    const result = await this.execute([
      'drive', 'metas', 'batch_query', '--format', 'json',
      '--data',
      JSON.stringify({
        request_docs: requests.map((request) => ({
          doc_token: request.docToken,
          doc_type: request.docType,
        })),
      }),
    ], 'drive');
    const payload = result.data ?? {};
    const metas = Array.isArray(payload.metas)
      ? payload.metas.map((meta: Record<string, unknown>) => {
          const parsedTime = Number.parseInt(String(meta.latest_modify_time ?? ''), 10);
          const requestInfo = meta.request_doc_info as Record<string, unknown> | undefined;
          return {
            docToken: String(meta.doc_token ?? requestInfo?.doc_token ?? ''),
            docType: String(meta.doc_type ?? requestInfo?.doc_type ?? ''),
            latestModifyTime: Number.isFinite(parsedTime) ? parsedTime : null,
            title: typeof meta.title === 'string' ? meta.title : '',
          };
        }).filter((meta: LarkCliDocumentMeta) => meta.docToken.length > 0)
      : [];
    const failed = Array.isArray(payload.failed_list)
      ? payload.failed_list.map((entry: Record<string, unknown>) => ({
          docToken: String(entry.token ?? ''),
          code: typeof entry.code === 'number' ? entry.code : undefined,
        })).filter((entry: { docToken: string }) => entry.docToken.length > 0)
      : [];

    return { metas, failed };
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
      // Parent topology is needed by ChangeDetector's safe local-path
      // planner. Omitting this field made detail lookups unable to repair a
      // parent chain when node-list returned an incomplete branch.
      parent_node_token: typeof result.data.parent_node_token === 'string'
        ? result.data.parent_node_token
        : undefined,
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
    // larkCliPath 已不是用户配置项（2026-10）：生产链路不再从 Config 接线，
    // this.config.larkCliPath 仅作为测试哨兵注入点存在（缺省 undefined →
    // 走 PATH + 桌面发现目录解析）；LARK_CLI_PATH 环境变量仍可作部署级覆盖。
    const larkCliPath = resolveLarkCliExecutable(this.config.larkCliPath);
    const timeout = this.config.timeout || 30000;

    try {
      const { stdout, stderr } = await execFileAsync(
        quoteWindowsExecutablePath(larkCliPath),
        quoteWindowsShellArguments(args),
        {
          timeout,
          encoding: 'utf-8',
          shell: process.platform === 'win32', // Use shell on Windows for .cmd files
          env: buildLarkCliEnvironment(larkCliPath),
          ...(executionOptions?.cwd ? { cwd: executionOptions.cwd } : {}),
        },
      );

      // Detect authentication errors
      if (this.detectAuthError(stderr)) {
        throw new LarkCliError('认证失效，请执行 lark-cli auth login', 'auth', false);
      }

      return this.parseJsonOutput(stdout);
    } catch (error: any) {
      if (error instanceof LarkCliError) throw error;
      if (error?.code === 'ENOENT') {
        throw new LarkCliError(
          '未找到 lark-cli。请安装 lark-cli，或在「设置」中填写它的可执行文件路径。',
          'upstream',
          false,
        );
      }
      const errorStderr = typeof error?.stderr === 'string' ? error.stderr : '';
      const errorStdout = typeof error?.stdout === 'string' ? error.stdout : '';
      const rawMessage = `${errorStderr}\n${errorStdout}\n${error?.message ?? ''}`.trim();
      if (error?.killed && error?.signal === 'SIGTERM') {
        throw new LarkCliError('lark-cli 执行超时', 'timeout', true);
      }
      // Real lark-cli API failures (e.g. `wiki +node-get` on a pure cloud
      // document returns 131005 "document is not in wiki") exit non-zero but
      // still honor `--format json`, writing the structured error to the
      // process output before it fails. 实测 confirmed: the JSON error body
      // lands on stderr (stdout empty) with exit code 1. execFile surfaces
      // captured stderr/stdout on `error.stderr`/`error.stdout`, which we
      // folded into rawMessage above; recover the numeric code here so it
      // reaches LarkCliError.upstreamCode. Without this, classifyError was
      // called with only the raw text and the code was lost, so downstream
      // guards keying on `upstreamCode === '131005'` (custom-folders
      // pure-docx fallback) could never fire (P0: pure /docx/ cloud links
      // failed to archive).
      const upstreamCode = this.extractUpstreamCode(rawMessage);
      throw this.classifyError(rawMessage || '未知 lark-cli 错误', upstreamCode);
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

    // lark-cli ≥1.0.89 `--format ndjson` emits a BARE entity stream: one raw
    // entity object per line with no `ok`/`data` wrapper and no page shape
    // (`{has_more, nodes}` per page in ≤1.0.72). normalizeJsonResult maps each
    // line to {ok, data:<entity>}; the page-merger below would then collapse
    // the stream into the LAST entity's scalar fields, silently losing every
    // other record (2026-09 real incident: BFS saw an empty tree while
    // `complete=true`, mass-marking 146 synced documents as missing_candidate
    // deletion candidates). Detect the bare-entity shape up front and
    // aggregate every record under `data.records`.
    const allBareEntities = parsed.every((value) =>
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && !('ok' in value)
      && !('data' in value)
      && !Object.values(value).some((field) => Array.isArray(field))
    );
    if (allBareEntities) {
      return { ok: true, data: { records: normalized.map((entry) => entry.data) } };
    }

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

  /**
   * Recover the upstream numeric error code from a non-zero-exit error blob.
   *
   * When lark-cli exits non-zero on an API error, it still honors
   * `--format json` and writes the structured error (实测: to stderr, e.g.
   * `{"ok":false,"error":{"code":131005,...}}`, with stdout empty and exit
   * code 1) before the process fails. Node's execFile surfaces the captured
   * stderr/stdout on `error.stderr`/`error.stdout`, which execLarkCli folds
   * into rawMessage. This restores the code so it reaches
   * LarkCliError.upstreamCode, by:
   *   1. parsing the JSON error body honoring --format json (precise path),
   *      reusing extractJsonValues so log-prefixed / NDJSON output is handled;
   *   2. falling back to a regex over the known lark/feishu API code set that
   *      this module already classifies, to avoid false positives from
   *      PIDs/ports/byte counts in stderr log lines.
   */
  private extractUpstreamCode(rawMessage: string): string | undefined {
    // 1. Structured path: lark-cli --format json emits the error as JSON.
    try {
      for (const text of this.extractJsonValues(rawMessage)) {
        let value: any;
        try {
          value = JSON.parse(text);
        } catch {
          continue;
        }
        if (value && typeof value === 'object') {
          const nested = value.error && typeof value.error === 'object'
            ? value.error as Record<string, unknown>
            : null;
          const code = value.code ?? nested?.code;
          if (typeof code === 'number' || (typeof code === 'string' && code.trim() !== '')) {
            return String(code);
          }
        }
      }
    } catch {
      // extractJsonValues is itself defensive; fall through to the regex.
    }
    // 2. Textual fallback: match a known API code embedded in stderr text.
    //    \b boundaries prevent matching inside longer digit runs (e.g. a PID).
    const known = rawMessage.match(/\b(131005|131006|40403|3380003|99991400)\b/);
    return known ? known[1] : undefined;
  }

  private classifyError(message: string, upstreamCode?: string): LarkCliError {
    const normalized = message.toLowerCase();
    if (
      upstreamCode === '3380003'
      || /(?:3380003|document page has been deleted|page can no longer be edited|文档.*已删除)/i.test(message)
    ) {
      return new LarkCliError(
        '云端文档已删除或不再可编辑，请在飞书中选择有效文档后重新检测',
        'deleted',
        false,
        upstreamCode ?? '3380003',
      );
    }
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
  private async throttle(apiType: LarkCliApiType): Promise<void> {
    // The global bucket comes first because an API-specific queue can be
    // empty while another endpoint has just consumed the tenant's allowance.
    await this.throttleBucket(GLOBAL_QPS_BUCKET, GLOBAL_QPS_LIMIT);
    await this.throttleBucket(apiType, API_QPS_LIMITS[apiType]);
  }

  private async throttleBucket(bucket: string, limit: number): Promise<void> {
    while (true) {
      const now = Date.now();
      const calls = this.qpsLimiter.get(bucket) || [];
      // Remove calls older than one second before deciding whether another
      // command may start. Recompute after waiting so timestamps stay real.
      const recentCalls = calls.filter((t) => now - t < 1000);
      if (recentCalls.length < limit) {
        recentCalls.push(now);
        this.qpsLimiter.set(bucket, recentCalls);
        return;
      }

      const waitTime = Math.max(1, 1000 - (now - recentCalls[0]));
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

}
