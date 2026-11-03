/**
 * build-runtime/amagi-discovery.ts — 已安装 amagi 候选只读发现
 *
 * 构建运行包是私有 runtime-packages 中的不可变副本；Pi home 已配置的本地
 * amagi-pi 是下一次构建的候选。只读发现提供候选事实，构建启动时选择较新稳定版
 * 并独立安装，当前构建仍使用自己的冻结哈希。
 *
 * 只读承诺（steer #3）：
 * - 复用 PiPluginService 的 inspect-packages.mjs 助手（正式 SDK
 *   SettingsManager/DefaultPackageManager），以新增 `list` 模式调用——
 *   listConfiguredPackages() 只读 settings + existsSync，绝不 resolve()
 *   （resolve 对缺失 npm/git 声明会自动补装）。不新造插件扫描器。
 * - 不执行扩展工厂、不写被检 home 的任何文件；PI_OFFLINE=1 仅作兜底，
 *   只读性由「不调 resolve」保证，而非环境变量假设。
 * - 全局 home 按官方解析位置（config.getAgentDir 语义：
 *   PI_CODING_AGENT_DIR 环境覆盖，否则 ~/.pi/agent）；不递归扫磁盘猜 repo。
 *
 * 诚实性：运行时/SDK 不可用或检测失败 → status 'unavailable'/'error'，
 * 不谎报「未安装」；settings.json 损坏 → settingsErrors 如实透出。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 候选来源（哪个 Pi home 发现的）。 */
export type AmagiCandidateOrigin = 'global-pi-home' | 'app-pi-home';

/** 单个已声明 amagi-pi 候选（manifest 名必须是 amagi-pi 才收录）。 */
export interface AmagiCandidate {
  origin: AmagiCandidateOrigin;
  /** settings.json 里的包声明原文（local 绝对路径 / git:… / npm:…）。 */
  source: string;
  sourceType: 'npm' | 'git' | 'local';
  /** SDK 解析的实体路径；声明存在但实体缺失时为 null（如实，不吞）。 */
  packagePath: string | null;
  /** 实体 package.json 的真实 version；不可读时 null。 */
  version: string | null;
  /** version === 构建固定版本（UI 推荐来源依据；不影响私有安装事实）。 */
  matchesPin: boolean;
}

/** 单个 home 的发现结果。 */
export interface AmagiHomeScan {
  origin: AmagiCandidateOrigin;
  /** ok=正常扫描；unavailable=运行时/SDK 缺失（不代表未安装）；error=检测失败。 */
  status: 'ok' | 'unavailable' | 'error';
  detail: string | null;
  /** settings.json 载入错误（broken declaration 不吞作未装）。 */
  settingsErrors: Array<{ scope: string; path: string | null; message: string }>;
  candidates: AmagiCandidate[];
}

/** Compare stable package versions without treating an unknown/prerelease tag as an automatic upgrade. */
export function compareAmagiVersions(left: string, right: string): number {
  const parse = (value: string): number[] | null => /^\d+\.\d+\.\d+$/.test(value)
    ? value.split('.').map(Number) : null;
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/** Only a locally configured, SDK resolved package can become the next build's source. */
export function preferredLocalAmagi(candidates: readonly AmagiCandidate[], minimumVersion: string): AmagiCandidate | null {
  const eligible = candidates.filter((candidate) => candidate.sourceType === 'local'
    && candidate.packagePath && path.isAbsolute(candidate.packagePath)
    && candidate.version && /^\d+\.\d+\.\d+$/.test(candidate.version)
    && compareAmagiVersions(candidate.version, minimumVersion) > 0);
  eligible.sort((a, b) => compareAmagiVersions(b.version!, a.version!)
    || a.origin.localeCompare(b.origin) || a.packagePath!.localeCompare(b.packagePath!));
  return eligible[0] ?? null;
}

/** 官方全局 Pi agent home 解析（pi config.getAgentDir 同语义）。 */
export function resolveGlobalPiAgentDir(parentEnv: NodeJS.ProcessEnv = process.env): string {
  const override = parentEnv.PI_CODING_AGENT_DIR?.trim();
  if (override === '~') return os.homedir();
  if (override?.startsWith('~/') || (process.platform === 'win32' && override?.startsWith('~\\'))) {
    return path.resolve(os.homedir(), override.slice(2));
  }
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.pi', 'agent');
}

/** 应用私有 Pi home（与 PiPluginService.agentDir 同位）。 */
export function resolveAppPiAgentDir(dataRoot: string): string {
  return path.join(dataRoot, 'agent', 'pi-home');
}

/** 只读子进程环境：剔除应用凭据面与模型 key；限定被检 home。 */
function buildInspectEnv(agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  for (const key of Object.keys(env)) {
    if (/^FEISHU_SYNC_(AGENT_API_KEY|AGENT_RUN_TOKEN|BUILD_MCP_TOKEN|AGENT_URL)$/.test(key)) delete env[key];
  }
  delete env.ZHIPU_API_KEY;
  env.PI_OFFLINE = '1';
  env.PI_SKIP_VERSION_CHECK = '1';
  env.PI_TELEMETRY = '0';
  return env;
}

/** 读取包实体的 manifest（name 校验 + version）；不可读返回 null。 */
function readManifest(installPath: string): { name: string; version: string } | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(installPath, 'package.json'), 'utf-8'));
    if (typeof pkg?.name !== 'string' || typeof pkg?.version !== 'string') return null;
    return { name: pkg.name, version: pkg.version };
  } catch {
    return null;
  }
}

/** 检测 Pi 包根的 SDK 是否可用（与 PiPluginService.inspect 同口径）。 */
export function piSdkAvailable(piPackageRoot: string | null | undefined, nodePath: string | null | undefined): boolean {
  if (!piPackageRoot || !nodePath) return false;
  return fs.existsSync(nodePath) && fs.existsSync(path.join(piPackageRoot, 'dist', 'core', 'package-manager.js'));
}

export interface ScanAmagiHomeInput {
  nodePath: string;
  /** inspect-packages.mjs 所在目录（应用工作台内置包根）。 */
  helperPackageRoot: string;
  /** 被检 Pi 包根（SDK）。 */
  piPackageRoot: string;
  agentDir: string;
  origin: AmagiCandidateOrigin;
  pinnedVersion: string;
  timeoutMs?: number;
}

/**
 * 只读扫描单个 Pi home 的已声明 amagi-pi 候选。
 * 任何失败都以 status 表达，绝不抛出（发现是状态的一部分，不是调用方错误）。
 */
export async function scanAmagiHome(input: ScanAmagiHomeInput): Promise<AmagiHomeScan> {
  const base: AmagiHomeScan = { origin: input.origin, status: 'ok', detail: null, settingsErrors: [], candidates: [] };
  if (!piSdkAvailable(input.piPackageRoot, input.nodePath)) {
    return { ...base, status: 'unavailable', detail: 'Pi 运行时或包管理 SDK 不可用（不影响已装包事实，仅无法发现该处候选）' };
  }
  if (!fs.existsSync(input.agentDir)) {
    // home 不存在=无任何声明（如实 ok/空候选）；只读发现绝不创建目录。
    return base;
  }
  const helper = path.join(input.helperPackageRoot, 'inspect-packages.mjs');
  if (!fs.existsSync(helper)) {
    return { ...base, status: 'unavailable', detail: 'inspect-packages 助手缺失（应用安装不完整）' };
  }
  try {
    const { stdout } = await run(input.nodePath, [helper, input.piPackageRoot, input.agentDir, 'list'], {
      cwd: input.agentDir,
      env: buildInspectEnv(input.agentDir),
      timeout: input.timeoutMs ?? 30_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const line = stdout.split('\n').find((value) => value.startsWith('FEISHU_PACKAGES_JSON='));
    if (!line) {
      return { ...base, status: 'error', detail: 'Pi 只读发现未返回包清单' };
    }
    const data = JSON.parse(line.slice('FEISHU_PACKAGES_JSON='.length)) as {
      packages?: Array<{ source?: unknown; scope?: unknown; installedPath?: unknown }>;
      settingsErrors?: Array<{ scope?: unknown; path?: unknown; message?: unknown }>;
    };
    const settingsErrors = Array.isArray(data.settingsErrors)
      ? data.settingsErrors
        .filter((item): item is { scope: string; path: string | null; message: string } =>
          Boolean(item) && typeof item === 'object' && typeof item.scope === 'string')
        .map((item) => ({ scope: item.scope, path: typeof item.path === 'string' ? item.path : null, message: typeof item.message === 'string' ? item.message : String((item as { message?: unknown }).message ?? '') }))
      : [];
    const candidates: AmagiCandidate[] = [];
    for (const entry of Array.isArray(data.packages) ? data.packages : []) {
      const source = typeof entry?.source === 'string' ? entry.source : '';
      if (!source) continue;
      // 只关心 user 声明（project 声明以 cwd 为准，不在此场景）
      if (entry.scope !== 'user') continue;
      const sourceType: AmagiCandidate['sourceType'] = source.startsWith('npm:')
        ? 'npm'
        : /^(git:|https?:|git@)/.test(source) ? 'git' : 'local';
      const installedPath = typeof entry.installedPath === 'string' && entry.installedPath !== '' ? entry.installedPath : null;
      const manifest = installedPath ? readManifest(installedPath) : null;
      // 只收录 amagi-pi 候选：实体在则以 manifest 名为准（防同路径段误报）；
      // 实体缺失/不可读时退回声明文本匹配，保留 packagePath=null 的如实状态。
      const declaredAmagi = manifest ? manifest.name === 'amagi-pi' : /amagi-pi/.test(source);
      if (!declaredAmagi) continue;
      candidates.push({
        origin: input.origin,
        source,
        sourceType,
        packagePath: installedPath,
        version: manifest?.name === 'amagi-pi' ? manifest.version : null,
        matchesPin: manifest?.name === 'amagi-pi' && manifest.version === input.pinnedVersion,
      });
    }
    return { ...base, settingsErrors, candidates };
  } catch (error) {
    const err = error as Error & { stderr?: string; killed?: boolean };
    const detail = err.killed
      ? 'Pi 只读发现超时'
      : `${err.message}${err.stderr ? `；stderr: ${String(err.stderr).slice(-300)}` : ''}`.slice(0, 500);
    return { ...base, status: 'error', detail };
  }
}
