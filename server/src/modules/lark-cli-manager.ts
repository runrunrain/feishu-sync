/**
 * LarkCliManager - 应用内 lark-cli 安装/更新/设备授权引导闭环
 *
 * 新用户引导三层职责（新用户引导需求 §1）：
 * - getToolStatus()        组合 checkAuthReady() + npm 可用性检测
 * - installOrUpdateLarkCli()  execFile(npm install -g @larksuite/cli@latest)，幂等
 * - startDeviceAuth()      `auth login --no-wait --json --scope <scopes>` 立即返回
 *                          { device_code, expires_in, 600, verification_url }（hint 忽略）
 * - completeDeviceAuth()   `auth login --device-code <code>` 阻塞直到浏览器授权/过期
 *
 * 关键实现约束（勿改）：
 * - device flow 两条命令都【不走 LarkCliClient 的串行调用队列】。该队列
 *   串行化所有 lark-cli 子进程（见 lark-cli-client.ts 类头注释），
 *   `--device-code` 会阻塞最长约 10 分钟，一旦入队会卡死变更检测等全部
 *   功能。因此这里直接 execFile + resolveLarkCliExecutable +
 *   buildLarkCliEnvironment 绕过队列；`--no-wait` 同样直连保持对称。
 *   完成后的就绪校验才回到 larkCliClient.checkAuthReady()（两条快命令，
 *   走队列无碍）。
 * - 一律 execFile + 参数数组，禁止 shell 字符串拼接；deviceCode 入参做
 *   非空 + 长度 < 500 校验防注入。
 * - 单例进行中标记：同一时间只允许一个 device flow（start 冲突返回 409
 *   语义错误；complete 成功/失败/超时后清除标记）。
 */

import { execFile } from 'child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'util';
import {
  buildLarkCliEnvironment,
  findExecutableOnPath,
  getNodeRuntimeCandidateDirectories,
  quoteWindowsExecutablePath,
  resolveLarkCliExecutable,
  type LarkCliAuthReadiness,
} from './lark-cli-client.js';
import { DEFAULT_REQUIRED_SCOPES } from './config-manager.js';
import type { Config } from '../types/index.js';

const execFileAsync = promisify(execFile);

/** npm install -g 全局安装的最长等待（慢网络下 npm 可能数分钟）。 */
const NPM_INSTALL_TIMEOUT_MS = 5 * 60_000;
/** `--version` 验证命令超时。 */
const VERSION_CHECK_TIMEOUT_MS = 30_000;
/** `npm view @larksuite/cli version`（registry 元数据）的最长等待。 */
const LATEST_VERSION_CHECK_TIMEOUT_MS = 15_000;
/** `auth login --no-wait` 立即返回，给足 CLI 冷启动余量。 */
const DEVICE_AUTH_START_TIMEOUT_MS = 60_000;
/**
 * `auth login --device-code` 的服务端有效期是 expires_in=600s（10 分钟），
 * 超时取 600s + 1 分钟余量：CLI 在过期后自行退出，本端超时只是兜底。
 */
const DEVICE_AUTH_COMPLETE_TIMEOUT_MS = 11 * 60_000;
/** install 输出仅保留尾部 50 行，避免 npm 长日志撑爆响应体。 */
const INSTALL_OUTPUT_TAIL_LINES = 50;
/** deviceCode 防注入上限。 */
const MAX_DEVICE_CODE_LENGTH = 500;

/** Manager 级结构化错误：code 稳定，status 直接映射 HTTP 状态码。 */
export class LarkCliManagerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 500,
  ) {
    super(message);
    this.name = 'LarkCliManagerError';
  }
}

export interface LarkCliToolStatus {
  larkCliInstalled: boolean;
  larkCliVersion?: string;
  /** registry 最新版（npm view，查询失败时缺省）；前端据其做版本对比着色。 */
  latestLarkCliVersion?: string;
  authReady: boolean;
  missingScopes?: string[];
  error?: string;
  npmAvailable: boolean;
  npmPath: string | null;
}

export interface LarkCliInstallResult {
  ok: boolean;
  /** 失败原因分类；npm_not_found 时前端引导安装 Node.js。 */
  reason?: 'npm_not_found' | 'npm_failed' | 'verify_failed';
  /** npm 原始输出（尾部截断）。 */
  output: string;
  version?: string;
  error?: string;
}

export interface DeviceAuthSession {
  verificationUrl: string;
  deviceCode: string;
  /** 秒；lark-cli 契约默认 600。 */
  expiresIn: number;
}

export interface DeviceAuthCompleteResult {
  /** device flow 命令本身是否成功退出（用户完成授权）。 */
  ok: boolean;
  /** 授权后的最终就绪状态（device flow 只授予请求的 scope，缺失如实返回）。 */
  ready: boolean;
  larkCliVersion?: string;
  currentScopes?: string[];
  missingScopes?: string[];
  identity?: string;
  error?: string;
}

/** 测试/未来扩展用：覆盖可执行文件发现环境（与 resolveLarkCliExecutable 的 options 对齐）。 */
export interface ExecDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

/** LarkCliClient 的最小依赖面（结构化类型，便于测试注入假实现）。 */
interface LarkCliClientLike {
  checkAuthReady(): Promise<LarkCliAuthReadiness>;
}

/** ConfigManager 的最小依赖面。 */
interface ConfigManagerLike {
  getConfig(): Config | null;
  load(): Promise<Config>;
}

function tailLines(text: string, lines: number): string {
  const parts = text.trim().split('\n');
  return parts.slice(Math.max(0, parts.length - lines)).join('\n');
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 从 execFile 的 error 上恢复 stdout/stderr 尾部（npm 失败诊断用）。 */
function execErrorOutput(error: unknown): string {
  const candidate = error as { stdout?: unknown; stderr?: unknown } | null;
  const stdout = typeof candidate?.stdout === 'string' ? candidate.stdout : '';
  const stderr = typeof candidate?.stderr === 'string' ? candidate.stderr : '';
  return `${stderr}\n${stdout}\n${errorText(error)}`.trim();
}

/**
 * 为 npm install 提供完备的 Node 运行时环境变量。
 * 将 npm 所在目录及全平台 Node 候选目录（fnm, nvm, volta, pnpm, Homebrew 等）
 * 注入到 PATH 中，确保即使在 Finder 启动的精简环境下，npm 内部调用 `node` 脚本也能顺利执行。
 */
/**
 * PATH 总长安全上限：Windows CreateProcess 的环境块上限 32,767 字符，
 * 取保守余量 28,000；unix 虽 ARG_MAX 宽裕也守同值，避免病态环境。
 */
const PATH_SAFETY_LIMIT = 28_000;

function buildNpmExecutionEnvironment(
  npmPath: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const pathKey = platform === 'win32' && env.Path ? 'Path' : 'PATH';
  const currentPath = env[pathKey] ?? env.PATH ?? env.Path ?? '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  const npmDir = path.dirname(path.resolve(npmPath));

  // 2026-09 E2BIG 修复：不再把全量版本管理器候选目录注入 PATH（重度
  // 用户机器上候选可达 15 万条，全量拼接直接 spawn E2BIG）。npm 的 shim
  // 只需要 `node` 可被 PATH 命中，而 node 与 npm 几乎总在同一目录——
  // 只注入 npm 所在目录 + fnm current 兑底即可，候选集仅供发现阶段使用。
  const minimalExtras = [
    npmDir,
    path.join(homeDir, '.local', 'share', 'fnm', 'current', 'bin'),
  ].filter(Boolean);

  const nextPath = Array.from(
    new Set([...minimalExtras, ...entries]),
  ).join(path.delimiter);

  if (nextPath.length > PATH_SAFETY_LIMIT) {
    // 病态长 PATH（用户系统本身超长）：退化为最小注入，绝不让环境块爆掉。
    const fallback = Array.from(new Set(minimalExtras)).join(path.delimiter);
    console.warn(
      `[lark-cli-manager] PATH exceeds safety limit (${nextPath.length} chars); using minimal injection`,
    );
    return { ...env, [pathKey]: fallback };
  }

  return { ...env, [pathKey]: nextPath };
}

/**
 * 容错解析 device flow 的 `--no-wait --json` 输出。
 * 输出可能混有非 JSON 行（日志、ANSI）：截取首个 `{` 到末尾后 JSON.parse；
 * 失败再退一步截到末个 `}`，兼容 JSON 之后尾随日志行的情况。
 * hint 字段（给 agent 的指令文本）随整体解析自然忽略，不单独处理。
 */
export function parseLenientDeviceAuthJson(raw: string): Record<string, unknown> {
  const cleaned = raw
    .replace(/^﻿/, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  if (start < 0) {
    throw new LarkCliManagerError(
      '无法从 lark-cli 输出中解析设备授权 JSON（未找到对象起点）',
      'parse_failed',
    );
  }
  const candidate = cleaned.slice(start);
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    const lastBrace = candidate.lastIndexOf('}');
    if (lastBrace > 0) {
      try {
        return JSON.parse(candidate.slice(0, lastBrace + 1)) as Record<string, unknown>;
      } catch {
        // fall through to the structured error below
      }
    }
    throw new LarkCliManagerError(
      `无法解析 lark-cli 设备授权输出：${tailLines(cleaned, 3)}`,
      'parse_failed',
    );
  }
}

export class LarkCliManager {
  /** 单例进行中标记：未完成的 device flow 存在时拒绝再次 start。 */
  private pendingDeviceAuth: { deviceCode: string; startedAt: number } | null = null;

  constructor(
    private readonly larkCliClient: LarkCliClientLike,
    private readonly configManager: ConfigManagerLike,
    private readonly discovery: ExecDiscoveryOptions = {},
  ) {}

  /**
   * 组合 lark-cli 认证就绪状态 + npm 可用性。checkAuthReady 的错误文案
   * （未安装/未找到）是安装检测的依据：lark-cli 缺失时 execFile ENOENT
   * 被分类为「未找到 lark-cli」，且此时不携带 larkCliVersion。
   */
  async getToolStatus(): Promise<LarkCliToolStatus> {
    const auth = await this.larkCliClient.checkAuthReady();
    const npm = this.findNpm();
    const notInstalledHint = auth.error
      ? /(?:未安装|未找到|not installed|not found|ENOENT)/i.test(auth.error)
      : false;
    return {
      larkCliInstalled: auth.larkCliVersion != null || !notInstalledHint,
      larkCliVersion: auth.larkCliVersion,
      authReady: auth.ready === true,
      missingScopes: auth.missingScopes ?? [],
      error: auth.error,
      npmAvailable: npm.available,
      npmPath: npm.path,
      // 最新版本对比（2026-09）：绿色只应留给真正最新的安装；落后时前端
      // 以琥珀色提示「可更新」。查询失败静默缺省，不影响状态卡片。
      latestLarkCliVersion: await this.queryLatestLarkCliVersion(npm),
    };
  }

  /**
   * `npm view @larksuite/cli version` 查询 registry 最新版（软失败）。
   * 输出形如 `"1.0.93\n"`（npm --json 下的字符串）或裸 `1.0.93`。
   */
  private async queryLatestLarkCliVersion(
    npm: { available: boolean; path: string | null },
  ): Promise<string | undefined> {
    if (!npm.available || !npm.path) return undefined;
    try {
      const { stdout } = await execFileAsync(
        quoteWindowsExecutablePath(npm.path, this.discovery.platform ?? process.platform),
        ['view', '@larksuite/cli', 'version'],
        {
          timeout: LATEST_VERSION_CHECK_TIMEOUT_MS,
          encoding: 'utf-8',
          windowsHide: true,
          shell: process.platform === 'win32',
          env: buildNpmExecutionEnvironment(
            npm.path,
            this.discovery.env ?? process.env,
            this.discovery.homeDir ?? os.homedir(),
            this.discovery.platform ?? process.platform,
          ),
        },
      );
      const match = /[0-9]+\.[0-9]+\.[0-9]+/.exec(stdout);
      return match ? match[0] : undefined;
    } catch {
      // 网络不通/registry 拒绝：最新版本信息缺席，前端退化为中性展示。
      return undefined;
    }
  }

  /**
   * npm 发现：win32 找 npm.cmd，其他找 npm；先 PATH，后常见安装位置
   * （镜像 resolveLarkCliExecutable 的发现模式——Finder 启动的应用拿不到
   * 用户 shell PATH）。复用 findExecutableOnPath：候选目录列表用
   * path.delimiter 拼接即可走同一条查找逻辑。
   */
  findNpm(): { available: boolean; path: string | null } {
    const platform = this.discovery.platform ?? process.platform;
    const env = this.discovery.env ?? process.env;
    const homeDir = this.discovery.homeDir ?? os.homedir();
    const names = platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];

    const fromPath = findExecutableOnPath(names, env.PATH ?? env.Path);
    if (fromPath) return { available: true, path: fromPath };

    const candidateDirectories = getNodeRuntimeCandidateDirectories(homeDir, env, platform);
    const fromCandidates = findExecutableOnPath(names, candidateDirectories.join(path.delimiter));
    if (fromCandidates) return { available: true, path: fromCandidates };

    return { available: false, path: null };
  }

  /**
   * 一键安装/更新（install 与 update 同命令，幂等）。全程 execFile + 参数
   * 数组；Windows 上 npm.cmd 需要经 shell 启动（与 execLarkCli 的
   * `.cmd` 处理一致），参数均为固定字面量，无注入面。
   *
   * 2026-09 鲁棒性增强：
   * 1. 注入完整的 Node 运行时环境（buildLarkCliEnvironment），解决从 Finder
   *    启动时 PATH 贫瘠导致 npm 找不到 `node` 的问题；
   * 2. 权限不足（EACCES/EPERM）时自动回退到用户免权限目录 `~/.npm-global`；
   * 3. 网络超时（ETIMEDOUT/fetch failed）时自动切换国内官方镜像重试；
   * 4. 输出诊断信息细化，彻底消除无因 `npm_failed`。
   */
  async installOrUpdateLarkCli(): Promise<LarkCliInstallResult> {
    const npm = this.findNpm();
    if (!npm.available || !npm.path) {
      return {
        ok: false,
        reason: 'npm_not_found',
        output: '未找到可用的 npm。请先安装 Node.js（https://nodejs.org）后重试。',
      };
    }

    const homeDir = this.discovery.homeDir ?? os.homedir();
    const platform = this.discovery.platform ?? process.platform;
    const execEnv = buildNpmExecutionEnvironment(
      npm.path,
      this.discovery.env ?? process.env,
      homeDir,
      platform,
    );
    let rawOutput = '';

    try {
      const { stdout, stderr } = await execFileAsync(
        quoteWindowsExecutablePath(npm.path, this.discovery.platform ?? process.platform),
        // 2026-09 包名修正：真正的 CLI 是 @larksuite/cli（registry 上的
        // `lark-cli` 是无关的 0.1.0 占位包，此前装错了包——「更新失败/
        // 可更新至 0.1.0」的根因）。
        ['install', '-g', '@larksuite/cli@latest'],
        {
          timeout: NPM_INSTALL_TIMEOUT_MS,
          encoding: 'utf-8',
          windowsHide: true,
          shell: process.platform === 'win32',
          env: execEnv,
        },
      );
      rawOutput = `${stdout}\n${stderr}`.trim();
    } catch (firstError) {
      const errOut = execErrorOutput(firstError);
      const isPermissionDenied = /EACCES|EPERM|permission denied/i.test(errOut);
      const isNetworkTimeout = /ETIMEDOUT|fetch failed|ECONNRESET|ENOTFOUND/i.test(errOut);

      if (isNetworkTimeout) {
        // 网络问题：尝试国内官方镜像源重试一次
        try {
          const { stdout, stderr } = await execFileAsync(
            quoteWindowsExecutablePath(npm.path, this.discovery.platform ?? process.platform),
            ['install', '-g', '@larksuite/cli@latest', '--registry=https://registry.npmmirror.com'],
            {
              timeout: NPM_INSTALL_TIMEOUT_MS,
              encoding: 'utf-8',
              windowsHide: true,
              shell: process.platform === 'win32',
              env: execEnv,
            },
          );
          rawOutput = `${stdout}\n${stderr}`.trim();
        } catch (mirrorError) {
          return {
            ok: false,
            reason: 'npm_failed',
            output: tailLines(execErrorOutput(mirrorError), INSTALL_OUTPUT_TAIL_LINES),
            error: `npm 网络连接超时（尝试官方源与镜像源均失败）：${errorText(firstError)}`,
          };
        }
      } else if (isPermissionDenied) {
        // 权限问题：尝试安装至用户免权限目录 ~/.npm-global
        const homeDir = this.discovery.homeDir ?? os.homedir();
        const userPrefix = path.join(homeDir, '.npm-global');
        try {
          const { stdout, stderr } = await execFileAsync(
            quoteWindowsExecutablePath(npm.path, this.discovery.platform ?? process.platform),
            ['install', '-g', '--prefix', userPrefix, '@larksuite/cli@latest'],
            {
              timeout: NPM_INSTALL_TIMEOUT_MS,
              encoding: 'utf-8',
              windowsHide: true,
              shell: process.platform === 'win32',
              env: execEnv,
            },
          );
          rawOutput = `${stdout}\n${stderr}\n(已自动切换至免权限目录: ${userPrefix})`.trim();
        } catch (prefixError) {
          return {
            ok: false,
            reason: 'npm_failed',
            output: tailLines(execErrorOutput(prefixError), INSTALL_OUTPUT_TAIL_LINES),
            error: `npm 全局安装权限不足（EACCES/EPERM），建议检查目录权限：${errorText(firstError)}`,
          };
        }
      } else {
        return {
          ok: false,
          reason: 'npm_failed',
          output: tailLines(errOut, INSTALL_OUTPUT_TAIL_LINES),
          error: errorText(firstError),
        };
      }
    }

    // 装完必须验证：npm 成功但 lark-cli 不可执行（PATH 缺失/损坏安装）
    // 时如实报 verify_failed，前端可引导用户检查环境。
    try {
      const version = await this.detectLarkCliVersion();
      return {
        ok: true,
        output: tailLines(rawOutput, INSTALL_OUTPUT_TAIL_LINES),
        version,
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'verify_failed',
        output: tailLines(rawOutput, INSTALL_OUTPUT_TAIL_LINES),
        error: errorText(error),
      };
    }
  }

  /**
   * 发起 device flow。立即返回 { verificationUrl, deviceCode, expiresIn }；
   * 已有进行中流程时抛 409 语义错误。
   */
  async startDeviceAuth(): Promise<DeviceAuthSession> {
    if (this.pendingDeviceAuth) {
      throw new LarkCliManagerError(
        '已有进行中的设备授权流程，请先完成或等待其结束',
        'device_auth_in_progress',
        409,
      );
    }

    const scopes = await this.resolveRequiredScopes();
    const larkCliPath = this.resolveLarkCliPath();
    let raw = '';
    try {
      const { stdout, stderr } = await execFileAsync(
        quoteWindowsExecutablePath(larkCliPath, this.discovery.platform ?? process.platform),
        ['auth', 'login', '--no-wait', '--json', '--scope', scopes.join(' ')],
        {
          timeout: DEVICE_AUTH_START_TIMEOUT_MS,
          encoding: 'utf-8',
          windowsHide: true,
          shell: process.platform === 'win32',
          env: buildLarkCliEnvironment(larkCliPath),
        },
      );
      raw = `${stdout}\n${stderr}`;
    } catch (error) {
      throw new LarkCliManagerError(
        `发起设备授权失败：${errorText(error)}`,
        'device_auth_start_failed',
        500,
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseLenientDeviceAuthJson(raw);
    } catch (error) {
      // parse 失败不落 pending 标记，用户可直接重试。
      throw error;
    }

    const deviceCode = typeof parsed.device_code === 'string' ? parsed.device_code : '';
    const verificationUrl = typeof parsed.verification_url === 'string' ? parsed.verification_url : '';
    const expiresIn = typeof parsed.expires_in === 'number' && parsed.expires_in > 0
      ? parsed.expires_in
      : 600;
    if (!deviceCode || !verificationUrl) {
      throw new LarkCliManagerError(
        '设备授权响应缺少 device_code 或 verification_url',
        'parse_failed',
        502,
      );
    }

    this.pendingDeviceAuth = { deviceCode, startedAt: Date.now() };
    return { verificationUrl, deviceCode, expiresIn };
  }

  /**
   * 阻塞等待浏览器授权完成。直接 execFile 绕过 LarkCliClient 串行队列
   * （否则 device-code 阻塞 10 分钟会卡死所有 lark-cli 功能）；完成后经
   * checkAuthReady() 如实返回最终就绪状态——device flow 只授予请求的
   * scope，仍有缺失时 missingScopes 原样带出。
   */
  async completeDeviceAuth(deviceCode: string): Promise<DeviceAuthCompleteResult> {
    if (
      typeof deviceCode !== 'string'
      || deviceCode.trim().length === 0
      || deviceCode.length >= MAX_DEVICE_CODE_LENGTH
    ) {
      throw new LarkCliManagerError(
        `deviceCode 必须是非空且长度小于 ${MAX_DEVICE_CODE_LENGTH} 的字符串`,
        'invalid_device_code',
        400,
      );
    }

    const larkCliPath = this.resolveLarkCliPath();
    let flowOk = true;
    let flowError: string | undefined;
    try {
      await execFileAsync(
        quoteWindowsExecutablePath(larkCliPath, this.discovery.platform ?? process.platform),
        ['auth', 'login', '--device-code', deviceCode],
        {
          timeout: DEVICE_AUTH_COMPLETE_TIMEOUT_MS,
          encoding: 'utf-8',
          windowsHide: true,
          shell: process.platform === 'win32',
          env: buildLarkCliEnvironment(larkCliPath),
        },
      );
    } catch (error) {
      // 过期/拒绝/超时都走这里：不吞错，原始分类信息进入 flowError。
      flowOk = false;
      flowError = tailLines(execErrorOutput(error), 3) || errorText(error);
    } finally {
      // 仅当本次完成的就是挂起中的那个 device flow 才清除标记；不匹配的
      // 杂散/过期旧码 complete 尝试不得中断真实进行中的会话（多窗口误触场景）。
      if (this.pendingDeviceAuth?.deviceCode === deviceCode) {
        this.pendingDeviceAuth = null;
      }
    }

    const readiness = await this.larkCliClient.checkAuthReady();
    return {
      ok: flowOk,
      ready: readiness.ready,
      larkCliVersion: readiness.larkCliVersion,
      currentScopes: readiness.currentScopes,
      missingScopes: readiness.missingScopes ?? [],
      identity: readiness.identity,
      error: flowError ?? readiness.error,
    };
  }

  /** 当前是否挂着未完成的 device flow（状态排查用）。 */
  hasPendingDeviceAuth(): boolean {
    return this.pendingDeviceAuth != null;
  }

  private resolveLarkCliPath(): string {
    const config = this.configManager.getConfig();
    // 复用 lark-cli-client 的 PATH/常见位置发现逻辑；configured path 来自
    // 用户设置（config.larkCliPath），与 LarkCliClient 共用同一来源。
    return resolveLarkCliExecutable(config?.larkCliPath, {
      env: this.discovery.env,
      homeDir: this.discovery.homeDir,
      platform: this.discovery.platform,
    });
  }

  private async resolveRequiredScopes(): Promise<string[]> {
    let config = this.configManager.getConfig();
    if (!config?.requiredScopes?.length) {
      // getConfig 是内存缓存；buildServer 已 load 过，这里兜底再 load 一次。
      config = await this.configManager.load().catch(() => null);
    }
    if (config?.requiredScopes?.length) return config.requiredScopes;
    return DEFAULT_REQUIRED_SCOPES;
  }

  /** `lark-cli --version` 验证（直连，30s 超时；失败抛错由调用方分类）。 */
  private async detectLarkCliVersion(): Promise<string> {
    const larkCliPath = this.resolveLarkCliPath();
    const { stdout } = await execFileAsync(quoteWindowsExecutablePath(larkCliPath, this.discovery.platform ?? process.platform), ['--version'], {
      timeout: VERSION_CHECK_TIMEOUT_MS,
      encoding: 'utf-8',
      windowsHide: true,
      shell: process.platform === 'win32',
      env: buildLarkCliEnvironment(larkCliPath),
    });
    const version = stdout.trim();
    if (!version) {
      throw new Error('lark-cli --version 输出为空');
    }
    return version;
  }
}
