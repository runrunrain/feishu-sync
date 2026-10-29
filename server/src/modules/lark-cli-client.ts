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

/**
 * 「lark-cli 未找到」的规范文案。getToolStatus（lark-cli-manager.ts）用
 * `未找到|未安装` 正则识别未安装状态并点亮前端「一键安装」面板——两处
 * 抛出点共享同一常量，防止文案漂移破坏该判定。
 */
export const LARK_CLI_NOT_FOUND_MESSAGE =
  '未找到 lark-cli。请安装 lark-cli，或在「设置」中填写它的可执行文件路径。';

/**
 * 判断可执行名是否为「裸命令名」（不含任何路径分隔符）。
 *
 * resolveLarkCliExecutable 只有在 PATH 与全部桌面发现目录都未命中时才会
 * 返回裸命令名（win32 缺省 'lark-cli.cmd'）——这是「全平台确定性未找到」
 * 的信号：此时 spawn 注定失败。非裸（含 / 或 \）都是已解析的具体路径。
 */
export function isBareCommandName(executable: string): boolean {
  return !executable.includes('/') && !executable.includes('\\');
}

const execFileAsync = promisify(execFile);

export type LarkCliErrorCode =
  | 'auth'
  | 'permission'
  | 'deleted'
  | 'not_in_wiki'
  | 'missing_scope'
  | 'rate_limited'
  | 'timeout'
  | 'parse'
  | 'upstream'
  // P0-S2（P0-S1 实测定稿，fixture p0s1-lark-cli）：10020 = history revert
  // 并发单飞（可重试·先轮询）；3380002 = 回滚目标无效（含最新条目不可作
  // 目标）；981003 = update-title 类型错配。尾部追加，既有分类零改动。
  | 'conflict'
  | 'invalid_target'
  | 'type_mismatch'
  // T4b-06（lark-cli-client 层）：非幂等写命令（create/revert/move）已发出
  // 后，响应缺少必要字段（如 status/task_id/document_id）——云端可能已
  // 受理，但结果无法从响应判定。这是「未知」类信号，不是「明确失败」；
  // 不可重试（retryable=false，重发会造成重复写），由服务层置 unknown。
  | 'incomplete_response';

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
  /** Export shortcuts include server-side polling and need a longer budget. */
  timeoutMs?: number;
}

export interface MediaOutputTarget {
  directory: string;
  outputName: string;
  requestedPath: string;
}

/** slides +screenshot 单页输出映射（设计 §3.2：文件↔页号映射以 JSON 输出为准）。 */
export interface SlidesScreenshotOutput {
  slideNumber: number;
  /** 输出文件的绝对路径（已校验位于请求的 outputDir 围栏内）。 */
  path: string;
}

export interface LarkCliAuthReadiness {
  ready: boolean;
  error?: string;
  larkCliVersion?: string;
  currentScopes?: string[];
  missingScopes?: string[];
  identity?: string;
  verified?: boolean;
  account?: { id: string; name?: string };
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

// -------------------------------------------------------------------------
// P0-S2 新能力 DTO（lark-cli-newcaps-P0 §3 + §10 P0-S1 实测定稿；真实输出
// 样本 fixture：server/tests/fixtures/p0s1-lark-cli/）。三能力共用：history
// （A 写回历史安全网）、whiteboard export（B 白板 SVG 通路）、update-title
// （C 标题同步）。
// -------------------------------------------------------------------------

/** docs +history-list 单条历史条目（P0-S1 HP-1 实测形态）。 */
export interface DocHistoryEntry {
  /**
   * 历史版本 id：字符串（1024×n 步进），与 revision_id 无耦合。回滚目标
   * 与写前锚点都用它（注意：`docs +fetch --revision-id` 收的是数值
   * revision_id，不是它）。
   */
  historyVersionId: string | null;
  /** 数值 revision id（与 `+fetch --revision-id` 同一 id 空间）。 */
  revisionId: number | null;
  /** RFC3339Z（秒级取整）；同一操作产生的多条目可共享同一时间。 */
  editTime: string | null;
  /** 编辑者 open_id 数组（上游无姓名字段；要姓名需另查通讯录，v1 不做）。 */
  editorIds: string[];
  /** 1=建档 / 2=普通编辑 / 3=revert 产生的历史（UI 可标注「回滚快照」）。 */
  type: number | null;
  /** 原始条目，仅诊断用途，不进对外 DTO。 */
  raw: unknown;
}

/** docs +history-list 一页结果（条目按新→旧排序）。 */
export interface DocumentHistoryPage {
  entries: DocHistoryEntry[];
  hasMore: boolean;
  /** has_more=true 时下一页令牌；否则 null（fixture：末页 page_token 为空串）。 */
  nextPageToken: string | null;
}

/** docs +history-revert 结果（同步 done / 异步 running 两形态）。 */
export interface DocumentHistoryRevertResult {
  status: 'done' | 'running' | 'failed' | 'partial_failed';
  /** done 形态仍返回 task_id（P0-S1 HP-2 实测）。 */
  taskId: string | null;
  /** 轮询建议间隔（running 形态实测 10000；done 为 0）。 */
  pollAfterMs: number | null;
  /** 部分块回滚失败清单（revert 响应一般不带；状态轮询接口必带）。 */
  failedBlockTokens: string[] | null;
}

/** docs +history-revert-status 轮询结果。 */
export interface DocumentHistoryRevertStatus {
  /** 未知取值归一为 running，由调用方按上限轮询（§3 双读容错原则）。 */
  status: 'done' | 'running' | 'failed' | 'partial_failed';
  /** 非空 = 部分块回滚失败，服务层必须读取并上抛警告（P0-S1 HP-2）。 */
  failedBlockTokens: string[] | null;
}

/** drive +update-title 归一化结果（原始响应见 raw）。 */
export interface UpdateDocumentTitleResult {
  fileToken: string | null;
  title: string | null;
  type: string | null;
  updated: boolean;
  url: string | null;
  raw: unknown;
}

/** 容错读取字符串数组字段：缺失/非数组 → null；元素按类型过滤。 */
function toStringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string');
}

export interface LarkCliExecutableResolutionOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

type LarkCliApiType = 'wiki' | 'docx' | 'sheets' | 'base' | 'drive' | 'slides' | 'auth';

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
  // bitable (多维表格) read 端点。翻页导出（tables/fields/views/records）
  // 每次同步会集中连续调用，保守 10：仍受全局 3 QPS 桶约束，实际聚合
  // 速率不变，这里只决定 base 桶自身的上限。
  base: 10,
  drive: 1,
  // P1-B slides 截图（设计 §3.2）：服务端逐页渲染，限 1 QPS；仍受全局
  // 3 QPS 桶约束。
  slides: 1,
  auth: 1,
};
/** Cross-endpoint ceiling: per-API buckets alone cannot prevent a burst. */
const GLOBAL_QPS_LIMIT = 3;
const GLOBAL_QPS_BUCKET = '__all_lark_cli_requests__';
const MAX_DRIVE_META_BATCH_SIZE = 200;

/**
 * 截断 lark-cli 失败输出，防错误日志爆炸（2026-09 实测：maxBuffer/上游
 * 失败时 error.stdout 可携带数 MB 表格内容，40 次失败写出 42MB
 * sync-errors.log）。保留头部 2KB（上下文）+ 尾部 6KB（结构化错误体
 * 与错误码通常在输出末尾，extractUpstreamCode 依赖它能命中）。
 */
function clipForLog(text: string): string {
  if (text.length <= 8192) return text;
  return `${text.slice(0, 2048)}\n...[截断，原长度 ${text.length} 字符]...\n${text.slice(-6144)}`;
}

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

  async fetchDocumentMarkdown(objToken: string, opts?: { revisionId?: number }): Promise<any> {
    // opts.revisionId：P0-S5 对比弹窗只读云端历史正文（`docs +fetch --revision-id`，
    // id 空间=history 的 revision_id 数值——P0-S1 实测 HP-3；缺省不传=最新版）。
    const args = [
      'docs', '+fetch', '--api-version', 'v2', '--doc', objToken,
      '--doc-format', 'markdown', '--detail', 'simple',
    ];
    if (typeof opts?.revisionId === 'number' && Number.isFinite(opts.revisionId)) {
      args.push('--revision-id', String(Math.floor(opts.revisionId)));
    }
    return this.execute(args, 'docx');
  }

  /** Read the authoritative XML presentation body for a Slides object. */
  async fetchSlidesXml(xmlPresentationId: string): Promise<any> {
    return this.execute([
      'slides', 'xml_presentations', 'get', '--as', 'user',
      '--xml-presentation-id', xmlPresentationId,
      '--revision-id', '-1',
      '--format', 'json',
    ], 'docx');
  }

  // -------------------------------------------------------------------------
  // P1-B slides 截图（设计 §3.2；P1-S1 SP-1/SP-2 实测输入）：
  // - argv：`slides +screenshot --as user --presentation <id>
  //   --slide-number <n1,n2,…> --output-dir <rel> --format json`；
  //   `--slide-number` 为 pflag ints，"1,2" 逗号形式已实测解析通过；
  //   单请求 ≤10 页，超出由本方法拒绝（分批在 SyncEngine 层）。
  // - scope：`slides:presentation:screenshot` 当前未授权时 CLI 以 exit 3 +
  //   missing_scope 错误体拒绝（原文见 tests/fixtures/p1s1-lark-cli/），
  //   经 classifyError 透传为 code='missing_scope'，由上层引导增量授权。
  // - 输出围栏同 fetchMediaToPath：子进程 cwd = outputDir 父目录，
  //   --output-dir 传相对名；返回路径逐条校验不逃逸。
  // - 页号↔文件映射：优先 JSON 输出（SP-2 授权后待实测定型，这里做宽容
  //   多形态解析）；无映射时退化为输出目录扫描（文件名含数字按数值排序
  //   配对页号），数量不匹配则拒绝。只追加方法，既有读链路零改动。
  // -------------------------------------------------------------------------

  /** 批量采集幻灯片页面截图；返回每页的输出文件路径映射。 */
  async screenshotSlides(
    xmlPresentationId: string,
    options: { slideNumbers: number[]; outputDir: string },
  ): Promise<SlidesScreenshotOutput[]> {
    if (typeof xmlPresentationId !== 'string' || !xmlPresentationId.trim()) {
      throw new Error(
        `screenshotSlides requires a non-empty presentation token; received: ${String(xmlPresentationId)}`,
      );
    }
    if (typeof options.outputDir !== 'string' || !options.outputDir.trim()) {
      throw new Error(`screenshotSlides requires a non-empty outputDir; received: ${String(options.outputDir)}`);
    }
    if (!Array.isArray(options.slideNumbers) || options.slideNumbers.length === 0) {
      throw new Error('screenshotSlides 仅接受 1–10 个页码，收到空列表');
    }
    // 升序去重：确定性的 argv（与退化扫描的页号↔文件配对顺序一致）。
    const unique = [...new Set(options.slideNumbers)].sort((a, b) => a - b);
    if (unique.length > 10 || unique.some((n) => !Number.isInteger(n) || n < 1)) {
      throw new Error(
        `screenshotSlides 仅接受 1–10 个正整数页码，实际: ${JSON.stringify(options.slideNumbers)}`,
      );
    }

    const requestedDir = path.resolve(options.outputDir);
    const parentDir = path.dirname(requestedDir);
    const dirName = path.basename(requestedDir);
    fs.mkdirSync(requestedDir, { recursive: true });
    const args = [
      'slides', '+screenshot', '--as', 'user',
      '--presentation', xmlPresentationId,
      '--slide-number', unique.join(','),
      '--output-dir', dirName,
      '--format', 'json',
    ];
    // 服务端逐页渲染较慢：给足 10 页批的余量（对齐 exportWorkbook 预算量级）。
    const result = await this.execute(args, 'slides', { cwd: parentDir, timeoutMs: 120_000 });

    let entries = this.extractSlidesScreenshotEntries(result);
    if (entries.length === 0) {
      entries = this.scanSlidesScreenshotDir(requestedDir, [...unique].sort((a, b) => a - b));
    }
    if (entries.length === 0) {
      throw new LarkCliError(
        `slides +screenshot 未返回页号↔文件映射，且输出目录无可配对文件: ${requestedDir}`,
        'parse',
        false,
      );
    }

    const resolved = entries.map((entry) => {
      // CLI 相对路径优先按子进程 cwd（parentDir）解析；不存在时兑底按
      // 输出目录相对解析（SP-2 未定型：两种基准都可能出现，最终都以围栏
      // 校验为准，不改变拒绝逃逸语义）。
      const fromCwd = path.resolve(parentDir, entry.path);
      const fromDir = path.resolve(requestedDir, entry.path);
      return {
        slideNumber: entry.slideNumber,
        path: fs.existsSync(fromCwd) ? fromCwd : fromDir,
      };
    });
    for (const entry of resolved) {
      if (!isPathInsideDirectory(requestedDir, entry.path)) {
        throw new LarkCliError(
          `lark-cli 返回了输出目录外的截图路径: ${entry.path}`,
          'upstream',
          false,
        );
      }
    }
    return resolved;
  }

  /**
   * 从 slides +screenshot 的 JSON 响应中宽容提取页号↔文件条目：深度 ≤4
   * 递归扫描，命中「页号键 + 路径键」共现的对象即收（SP-2 形态未定，
   * 覆盖 data.screenshots[] / 裸数组 / snake/camel 键名等候选）。
   */
  private extractSlidesScreenshotEntries(
    payload: unknown,
    depth = 0,
    out: Array<{ slideNumber: number; path: string }> = [],
  ): Array<{ slideNumber: number; path: string }> {
    if (Array.isArray(payload)) {
      for (const item of payload) this.extractSlidesScreenshotEntries(item, depth + 1, out);
      return out;
    }
    if (!payload || typeof payload !== 'object' || depth > 4) return out;
    const record = payload as Record<string, unknown>;
    const slideRaw = record.slide_number ?? record.slideNumber ?? record.slide ?? record.page ?? record.page_number;
    const slideNumber = Number(slideRaw);
    const rawPath = record.saved_path ?? record.path ?? record.file ?? record.file_path ?? record.output;
    if (Number.isInteger(slideNumber) && slideNumber >= 1 && typeof rawPath === 'string' && rawPath.trim()) {
      out.push({ slideNumber, path: rawPath.trim() });
      return out;
    }
    for (const key of Object.keys(record)) {
      // 提示文案与诊断消息不是映射载体，跳过以防误扫。
      if (key === 'hint' || key === 'message' || key === 'error') continue;
      this.extractSlidesScreenshotEntries(record[key], depth + 1, out);
    }
    return out;
  }

  /**
   * SP-2 未定型时的退化通道：扫描输出目录文件，按文件名中的数值排序后
   * 与升序页码一一配对；文件数与页码数不匹配则返回空（上层拒绝）。
   */
  private scanSlidesScreenshotDir(
    requestedDir: string,
    sortedSlideNumbers: number[],
  ): Array<{ slideNumber: number; path: string }> {
    let names: string[];
    try {
      names = fs
        .readdirSync(requestedDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const numericKey = (name: string): { n: number; name: string } => {
      const match = /\d+/.exec(name);
      return { n: match ? Number(match[0]) : Number.MAX_SAFE_INTEGER, name };
    };
    const sorted = names.map(numericKey).sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
    if (sorted.length !== sortedSlideNumbers.length) return [];
    return sorted.map((entry, index) => ({
      slideNumber: sortedSlideNumbers[index],
      path: path.join(requestedDir, entry.name),
    }));
  }

  // -------------------------------------------------------------------------
  // S12 飞书写回（设计 §7.5；S0-write-probe 实测定稿）。只新增方法，既有
  // 读链路零改动。argv 形态锁死 S0 实测版本：
  //   docs +update --doc <t> --command append|overwrite
  //              --doc-format markdown --content @<tmpfile> [--revision-id <rev>] --json
  //
  // `@file` 只接受子进程 cwd 相对路径（S0 §②-S2 实测：绝对路径报
  // `unsafe file path`；execute 的 executionOptions.cwd 直通 execFile 的
  // options.cwd，因此正文经临时目录 + 纯文件名传入，绝不落 argv/日志
  // （设计 §9.1 不变量 5：写回内容经临时文件传 lark-cli））。
  // -------------------------------------------------------------------------

  /** 追加 markdown 正文（非幂等；调用方负责不重试）。 */
  async updateDocumentAppend(
    objToken: string,
    markdown: string,
  ): Promise<{ revisionId: number | null; warnings: string[]; raw: any }> {
    return this.updateDocument(objToken, 'append', markdown);
  }

  /**
   * 全量覆盖正文（markdown）。revisionId 仅防「未来值」（S0 D5 实测：旧
   * revision 会被静默接受并造成内容重复损坏——服务层三段式协议保证
   * revision 来自同流程的即时 fetch，且绝不重试旧值）。
   */
  async overwriteDocument(
    objToken: string,
    markdown: string,
    revisionId: number,
  ): Promise<{ revisionId: number | null; warnings: string[]; raw: any }> {
    return this.updateDocument(objToken, 'overwrite', markdown, revisionId);
  }

  /** update 命令公共封装：临时目录 + cwd 相对 @file + 容错响应解析。 */
  private async updateDocument(
    objToken: string,
    command: 'append' | 'overwrite',
    markdown: string,
    revisionId?: number,
  ): Promise<{ revisionId: number | null; warnings: string[]; raw: any }> {
    if (typeof objToken !== 'string' || objToken.trim().length === 0) {
      throw new Error(`updateDocument requires a non-empty objToken; received: ${String(objToken)}`);
    }
    if (typeof markdown !== 'string') {
      throw new Error('updateDocument requires markdown to be a string');
    }
    // 独立临时目录：正文不进 argv/日志；@file 用纯文件名 = 子进程 cwd 相对路径。
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-push-'));
    try {
      const fileName = 'content.md';
      fs.writeFileSync(path.join(stagingDir, fileName), markdown, 'utf-8');
      const args = [
        'docs', '+update',
        '--doc', objToken,
        '--command', command,
        '--doc-format', 'markdown',
        '--content', `@${fileName}`,
      ];
      if (command === 'overwrite') {
        args.push('--revision-id', String(revisionId));
      }
      args.push('--json');
      const result = await this.execute(args, 'docx', {
        cwd: stagingDir,
        // overwrite 是服务端单请求全量替换，大文档余量对齐 export 预算。
        timeoutMs: 120_000,
      });
      const revision = result?.revision_id ?? result?.data?.revision_id ?? result?.data?.document?.revision_id;
      const warnings = Array.isArray(result?.warnings)
        ? result.warnings.filter((item: unknown) => typeof item === 'string')
        : [];
      return {
        revisionId: typeof revision === 'number' && Number.isFinite(revision) ? revision : null,
        warnings,
        raw: result,
      };
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  /**
   * 读取文档当前 revision（S0 D6：docx v1 documents API 写后即时可读，
   * 无延迟；返回 { revisionId, title? }，失败原样抛 LarkCliError）。
   */
  async fetchDocumentRevision(
    objToken: string,
  ): Promise<{ revisionId: number | null; title?: string }> {
    const result = await this.execute([
      'api', 'GET', `/open-apis/docx/v1/documents/${objToken}`, '--format', 'json',
    ], 'docx');
    const data = result?.data ?? result;
    const document = data?.document ?? {};
    const revision = data?.revision_id ?? document?.revision_id;
    return {
      revisionId: typeof revision === 'number' && Number.isFinite(revision) ? revision : null,
      title: typeof document?.title === 'string' ? document.title : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // P1-S8 反向发布（设计 P1 §4.4/§4.5；P1-S1 PB-1/PB-2 实测定稿 argv）。
  // 只新增方法，既有读写链路零改动：
  //   docs +create --doc-format markdown --title <t> --content @<tmpfile>
  //                --parent-token <target> --format json
  //   docs +script --command parse --doc <t> --format json
  // 正文经临时目录 + 子进程 cwd 相对 @file 传入（与 updateDocument 同一
  // 实测约束与安全属性：不落 argv/日志；@file 只接受 cwd 相对路径）。
  // -------------------------------------------------------------------------

  /**
   * 以 Markdown 直传创建云文档（P1-S1 实测：--title 只前置标题不去重
   * 正文同名 H1——去重由调用方 renderForPublish 承担；响应
   * data.document.{document_id, revision_id, url}）。
   */
  async createDocumentMarkdown(options: {
    title: string;
    markdown: string;
    parentToken: string;
  }): Promise<{ documentId: string; url: string | null; revisionId: number | null }> {
    if (typeof options.title !== 'string' || options.title.trim().length === 0) {
      throw new Error('createDocumentMarkdown requires a non-empty title');
    }
    if (typeof options.markdown !== 'string') {
      throw new Error('createDocumentMarkdown requires markdown to be a string');
    }
    if (typeof options.parentToken !== 'string' || options.parentToken.trim().length === 0) {
      throw new Error('createDocumentMarkdown requires a non-empty parentToken');
    }
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-publish-'));
    try {
      const fileName = 'content.md';
      fs.writeFileSync(path.join(stagingDir, fileName), options.markdown, 'utf-8');
      const args = [
        'docs', '+create',
        '--doc-format', 'markdown',
        '--title', options.title,
        '--content', `@${fileName}`,
        '--parent-token', options.parentToken,
        '--format', 'json',
      ];
      const result = await this.execute(args, 'docx', {
        cwd: stagingDir,
        // create 是服务端单请求全量写入，大文档余量对齐 update 预算。
        timeoutMs: 120_000,
      });
      const document = result?.data?.document ?? {};
      const documentId = typeof document.document_id === 'string' ? document.document_id : '';
      if (!documentId) {
        // T4b-06：命令已发出且退出成功，但响应缺 document_id——云端可能
        // 已创建文档，结果未知。不得按「明确失败」抛普通 Error（发布链会
        // 落 failed 并允许普通重发 → 重复云文档）：归 incomplete_response，
        // 由上层置 unknown 并禁止普通重发。
        throw new LarkCliError(
          'docs +create 响应缺少 data.document.document_id，创建结果未知（命令已发出，请勿按失败重发）',
          'incomplete_response',
          false,
        );
      }
      const revision = document.revision_id;
      return {
        documentId,
        url: typeof document.url === 'string' && document.url.length > 0 ? document.url : null,
        revisionId: typeof revision === 'number' && Number.isFinite(revision) ? revision : null,
      };
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  /**
   * parse 回读画像（P1-S1 PB-2：data.profile.{word_count,char_count,
   * block_count}；发布回读校验比对 char_count，读授权内）。字段缺失返回
   * null，不抛错（校验侧降级为 publish_verify_unavailable）。
   */
  async parseDocumentProfile(
    objToken: string,
  ): Promise<{ charCount: number | null; wordCount: number | null; blockCount: number | null }> {
    if (typeof objToken !== 'string' || objToken.trim().length === 0) {
      throw new Error('parseDocumentProfile requires a non-empty objToken');
    }
    const result = await this.execute([
      'docs', '+script', '--command', 'parse', '--doc', objToken, '--format', 'json',
    ], 'docx', { timeoutMs: 60_000 });
    const profile = result?.data?.profile ?? {};
    const numberOrNull = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    return {
      charCount: numberOrNull(profile.char_count),
      wordCount: numberOrNull(profile.word_count),
      blockCount: numberOrNull(profile.block_count),
    };
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

  /** Download the entire native workbook, including layout and embedded media. */
  async exportWorkbook(spreadsheetToken: string, outputPath: string): Promise<string> {
    const target = resolveMediaOutputTarget(outputPath);
    if (fs.existsSync(target.requestedPath)) {
      throw new LarkCliError('Excel 导出 staging 文件已存在，请使用新的输出路径', 'parse', false);
    }
    await this.execute([
      'sheets', '+workbook-export', '--spreadsheet-token', spreadsheetToken,
      '--file-extension', 'xlsx', '--output-path', target.outputName,
      '--as', 'user', '--format', 'json',
    ], 'sheets', { cwd: target.directory, timeoutMs: 120_000 });
    // The shortcut can return an unfinished task reference instead of a file.
    // A successful process exit is therefore not proof of a complete export.
    if (!fs.existsSync(target.requestedPath) || fs.statSync(target.requestedPath).size === 0) {
      throw new LarkCliError('Excel 原件尚未导出完成，请稍后重试同步；本地版本未更新', 'upstream', true);
    }
    return target.requestedPath;
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

  async getSheetLayout(options: { spreadsheetToken: string; sheetId: string }): Promise<any> {
    return this.execute([
      'sheets', '+sheet-info', '--spreadsheet-token', options.spreadsheetToken,
      '--sheet-id', options.sheetId,
      '--include', 'merges,row_heights,col_widths,hidden_rows,hidden_cols,groups,frozen',
      '--as', 'user', '--format', 'json',
    ], 'sheets');
  }

  async getSheetCells(options: {
    spreadsheetToken: string; sheetId: string; range: string; formulas?: boolean;
  }): Promise<any> {
    return this.execute([
      'sheets', '+cells-get', '--spreadsheet-token', options.spreadsheetToken,
      '--sheet-id', options.sheetId, '--range', options.range,
      '--include', options.formulas ? 'value,formula,style' : 'value,style',
      '--skip-hidden=false', '--max-chars', '500000', '--as', 'user', '--format', 'json',
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

  async getSheetCharts(options: { spreadsheetToken: string; sheetId: string }): Promise<any> {
    return this.execute(['sheets', '+chart-list', '--spreadsheet-token', options.spreadsheetToken,
      '--sheet-id', options.sheetId, '--as', 'user', '--format', 'json'], 'sheets');
  }

  // -------------------------------------------------------------------------
  // bitable (多维表格 / base) read 能力。
  //
  // 方法是单次调用的薄封装（与 getSheetCsv/getSheetFloatImages 同模式）：
  // client 只负责 argv 组装与节流，翻页循环（offset 递增 + has_more 兜底）
  // 在 BitableExporter 层完成。所有响应原样返回，宽容归一化
  // （snake/camel key、包装层剥解）也在 exporter 层做。
  // -------------------------------------------------------------------------

  /** List data tables of a base (base +table-list, page size 1-100). */
  async listBaseTables(appToken: string, offset: number, limit: number): Promise<any> {
    return this.execute([
      'base', '+table-list', '--base-token', appToken,
      '--offset', String(offset), '--limit', String(limit),
      '--format', 'json',
    ], 'base');
  }

  /** List fields of one data table (base +field-list, page size 1-200). */
  async listBaseFields(options: {
    baseToken: string;
    tableId: string;
    offset: number;
    limit: number;
  }): Promise<any> {
    return this.execute([
      'base', '+field-list', '--base-token', options.baseToken,
      '--table-id', options.tableId,
      '--offset', String(options.offset), '--limit', String(options.limit),
      '--format', 'json',
    ], 'base');
  }

  /** List views of one data table (base +view-list). */
  async listBaseViews(options: {
    baseToken: string;
    tableId: string;
    offset: number;
    limit: number;
  }): Promise<any> {
    return this.execute([
      'base', '+view-list', '--base-token', options.baseToken,
      '--table-id', options.tableId,
      '--offset', String(options.offset), '--limit', String(options.limit),
      '--format', 'json',
    ], 'base');
  }

  /**
   * List records of one data table (base +record-list，ndjson artifact 通道)。
   *
   * 底层走 GET /open-apis/base/v3/bases/<T>/tables/<tbl>/records。
   * v0.3.34 真机实测：--format json 返回的是渲染后的值矩阵
   * （data.data: [[...]]，无 record_id/字段名/原始值）不可用；markdown
   * format 同样丢结构。ndjson artifact 是唯一保真通道：原始字段值 +
   * record_id 落盘到 --output 文件，stdout 返回 manifest（顶层
   * has_more/records_count/offset），每页上限 2000。注意区分 stdout 的
   * ndjson 格式与 artifact 落盘（后者才保留原始值）。
   */
  async listBaseRecords(options: {
    baseToken: string;
    tableId: string;
    offset: number;
    limit: number;
  }): Promise<any> {
    // v0.3.34 真机实测（2026-09-07）：+record-list --format json 返回的是
    // 渲染后的值矩阵（data.data: [[...]]，无 record_id、无原始字段对象，
    // 字段名/schema 全部丢失），多维表格记录被上层解析为空页（同步产物
    // 全表「无记录」）。ndjson artifact 是唯一保真通道：保留原始字段值
    // + record_id，manifest 顶层携带 has_more/records_count/offset，翻页
    // 语义与 --offset 一致（实测 page1 limit=3 + page2 offset=3 无重复）。
    // ndjson 每页上限 2000（json 格式仅 200）。
    //
    // 真机坑二：lark-cli --output 有路径白名单（仅 cwd / /tmp / ~/files），
    // macOS 的 os.tmpdir() 是 /var/folders/...（DARWIN_USER_TEMP_DIR）会被
    // 「unsafe output path」拒绝。按可写性探测候选链落盘。
    const outFile = resolveNdjsonArtifactPath();
    try {
      const manifest = await this.execute([
        'base', '+record-list', '--base-token', options.baseToken,
        '--table-id', options.tableId,
        '--offset', String(options.offset),
        '--limit', String(Math.min(options.limit, 2000)),
        '--format', 'ndjson', '--output', outFile,
      ], 'base');
      // diting 2026-09 复核 Major：读取/解析失败绝不能静默退化为空页——
      // 翻页器会把空页当合法终点，md 落 0 记录且推进 synced 基线，
      // 违背「记录不完整绝不推进基线」契约（v0.3.34 根因正是容错解析把
      // 异常 shape 吞成空页）。区分三类：①读文件失败/行级 JSON 解析
      // 失败 → 硬抛（走 exporter 硬失败）；②合法空文件（0 字节）→
      // 空页（兼容服务端怪异态，翻页器空页终止 + 保险丝仍生效）；
      // ③正常行 → 转换统一结构。
      let raw: string;
      try {
        raw = fs.readFileSync(outFile, 'utf-8');
      } catch (error) {
        throw new LarkCliError(
          `ndjson artifact 读取失败（lark-cli 版本行为变化或落盘异常？）: ${outFile}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'parse',
          false,
        );
      }
      const rows: unknown[] = [];
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          rows.push(JSON.parse(line));
        } catch (error) {
          throw new LarkCliError(
            `ndjson artifact 行解析失败（半截写入/磁盘损坏？）: ${outFile}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'parse',
            false,
          );
        }
      }
      const items = rows
        .map((row) => {
          if (!row || typeof row !== 'object') return null;
          const record = row as Record<string, any>;
          const { record_id: recordId, ...fields } = record;
          return { record_id: recordId, fields };
        })
        .filter((item): item is { record_id: unknown; fields: Record<string, unknown> } => item !== null);
      const effectiveLimit = Math.min(options.limit, 2000);
      const hasMore = manifest?.has_more
        ?? manifest?.data?.has_more
        ?? manifest?.hasMore
        ?? (items.length >= effectiveLimit);
      return { items, has_more: hasMore };
    } finally {
      fs.rmSync(outFile, { force: true });
    }
  }
  /**
   * Download one base attachment file (base +record-download-attachment).
   *
   * base 附件必须走此命令（drive media-download 不接受 base 附件 token）。
   * --output 是目标目录（不是文件名），实际落盘文件名由 lark-cli 决定，
   * 返回值里的 saved_path / 目录扫描由调用方（BitableExporter）解析。
   */
  async downloadBaseAttachment(options: {
    baseToken: string;
    tableId: string;
    recordId: string;
    fileToken: string;
    outputDir: string;
  }): Promise<any> {
    return this.execute([
      'base', '+record-download-attachment',
      '--base-token', options.baseToken,
      '--table-id', options.tableId,
      '--record-id', options.recordId,
      '--file-token', options.fileToken,
      '--output', options.outputDir,
    ], 'base');
  }

  /** List dashboards of a base (base +dashboard-list, raw response). */
  async listBaseDashboards(baseToken: string): Promise<any> {
    return this.execute([
      'base', '+dashboard-list', '--base-token', baseToken,
      '--format', 'json',
    ], 'base');
  }

  /** List automations/workflows of a base (base +workflow-list, raw). */
  async listBaseWorkflows(baseToken: string): Promise<any> {
    return this.execute([
      'base', '+workflow-list', '--base-token', baseToken,
      '--format', 'json',
    ], 'base');
  }

  /** List forms of one data table (base +form-list, raw response). */
  async listBaseForms(options: {
    baseToken: string;
    tableId: string;
  }): Promise<any> {
    return this.execute([
      'base', '+form-list', '--base-token', options.baseToken,
      '--table-id', options.tableId,
      '--format', 'json',
    ], 'base');
  }

  /**
   * Check if lark-cli is ready (version + authentication + scope validation)
   */
  async checkAuthReady(options: { verify?: boolean } = {}): Promise<LarkCliAuthReadiness> {
    // 提升作用域：auth status / scope 阶段抛错时 --version 已成功拿到
    // 版本，不能随 catch 丢失（2026-10 实测：未 config init 的机器上
    // getToolStatus 拿不到 larkCliVersion，前端无法显示已安装版本）。
    let larkCliVersion: string | undefined;
    try {
      // 1. Check if lark-cli is installed
      const versionResult = await this.execute(['--version'], 'auth');
      larkCliVersion = typeof versionResult.data?.version === 'string'
        ? versionResult.data.version
        : undefined;
      if (!versionResult.ok) {
        return {
          ready: false,
          // 包名必须是 @larksuite/cli：registry 上的 `lark-cli` 是无关的
          // 0.1.0 占位包（见 lark-cli-manager.ts 的 2026-09 包名修正）。
          error: 'lark-cli 未安装，请执行 npm install -g @larksuite/cli',
          larkCliVersion,
        };
      }

      // 2. Check authentication status
      const verify = options.verify !== false;
      const statusResult = await this.execute(['auth', 'status', '--json', ...(verify ? ['--verify'] : [])], 'auth');
      if (!statusResult.data || !statusResult.data.identity) {
        return {
          ready: false,
          error: '未认证，请执行 lark-cli auth login',
          larkCliVersion,
        };
      }

      const identity = statusResult.data.identity;
      const user = statusResult.data.identities?.user;
      const account = typeof user?.openId === 'string' && user.openId.trim()
        ? { id: user.openId, name: typeof user.userName === 'string' ? user.userName : undefined }
        : undefined;
      const currentScopes: string[] = typeof user?.scope === 'string'
        ? user.scope.split(/\s+/).filter(Boolean) : [];
      const details = { larkCliVersion, identity, currentScopes, account, verified: user?.verified === true };
      // --verify 失败时顶层 identity 可能回退为 bot，必须检查 user 本身。
      // 即使缓存 scope 完整，也不能把已撤销/过期或无法联网核验的凭据判为就绪。
      if (identity !== 'user' || user?.available !== true
        || !['ready', 'needs_refresh'].includes(user?.status)) {
        return {
          ...details,
          ready: false,
          error: `当前账号认证不可用，请重新认证或切换账号。${user?.message || ''}`,
        };
      }
      if (!verify || user?.verified !== true || !account) {
        return {
          ...details,
          ready: false,
          error: '尚未通过账号联网验证。请检查网络后重新检测，或重新认证；旧版 lark-cli 缺少验证信息时请先更新。',
        };
      }

      // 3. Check required scopes (scopes are space-separated string in identities.user.scope).
      //    SCOPE_ALIAS_GROUPS：飞书新旧 scope 名交替期，授权端可能只授予组内
      //    某一个名字（如旧 docx:document:readonly vs 新 docs:document:read）。
      //    组内任一命中即视为满足，避免对新名的误报阻断认证（2026-09 实测
      //    「缺少权限：docs:document:read」即旧授权只持旧名触发；2026-10 起
      //    默认需求集已不再要求该名，此兑底仅为手改配置/旧 token 兼容）。
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
          ...details,
          ready: false,
          error: `缺少权限：${missingScopes.join(', ')}。请在应用内点击「开始飞书认证」重新授权补齐；若完成后仍缺失，请检查授权页是否包含并已勾选这些权限，以及飞书应用的权限是否已获管理员批准`,
          missingScopes,
        };
      }

      return {
        ...details,
        ready: true,
        missingScopes: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 安装/配置类引导文案原样透传（不带「认证检查失败」前缀），让
      // 文案直接指向下一步动作（一键安装 / config init）而非重新认证；
      // 同时带回已拿到的版本，前端可显示「已安装 lark-cli x.y.z」。
      const passthrough = message.startsWith('未找到 lark-cli')
        || message.startsWith('lark-cli 已安装但尚未完成初始配置');
      return {
        ready: false,
        error: passthrough ? message : `认证检查失败：${message}`,
        larkCliVersion,
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
    const args = ['wiki', '+node-list', '--format', 'ndjson', '--page-all', '--page-limit', '0'];
    // ↑ --page-limit 0 = unlimited：1.0.98 起 --page-all 受默认 --page-limit 10
    // 截断（每分支 ≤10×50=500 节点静默停止，ok:true 无截断标记）——大子树
    // 会被误判 missing/deletion 候选。显式置 0 信任上游 QPS 节流（audit D2）。
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
    // A single bare NDJSON entity is normalized as data:<node>, while
    // multiple entities become data.records. Treating the singleton as an
    // empty list stops BFS at every branch with exactly one child.
    if (typeof data?.node_token === 'string' && typeof data?.obj_token === 'string') {
      return [data as LarkCliNodeInfo];
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
    const requestJson = JSON.stringify({
      request_docs: requests.map((request) => ({
        doc_token: request.docToken,
        doc_type: request.docType,
      })),
    });
    let requestDir: string | undefined;
    let result: any;
    try {
      let dataArgument = requestJson;
      if (process.platform === 'win32') {
        // The .cmd shim both strips inline JSON quotes and imposes an
        // 8191-character command limit. CLI's documented @file input avoids
        // both problems while retaining Drive's full 200-document batch.
        requestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-drive-meta-'));
        const requestFile = path.join(requestDir, 'request.json');
        fs.writeFileSync(requestFile, requestJson, { encoding: 'utf8', mode: 0o600 });
        dataArgument = `@${requestFile}`;
      }
      result = await this.execute([
        'drive', 'metas', 'batch_query', '--format', 'json', '--data', dataArgument,
      ], 'drive');
    } finally {
      if (requestDir) {
        fs.rmSync(path.join(requestDir, 'request.json'), { force: true });
        fs.rmdirSync(requestDir);
      }
    }
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
    const timeout = executionOptions?.timeoutMs ?? this.config.timeout ?? 30000;

    // P0-Win 修复（2026-10 实测事故）：未安装 lark-cli 的 Windows 机器上，
    // execFile 以 shell:true 启动时 cmd.exe 自己 exit 1 并打印本地化文案
    // （GBK 环境下还是乱码），Node 不会抛 ENOENT——下方 ENOENT 分支永远
    // 不命中，错误落进 classifyError 通用分支变成「lark-cli 执行失败：…」
    // 且 retryable=true，checkAuthReady 包成「认证检查失败：…」后
    // getToolStatus 的未安装正则也匹配不到 → 前端「一键安装」面板永不出现。
    // 裸命令名 = 解析阶段 PATH + 全部发现目录均已未命中（见
    // isBareCommandName 注释），在 spawn 前确定性失败，不依赖本地化错误文本。
    if (isBareCommandName(larkCliPath)) {
      throw new LarkCliError(LARK_CLI_NOT_FOUND_MESSAGE, 'upstream', false);
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        quoteWindowsExecutablePath(larkCliPath),
        quoteWindowsShellArguments(args),
        {
          timeout,
          // 大子表 csv-get 的 stdout 可达数 MB（实测：7400+ 行对白表），
          // Node execFile 默认 1MB maxBuffer 会直接抛
          // "stdout maxBuffer length exceeded" 并中止文档同步（2026-09 实测：
          // 同一文档反复重试失败、synced 基线永不推进）。256MB 上限足够，
          // 超限仍有 timeout 兜底。
          maxBuffer: 256 * 1024 * 1024,
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
      // P0-Win 兜底：win32 shell:true 下 ENOENT 不会触发，cmd.exe 的
      // 「命令/路径未找到」只能靠文本识别（中文 Windows 为 GBK，可能乱码，
      // 故同时匹配中英文与「系统找不到路径/文件」变体）。裸命令名场景已被
      // 上方 fail-fast 确定性拦截，这里主要兜住「设置了显式路径但文件不存在」
      // 等绕过 fail-fast 的情况。
      const notFoundText = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`;
      const isShellCommandNotFound =
        /is not recognized as an internal or external command/i.test(notFoundText)
        || /不是内部或外部命令/.test(notFoundText)
        || /(?:系统找不到指定的(?:路径|文件)|the system cannot find the (?:path|file) specified)/i.test(notFoundText);
      if (error?.code === 'ENOENT' || isShellCommandNotFound) {
        throw new LarkCliError(LARK_CLI_NOT_FOUND_MESSAGE, 'upstream', false);
      }
      const errorStderr = typeof error?.stderr === 'string' ? clipForLog(error.stderr) : '';
      const errorStdout = typeof error?.stdout === 'string' ? clipForLog(error.stdout) : '';
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
      .replace(/^\uFEFF/, '') // BOM
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
    //    131014 = "document is not in wiki" on lark-cli ≥1.0.95 (node_by_token
    //    migration); 131005 = same meaning on older CLI. Audit D1 (2026-10).
    //    P0-S2 追加 10020 / 3380002 / 981003：错误体非 JSON 时的文本兜底
    //    （10020=并发 revert 单飞、3380002=回滚目标无效、981003=改名类型
    //    错配；三种形态均以 p0s1-lark-cli fixture 实证）。
    const known = rawMessage.match(/\b(131005|131006|131014|40403|3380003|99991400|10020|3380002|981003)\b/);
    return known ? known[1] : undefined;
  }

  private classifyError(message: string, upstreamCode?: string): LarkCliError {
    const normalized = message.toLowerCase();
    // lark-cli 已安装但未完成初始配置（2026-10 实测：新装机器上
    // `auth status` 以非零退出 + JSON 错误体 {type:'config',
    // subtype:'not_configured'} 报告，曾落进通用「执行失败」分支）。这是
    // 可引导的安装后状态而非执行故障：归类为 auth（不可重试），文案指向
    // config init，防止用户被「执行失败」吓到却得不到下一步指引。
    if (/(?:not_configured|"type"\s*:\s*"config")/i.test(message)) {
      return new LarkCliError(
        'lark-cli 已安装但尚未完成初始配置：请在终端执行 lark-cli config init --new（它会输出一个验证 URL，在浏览器打开完成配置），然后回到应用重新检测并认证',
        'auth',
        false,
        upstreamCode,
      );
    }
    // P1-S5（设计 §3.2；P1-S1 SP-1 实测定型）：scope 校验先于一切参数校验，
    // 缺失可选读 scope（如 slides:presentation:screenshot）时 lark-cli 以
    // 非零退出 + JSON 错误体拒绝。错误原文含 scope 名与 CLI 的增量授权
    // hint，透传原文供上层引导增量授权；不可重试（重试无意义，需授权）。
    if (upstreamCode === 'missing_scope' || /(?:missing_scope|missing required scope)/i.test(message)) {
      return new LarkCliError(
        `缺少飞书授权（missing_scope）：${message}`,
        'missing_scope',
        false,
        upstreamCode,
      );
    }
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
    if (/(?:40403|131006|3350003|\bno perm\b|permission|forbidden|access denied|无权限)/i.test(message)) {
      return new LarkCliError('无权限访问该节点', 'permission', false, upstreamCode);
    }
    // 「文档不在 wiki 空间」：CLI hint 明示 Do not retry（换 docs/sheets/base/drive
    // 命令而非重试 wiki 命令）。131014 = lark-cli ≥1.0.95（node_by_token 迁移），
    // 131005 = 旧版；不可重试，调用方（如 custom-folders 归档 fallback）按
    // upstreamCode 识别后改走云文档通道（audit D1，2026-10）。
    if (
      upstreamCode === '131014' || upstreamCode === '131005'
      || /document is not in wiki/i.test(message)
    ) {
      return new LarkCliError(
        '该文档不在 wiki 空间（云文档），请用对应的云文档链接或 docs/drive 命令访问',
        'not_in_wiki',
        false,
        upstreamCode ?? '131014',
      );
    }
    // P0-S2（P0-S1 实测定稿）：history revert 并发单飞门——服务端同一文档
    // 只允许一个 revert 任务（10020）。可重试但不是立即重试：先轮询既有
    // 任务状态再重试（S4 的 cloud_revert_running 门是它的本地镜像）。
    if (upstreamCode === '10020' || /\b10020\b/.test(message)) {
      return new LarkCliError(
        '该文档已有回滚任务进行中，请先轮询任务状态完成后再重试',
        'conflict',
        true,
        upstreamCode ?? '10020',
      );
    }
    // 3380002：revert 目标无效——history_version_id 不存在，或目标为最新
    // 历史条目（最新条目被下一次写超越后才可作目标；两种形态同码，P0-S1
    // 两份 fixture 互证）。注意与 3380003（文档已删除，上方 deleted 分支）
    // 是两个不同语义：3380002 换目标/重新 list 可恢复，3380003 文档没了。
    if (upstreamCode === '3380002' || /\b3380002\b/.test(message)) {
      return new LarkCliError(
        '回滚目标无效：历史版本不存在或为最新历史条目，不可作为回滚目标',
        'invalid_target',
        false,
        upstreamCode ?? '3380002',
      );
    }
    // 981003：update-title 类型错配（token 与 --type 不符，报 "not found."，
    // 与未知 token 同码）。本地映射可能已过期：不得自动换 type 重试（U31），
    // 应先重新检测/核对类型（drive +inspect）。
    if (upstreamCode === '981003' || /\b981003\b/.test(message)) {
      return new LarkCliError(
        '标题更新类型错配：token 与传入类型不符，请先核对文档类型后重试',
        'type_mismatch',
        false,
        upstreamCode ?? '981003',
      );
    }
    if (/(?:not authenticated|token expired|unauthorized|认证)/i.test(normalized)) {
      return new LarkCliError('认证失效，请执行 lark-cli auth login', 'auth', false, upstreamCode);
    }
    // "server time out error"（P0-S1 白板 svg 服务端渲染超时 fixture 形态：
    // 带空格的 time out 不被 timeout/timed out 覆盖）——归 timeout 可重试，
    // S6 以此码判定「svg 失败降级 raw」。
    if (/(?:timeout|timed out|time out|超时)/i.test(normalized)) {
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

  // -------------------------------------------------------------------------
  // P0-S2 新能力五方法（lark-cli-newcaps-P0 §3 + §10 P0-S1 实测定稿，
  // lark-cli 1.0.98 实测命令形态；fixture server/tests/fixtures/
  // p0s1-lark-cli/）。只追加：既有读写方法 argv 零改动。apiType 复用既有
  // 桶：history / whiteboard → 'docx'，update-title → 'drive'。
  // -------------------------------------------------------------------------

  /**
   * docs +history-list —— 云端历史分页（每页 1-20；P0-S1 HP-1：新建文档
   * 立即有 1 条 type=1 建档历史；但历史条目异步定型、非每 revision 必有，
   * 解析仍容忍空列表）。写前锚点取第 1 页（pageSize 5）即可（U22/U23）。
   */
  async listDocumentHistory(
    objToken: string,
    opts?: { pageToken?: string; pageSize?: number },
  ): Promise<DocumentHistoryPage> {
    if (typeof objToken !== 'string' || objToken.trim().length === 0) {
      throw new Error(
        `listDocumentHistory requires a non-empty objToken; received: ${String(objToken)}`,
      );
    }
    const pageSize = Math.min(20, Math.max(1, Math.floor(opts?.pageSize ?? 20)));
    const args = [
      'docs', '+history-list',
      '--doc', objToken,
      '--page-size', String(pageSize),
    ];
    if (opts?.pageToken) args.push('--page-token', opts.pageToken);
    args.push('--format', 'json');
    const result = await this.execute(args, 'docx');
    const data = result?.data ?? result;
    // 双读容错（§3）：实测形态 data.entries；items/histories/records 兜底
    // 未来字段漂移（与 fetchDocumentRevision 的「结构化优先」同模式）。
    const rawEntries = data?.entries ?? data?.items ?? data?.histories ?? data?.records;
    const entries: DocHistoryEntry[] = Array.isArray(rawEntries)
      ? rawEntries
        .filter((entry: unknown): entry is Record<string, unknown> =>
          entry !== null && typeof entry === 'object')
        .map((entry) => ({
          historyVersionId: typeof entry.history_version_id === 'string'
            ? entry.history_version_id : null,
          revisionId: typeof entry.revision_id === 'number' && Number.isFinite(entry.revision_id)
            ? entry.revision_id : null,
          // edit_time 为主（fixture 实测）；created_at/create_time 兜底
          // （HP-1 待定字段名的既定处置，双读不丢时间信息）。
          editTime: typeof entry.edit_time === 'string' ? entry.edit_time
            : typeof entry.created_at === 'string' ? entry.created_at
              : typeof entry.create_time === 'string' ? entry.create_time : null,
          editorIds: toStringArrayOrNull(entry.editor_ids) ?? [],
          type: typeof entry.type === 'number' && Number.isFinite(entry.type)
            ? entry.type : null,
          raw: entry,
        }))
      : [];
    const hasMore = data?.has_more === true || data?.hasMore === true;
    const pageToken = typeof data?.page_token === 'string' ? data.page_token
      : typeof data?.pageToken === 'string' ? data.pageToken : '';
    return {
      entries,
      hasMore,
      nextPageToken: hasMore && pageToken !== '' ? pageToken : null,
    };
  }

  /**
   * docs +history-revert —— 回滚到历史版本（P0-S1 HP-2：revert 产生新历史
   * type=3，回滚可再回滚；不回滚文档 title；内嵌白板块随正文整体恢复）。
   *
   * 非幂等：调用方绝不重试；子进程超时/输出不可解析 → 抛 LarkCliError，
   * 服务层置 unknown（设计 §4.4）。waitTimeoutMs 缺省 30000（同步等待上
   * 限）；传 0 走异步形态（立即返回 running + task_id，由调用方轮询
   * revertDocumentHistoryStatus）。最新历史条目不可作目标（3380002）。
   */
  async revertDocumentHistory(
    objToken: string,
    historyVersionId: string,
    opts?: { waitTimeoutMs?: number },
  ): Promise<DocumentHistoryRevertResult> {
    if (typeof objToken !== 'string' || objToken.trim().length === 0) {
      throw new Error(
        `revertDocumentHistory requires a non-empty objToken; received: ${String(objToken)}`,
      );
    }
    if (typeof historyVersionId !== 'string' || historyVersionId.trim().length === 0) {
      throw new Error(
        `revertDocumentHistory requires a non-empty historyVersionId; received: ${String(historyVersionId)}`,
      );
    }
    const waitTimeoutMs = Math.min(30_000, Math.max(0, Math.floor(opts?.waitTimeoutMs ?? 30_000)));
    const result = await this.execute([
      'docs', '+history-revert',
      '--doc', objToken,
      '--history-version-id', historyVersionId,
      '--wait-timeout-ms', String(waitTimeoutMs),
      '--format', 'json',
    ], 'docx', {
      // 子进程预算必须大于 --wait-timeout-ms（CLI 内部同步等待上限），
      // 预留 15s 收尾，否则同步等待恰好命中客户端超时被误判为 timeout。
      timeoutMs: waitTimeoutMs + 15_000,
    });
    const data = result?.data ?? result;
    // 双读：data.status ?? data.task_status；未知取值 → running（调用方
    // 继续轮询直到上限）。
    const rawStatus = typeof data?.status === 'string' ? data.status
      : typeof data?.task_status === 'string' ? data.task_status : '';
    // T4b-06：非幂等写已发出，响应形态不完整 = 结果未知（不是明确失败）：
    //   - 缺 status/task_status：无法区分同步完成/异步起步；
    //   - 异步形态缺 task_id：无法轮询收敛。
    // 两种都抛 incomplete_response（不可重试），由服务层置 unknown。
    if (rawStatus === '') {
      throw new LarkCliError(
        'docs +history-revert 响应缺少 status/task_status 字段，回滚结果未知（命令已发出，请勿重发）',
        'incomplete_response',
        false,
      );
    }
    const taskId = typeof data?.task_id === 'string' && data.task_id !== '' ? data.task_id : null;
    const terminal = rawStatus === 'done' || rawStatus === 'failed' || rawStatus === 'partial_failed';
    if (!terminal && taskId == null) {
      throw new LarkCliError(
        'docs +history-revert 异步响应缺少 task_id，回滚任务无法轮询收敛，结果未知（命令已发出，请勿重发）',
        'incomplete_response',
        false,
      );
    }
    return {
      status: terminal ? rawStatus as 'done' | 'failed' | 'partial_failed' : 'running',
      taskId,
      pollAfterMs: typeof data?.poll_after_ms === 'number' && Number.isFinite(data.poll_after_ms)
        ? data.poll_after_ms : null,
      failedBlockTokens: toStringArrayOrNull(data?.failed_block_tokens),
    };
  }

  /**
   * docs +history-revert-status —— 轮询回滚任务状态。failedBlockTokens
   * 非空 = 部分块回滚失败（P0-S1 HP-2：该字段必须读取并上抛警告）。
   */
  async revertDocumentHistoryStatus(
    objToken: string,
    taskId: string,
  ): Promise<DocumentHistoryRevertStatus> {
    if (typeof objToken !== 'string' || objToken.trim().length === 0) {
      throw new Error(
        `revertDocumentHistoryStatus requires a non-empty objToken; received: ${String(objToken)}`,
      );
    }
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      throw new Error(
        `revertDocumentHistoryStatus requires a non-empty taskId; received: ${String(taskId)}`,
      );
    }
    const result = await this.execute([
      'docs', '+history-revert-status',
      '--doc', objToken,
      '--task-id', taskId,
      '--format', 'json',
    ], 'docx');
    const data = result?.data ?? result;
    const rawStatus = typeof data?.status === 'string' ? data.status
      : typeof data?.task_status === 'string' ? data.task_status : '';
    const status: DocumentHistoryRevertStatus['status'] = rawStatus === 'partial_failed' ? 'partial_failed' : rawStatus === 'done' ? 'done'
      : rawStatus === 'failed' || rawStatus === 'error' ? 'failed'
        : 'running';
    return {
      status,
      failedBlockTokens: toStringArrayOrNull(data?.failed_block_tokens),
    };
  }

  /**
   * whiteboard +export —— 白板旁路导出（P0-S1 HP-4 分支裁定：svg 主产物
   * ——文字为真实 <text>/<tspan> 节点；raw 为降级产物——复杂画板 svg 会
   * 服务端渲染超时（~6.5s，内容相关，归 timeout 类错误），raw 稳定可用。
   * S6 走「先 svg、network/timeout 类失败降级 raw」双源链）。
   *
   * - 响应键按类型区分（P0-S1 实测，非统一 output 字段）：svg →
   *   data.svg_path；raw → data.output_path。（preview 是
   *   preview_image_path 且扩展名必须 .jpg——本方法不暴露 preview；同步
   *   链的 PNG 走既有 media-download --type whiteboard，不经 +export。）
   * - 超时预算由调用方传入（svg 的服务端超时是 S6 降级判定的输入）；
   *   未传时用 execute 缺省预算。
   * - 输出围栏复用 resolveMediaOutputTarget + isPathInsideDirectory
   *   （fetchMediaToPath 同款）；另按 exportWorkbook 先例校验落盘存在
   *   且非空（导出类命令成功退出不等于文件完整）。
   */
  async exportWhiteboard(
    whiteboardToken: string,
    opts: { outputType: 'svg' | 'raw'; outputPath: string; timeoutMs?: number },
  ): Promise<string> {
    if (typeof whiteboardToken !== 'string' || whiteboardToken.trim().length === 0) {
      throw new Error(
        `exportWhiteboard requires a non-empty whiteboardToken; received: ${String(whiteboardToken)}`,
      );
    }
    const target = resolveMediaOutputTarget(opts.outputPath);
    const execution: LarkCliExecutionOptions = { cwd: target.directory };
    if (opts.timeoutMs != null) execution.timeoutMs = opts.timeoutMs;
    const result = await this.execute([
      'whiteboard', '+export',
      '--whiteboard-token', whiteboardToken,
      '--output-type', opts.outputType,
      '--output', target.outputName,
      '--overwrite',
      '--format', 'json',
    ], 'docx', execution);
    const data = result?.data ?? result;
    const reported = opts.outputType === 'svg' ? data?.svg_path : data?.output_path;
    const resolvedPath = typeof reported === 'string' && reported !== ''
      ? path.resolve(target.directory, reported)
      : target.requestedPath;
    // 顺序：先验落盘完整性、后验输出围栏——两分支都抛错，上报路径任何
    // 形态都不会被返回给调用方；先验完整性可避免 macOS /var→/private
    // 符号链接差异在文件尚不存在时抢先触发围栏（isPathInsideDirectory
    // 只对已存在路径做 realpath 归一），产生误导性的「输出目录外」文案。
    if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).size === 0) {
      throw new LarkCliError(
        '白板导出尚未完成或文件为空，请稍后重试；本地版本未更新',
        'upstream',
        true,
      );
    }
    if (!isPathInsideDirectory(target.directory, resolvedPath)) {
      throw new LarkCliError(
        `lark-cli 返回了输出目录外的白板导出路径: ${resolvedPath}`,
        'upstream',
        false,
      );
    }
    return resolvedPath;
  }

  /**
   * drive +update-title —— 飞书侧改名（P0-C；P0-S1 HP-6 实测）。type 缺省
   * docx；wiki 成员必须传 node token + --type wiki（底层 obj token 不被
   * 接受，节点与文档标题双向同步）。绝不传 --type file，也不传
   * --on-extension-mismatch（非 file 类型无扩展名语义）。981003 = 类型
   * 错配（与未知 token 同码 "not found."），调用方不得自动改用另一种
   * type 重试（U31：本地映射可能已过期，应先重新检测）；空标题由 CLI
   * 本地拦截（服务层另有 title_invalid 门，S9）。限流 99991400 走既有
   * 指数退避。
   */
  async updateDocumentTitle(
    fileToken: string,
    title: string,
    opts?: { type?: 'wiki' | 'docx' | 'sheet' | 'slides' | 'bitable' },
  ): Promise<UpdateDocumentTitleResult> {
    if (typeof fileToken !== 'string' || fileToken.trim().length === 0) {
      throw new Error(
        `updateDocumentTitle requires a non-empty fileToken; received: ${String(fileToken)}`,
      );
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error(
        `updateDocumentTitle requires a non-empty title; received: ${String(title)}`,
      );
    }
    const result = await this.execute([
      'drive', '+update-title',
      '--token', fileToken,
      '--type', opts?.type ?? 'docx',
      '--title', title,
      '--format', 'json',
    ], 'drive');
    const data = result?.data ?? result;
    return {
      fileToken: typeof data?.file_token === 'string' ? data.file_token : null,
      title: typeof data?.title === 'string' ? data.title : null,
      type: typeof data?.type === 'string' ? data.type : null,
      updated: data?.updated === true,
      url: typeof data?.url === 'string' ? data.url : null,
      raw: result,
    };
  }

  /**
   * wiki +move-to-drive —— 知识库节点移出到云空间（P2-S6，设计 P2
   * §3.2；probe §9：1.0.71 #1869，Risk: write）。folderToken 省略 = 移到
   * 个人空间根。异步任务形态：state 双读（done 完成态 / 其余含未知取值
   * 归一 running，交调用方轮询）；任务号双读 task_id/taskId。
   *
   * CLI 1.0.98 自带协议文档规定 status=0 成功、1 进行中、负数失败，
   * 最多轮询约 60 秒；客户端保留 80 秒预算以接收完整 task_id。
   * 非幂等：调用方绝不重试；子进程超时/不可解析 → 服务层置 unknown。
   */
  async moveWikiNodeToDrive(
    nodeToken: string,
    opts?: { folderToken?: string | null },
  ): Promise<WikiMoveToDriveResult> {
    if (typeof nodeToken !== 'string' || nodeToken.trim().length === 0) {
      throw new Error(
        `moveWikiNodeToDrive requires a non-empty nodeToken; received: ${String(nodeToken)}`,
      );
    }
    const folderToken = typeof opts?.folderToken === 'string' && opts.folderToken.trim().length !== 0
      ? opts.folderToken : null;
    const result = await this.execute([
      'wiki', '+move-to-drive',
      '--node-token', nodeToken,
      ...(folderToken ? ['--folder-token', folderToken] : []),
      '--format', 'json',
    ], 'wiki', { timeoutMs: 80_000 });
    const data = result?.data ?? result;
    // CLI 1.0.98 wiki_move_to_drive：数值状态 0 成功、1 进行中、-1 失败。
    const rawState = typeof data?.state === 'string' ? data.state
      : typeof data?.status === 'string' ? data.status
        : typeof data?.task_status === 'string' ? data.task_status : '';
    const numericStatus = typeof data?.status === 'number' ? data.status : null;
    const taskId = typeof data?.task_id === 'string' && data.task_id !== '' ? data.task_id
      : typeof data?.taskId === 'string' && data.taskId !== '' ? data.taskId : null;
    const pollAfterMs = typeof data?.poll_after_ms === 'number' && Number.isFinite(data.poll_after_ms)
      ? data.poll_after_ms : null;
    // T4b-06：非幂等写已发出，响应形态不完整 = 结果未知（不是明确失败）：
    // 缺 state 键、或异步形态缺 task_id（无法轮询收敛）都归
    // incomplete_response（不可重试），由服务层置 unknown；绝不重发。
    if ((numericStatus != null && numericStatus < 0) || data?.failed === true) {
      throw new LarkCliError(`飞书移出任务失败：${String(data?.status_msg ?? 'move failed')}`, 'upstream', false);
    }
    const done = numericStatus === 0 || (numericStatus == null && rawState === 'done');
    const running = numericStatus === 1 || (numericStatus == null && rawState !== '' && !done);
    if (!done && !running) {
      throw new LarkCliError(
        'wiki +move-to-drive 响应缺少 state/status 字段，移出结果未知（命令已发出，请勿重发）',
        'incomplete_response',
        false,
      );
    }
    if (running && taskId == null) {
      throw new LarkCliError(
        'wiki +move-to-drive 异步响应缺少 task_id，移出任务无法轮询收敛，结果未知（命令已发出，请勿重发）',
        'incomplete_response',
        false,
      );
    }
    return {
      state: done ? 'done' : 'running',
      taskId,
      pollAfterMs,
      raw: result,
    };
  }

  /**
   * drive +task_result —— 通用异步任务结果轮询（probe §9：其 help 覆盖
   * wiki move-to-drive 任务类型；设计 §3.2 配套轮询口）。只读；失败由
   * 调用方按节奏续查（不判终态）。
   *
   * CLI 1.0.98 要求 --scenario wiki_move_to_drive，状态为数值。
   */
  async getDriveTaskResult(taskId: string): Promise<DriveTaskResult> {
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      throw new Error(
        `getDriveTaskResult requires a non-empty taskId; received: ${String(taskId)}`,
      );
    }
    const result = await this.execute([
      'drive', '+task_result',
      '--scenario', 'wiki_move_to_drive',
      '--task-id', taskId,
      '--format', 'json',
    ], 'drive');
    const data = result?.data ?? result;
    const rawState = typeof data?.state === 'string' ? data.state
      : typeof data?.status === 'string' ? data.status
        : typeof data?.task_status === 'string' ? data.task_status : '';
    const numericStatus = typeof data?.status === 'number' ? data.status : null;
    const state: DriveTaskResult['state'] = numericStatus === 0 ? 'done'
      : numericStatus != null && numericStatus < 0 ? 'failed'
        : numericStatus != null ? 'running'
          : rawState === 'done' || rawState === 'success' ? 'done'
            : rawState === 'failed' || rawState === 'error' ? 'failed' : 'running';
    return {
      state,
      message: typeof data?.status_msg === 'string' ? data.status_msg
        : typeof data?.message === 'string' ? data.message
        : typeof data?.error === 'string' ? data.error : null,
      raw: result,
    };
  }
}

/** wiki +move-to-drive 起步结果（同步 done / 异步 running 两形态）。 */
export interface WikiMoveToDriveResult {
  /** 未知取值归一为 running，由调用方按上限轮询（通用异步模式双读容错）。 */
  state: 'done' | 'running';
  /** 异步任务号；done 形态也可能携带（同 history-revert 实测形态）。 */
  taskId: string | null;
  /** 轮询建议间隔（ms）；缺失由服务层缺省节奏兜底。 */
  pollAfterMs: number | null;
  /** 原始响应，仅诊断用途，不进对外 DTO。 */
  raw: unknown;
}

/** drive +task_result 轮询结果（wiki move-to-drive 任务共用）。 */
export interface DriveTaskResult {
  state: 'done' | 'running' | 'failed';
  /** 失败描述（缺失为 null）；成功/进行中为 null。 */
  message: string | null;
  /** 原始响应，仅诊断用途。 */
  raw: unknown;
}

/**
 * 为 lark-cli ndjson artifact 选择可写的输出文件路径。
 *
 * lark-cli --output 内置白名单：cwd / /tmp / ~/files（真机实测 macos
 * DARWIN_USER_TEMP_DIR 被拒「unsafe output path」）。按序探测可写性：
 * /tmp → ~/files → os.tmpdir()（Windows TEMP 大概率被 Win 版接受）→
 * cwd。全链失败退 os.tmpdir()，交由 lark-cli 校验错显式暴露（可诊断）。
 */
function resolveNdjsonArtifactPath(): string {
  const fileName = `feishu-sync-bitable-records-${process.pid}-${Date.now()}-${
    Math.random().toString(36).slice(2, 8)
  }.ndjson`;
  const candidates = [
    '/tmp',
    path.join(os.homedir(), 'files'),
    os.tmpdir(),
    process.cwd(),
  ];
  for (const root of candidates) {
    try {
      fs.accessSync(root, fs.constants.W_OK);
      return path.join(root, fileName);
    } catch {
      // 候选根不可写（或不存在），试下一个
    }
  }
  return path.join(os.tmpdir(), fileName);
}

