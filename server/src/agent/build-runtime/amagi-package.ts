/**
 * build-runtime/amagi-package.ts — 版本化 amagi-pi 安装管理
 *
 * 设计来源：设计v2 §3.1 / §11（插件管理行）。Leader 修正轮（steer #11/反馈）要点：
 * - 内容哈希是完整内容冻结：分块哈希全文件，超预算（文件数/总字节）明确拒绝，
 *   绝不返回截断哈希；包内 symlink 一律拒绝（不能存在未哈希的可加载入口）。
 * - source 模式必须真实执行 pi CLI：物化到 staging 目录 → 验证 → rename 入位 →
 *   `pi install <绝对物化包路径>`（专用安装 home = 版本化目录本身）→ 核对 pi 写入的
 *   settings.json 包来源与包版本/哈希 → 记录 installedVia 实际命令。不做「只拷贝
 *   却报告 installedVia」的假安装。
 * - 幂等复用默认完整 verifyHash：被篡改的包在 install 复用路径上必须失败，
 *   不得以 fresh:false 可信返回。
 *
 * 布局（`<dataRoot>/agent/runtime-packages/amagi-pi@<版本>/`）：
 * - npm 模式：pi 落 `<目录>/npm/node_modules/amagi-pi`（实测 404：2.21.31 未发布公共
 *   npm，包发布后可用；pi 真实命令行 `npm install … --prefix <目录>/npm` 已实测锚点）。
 *   plugin-install-fix 后默认安装不再走 npm（已知 404），改走 installAmagiFromGit。
 * - source 模式：应用物化拷贝到 `<目录>/package/`（staging 验证后 rename，不覆盖已
 *   冻结版本），pi 对 local source 本就不复制（packages.md），拷贝是应用侧的版本化
 *   物化动作，pi install 负责登记与校验。Git 获取链 includeDependencies=true：连带
 *   冻结 pi git install 装好的 node_modules 运行依赖（amagi LSP 开箱即用依赖包内
 *   node_modules/.bin；用户手填 sourceDir 仍不拷 node_modules，沿用旧语义）。
 * - 安装后目录视为不可变（“装好后不原地修改”）；清理走整目录删除。
 *
 * Git 官方获取链（plugin-install-fix，installAmagiFromGit）：
 * 临时获取 home（runtime-packages/.acquire-*）→ 正式 pi CLI `pi install git:…@<完整
 * commit>`（pi 自会 clone + checkout + npm install 依赖，见 pi packages.md/git install）
 * → SDK list 模式解析真实实体包根 → 容器约束/HEAD commit/manifest 版本三重校验 →
 * 沿既有 source 冻结链（含依赖）+ 正式 pi local install 登记 → acquisition 溯源入记录。
 * 失败/超时绝不宣称装好；获取临时目录无论成败都清理。
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AmagiPackageRef } from './contracts.js';

const run = promisify(execFile);

/** 安装记录文件（位于版本化目录内，应用写、只读消费）。 */
export interface AmagiPackageInstallRecord {
  schemaVersion: 1;
  package: 'amagi-pi';
  version: string;
  installedAt: string;
  /** npm 模式 = pi CLI npm 安装；source 模式 = 物化 + pi install <绝对物化包路径>。 */
  layout: 'npm' | 'source';
  /** 实际执行的安装命令（审计与复现；不含密钥）。 */
  installedVia: { nodePath: string; piCliPath: string; sourceDir?: string; piInstallArgs: string[] };
  /** pi 写入安装 home settings.json 的 packages 声明（审计；source 模式必填核对）。 */
  piSettingsPackages?: unknown[];
  /** source 模式是否连同 node_modules 运行依赖一起冻结（Git 获取链为 true）。 */
  dependenciesIncluded?: boolean;
  /** Git 官方获取溯源（默认安装链）：临时获取 home 内 pi git install 的真实事实。 */
  acquisition?: AmagiGitAcquisition;
  contentHash: string;
  /** 哈希覆盖的文件数/字节数（审计）。 */
  hashedFiles: number;
  hashedBytes: number;
}

/** Git 官方获取事实（写入安装记录的 acquisition 字段）。 */
export interface AmagiGitAcquisition {
  via: 'pi-git-install';
  /** 实际传给 pi install 的 git 源 spec（含完整 commit）。 */
  gitSource: string;
  /** 仓库 URL（展示用）。 */
  repoUrl: string;
  /** 获取后验证过的 checkout HEAD（完整 commit）。 */
  commit: string;
  acquiredAt: string;
  /** SDK（inspect-packages list 模式）解析出的实体包根。 */
  acquiredPackageRoot: string;
  /** 实际执行的获取命令（审计与复现；不含密钥）。 */
  piInstallArgs: string[];
  /** 本应用对固定上游 commit 叠加的可审计本地修复。 */
  localPatchSha256?: string;
}

/**
 * 官方 Git 获取源（plugin-install-fix）：npm:amagi-pi@2.21.31 实测 404 未发布，
 * 默认安装不再走 npm，改经正式 Pi CLI 从官方仓库固定 commit 获取（无 tag，
 * 禁止追 latest；升级须同时重核能力探测）。语法锚定 pi docs packages.md
 * （`git:github.com/owner/repo@ref`，ref 为完整 commit 时即 pinned）。
 */
export const AMAGI_PI_GIT_REPO_URL = 'https://github.com/runrunrain/amagi-pi.git';
export const AMAGI_PI_GIT_COMMIT = '929000ecbd8725e72b191493345d6abeef51c147';
const AMAGI_LOCAL_PATCH = 'amagi-pi-2.21.31-background-continue.patch';
const AMAGI_LOCAL_PATCH_SHA256 = '362929c7f135dff7f02ff8cecea7766410f49cf8d6ef1bd45e344d2f9cdd0bc5';

export function amagiGitSourceSpec(commit: string = AMAGI_PI_GIT_COMMIT): string {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new AmagiPackageError('amagi_git_ref_invalid', `git ref 必须是完整 40 位 commit（拒绝 tag/分支/latest）: ${commit}`);
  }
  return `git:github.com/runrunrain/amagi-pi@${commit}`;
}

export const INSTALL_RECORD_FILENAME = 'install-record.json';

/** 内容哈希预算：超出即明确拒绝（fail-closed），不产出截断哈希。 */
export interface HashBudget {
  maxFiles: number;
  maxTotalBytes: number;
}

/** 缺省预算覆盖含本地依赖的新版 source；超限仍明确拒绝。 */
export const DEFAULT_HASH_BUDGET: HashBudget = {
  maxFiles: 30_000,
  maxTotalBytes: 512 * 1024 * 1024,
};

const HASH_CHUNK_BYTES = 1024 * 1024;
const INSTALL_TIMEOUT_MS = 300_000;

export class AmagiPackageError extends Error {
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
  readonly code: string;
}

export function runtimePackagesRoot(dataRoot: string): string {
  return path.join(dataRoot, 'agent', 'runtime-packages');
}

export function amagiInstallDir(dataRoot: string, version: string): string {
  if (!/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(version)) {
    throw new AmagiPackageError('amagi_version_invalid', `amagi-pi 版本号形式非法: ${version}`);
  }
  return path.join(runtimePackagesRoot(dataRoot), `amagi-pi@${version}`);
}

export function amagiPackageRoot(installDir: string): string {
  return path.join(installDir, 'npm', 'node_modules', 'amagi-pi');
}

/** source 模式包根（应用物化的冻结拷贝）。 */
export function amagiSourcePackageRoot(installDir: string): string {
  return path.join(installDir, 'package');
}

/** 按记录定位实际包根（npm 受管路径优先，兼容 source 布局）。 */
function locatePackageRoot(installDir: string, layout: AmagiPackageInstallRecord['layout']): string {
  return layout === 'source' ? amagiSourcePackageRoot(installDir) : amagiPackageRoot(installDir);
}

/**
 * 包内容哈希（完整内容冻结）：
 * - 按相对路径字典序遍历常规文件，逐文件分块（1MiB）流式哈希全量字节；
 * - 包内任何 symlink（目录或文件）一律拒绝——symlink 可指向包外可变内容，
 *   不能留下未哈希的可加载入口；
 * - 超 HashBudget（文件数/总字节）明确抛 amagi_hash_budget_exceeded，绝不截断。
 */
export function computePackageContentHash(
  packageRoot: string,
  budget: HashBudget = DEFAULT_HASH_BUDGET,
): { contentHash: string; files: number; bytes: number } {
  if (!fs.existsSync(packageRoot)) {
    throw new AmagiPackageError('amagi_package_missing', `amagi-pi 包目录不存在: ${packageRoot}`);
  }
  const relFiles: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new AmagiPackageError('amagi_symlink_in_package',
          `包内存在 symlink（未哈希的可加载入口，拒绝内容冻结）: ${path.relative(packageRoot, full) || full}`);
      }
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue; // fifo/socket 等跳过（不可执行入口）
      relFiles.push(path.relative(packageRoot, full).split(path.sep).join('/'));
    }
  };
  walk(packageRoot);
  if (relFiles.length > budget.maxFiles) {
    throw new AmagiPackageError('amagi_hash_budget_exceeded',
      `文件数 ${relFiles.length} 超预算 ${budget.maxFiles}——内容冻结拒绝（不产出截断哈希）`);
  }
  relFiles.sort();
  let chain = crypto.createHash('sha256');
  let bytes = 0;
  for (const rel of relFiles) {
    const full = path.join(packageRoot, rel);
    const size = fs.statSync(full).size;
    if (bytes + size > budget.maxTotalBytes) {
      throw new AmagiPackageError('amagi_hash_budget_exceeded',
        `总字节数将超预算 ${budget.maxTotalBytes}（已 ${bytes} + ${rel} ${size}）——内容冻结拒绝（不产出截断哈希）`);
    }
    const fileHash = crypto.createHash('sha256');
    const fd = fs.openSync(full, 'r');
    try {
      const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (read === 0) break;
        fileHash.update(buffer.subarray(0, read));
      }
    } finally {
      fs.closeSync(fd);
    }
    bytes += size;
    chain = chain.update(`${rel}\0${size}\0${fileHash.digest('hex')}\0`, 'utf-8');
  }
  return { contentHash: chain.digest('hex'), files: relFiles.length, bytes };
}

export function readPackageVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'));
    if (pkg?.name !== 'amagi-pi' || typeof pkg.version !== 'string') {
      throw new AmagiPackageError('amagi_package_invalid', `${packageRoot} 的 package.json 不是 amagi-pi`);
    }
    return pkg.version;
  } catch (error) {
    if (error instanceof AmagiPackageError) throw error;
    throw new AmagiPackageError('amagi_package_invalid', `读取 ${packageRoot}/package.json 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 校验已有安装并返回引用；不存在/不匹配/漂移时抛 AmagiPackageError（verifyHash 默认全量）。 */
export function verifyAmagiPackage(input: {
  dataRoot: string;
  version: string;
  /** 校验内容哈希（默认 true=完整重算；false 仅快速存在性核对，调用方自担）。 */
  verifyHash?: boolean;
}): AmagiPackageRef & { record: AmagiPackageInstallRecord } {
  const installDir = amagiInstallDir(input.dataRoot, input.version);
  const recordPath = path.join(installDir, INSTALL_RECORD_FILENAME);
  let record: AmagiPackageInstallRecord;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
  } catch {
    throw new AmagiPackageError('amagi_record_missing', `缺少安装记录 ${recordPath}（目录可能被外部改动，删除后重装）`);
  }
  const packageRoot = locatePackageRoot(installDir, record.layout ?? 'npm');
  const actualVersion = readPackageVersion(packageRoot);
  if (actualVersion !== input.version) {
    throw new AmagiPackageError('amagi_version_mismatch', `安装目录版本 ${actualVersion} ≠ 请求版本 ${input.version}`);
  }
  const ref: AmagiPackageRef & { record: AmagiPackageInstallRecord } = {
    version: actualVersion,
    installDir,
    packageRoot,
    contentHash: record.contentHash,
    record,
  };
  if (input.verifyHash !== false) {
    const current = computePackageContentHash(packageRoot);
    if (current.contentHash !== record.contentHash) {
      throw new AmagiPackageError('amagi_content_drift',
        `amagi-pi@${actualVersion} 内容哈希漂移（安装时 ${record.contentHash.slice(0, 12)}，当前 ${current.contentHash.slice(0, 12)}）——版本化目录不允许原地修改`);
    }
  }
  return ref;
}

/** 安装子进程环境：继承父环境但剔除应用凭据面，注入专用安装 home。
 * 安装是显式联网授权动作（npm/git/local 登记）：显式解除 PI_OFFLINE，
 * 防父环境残留 offline 让安装静默降级失败；遥测/版本检查同步关闭。 */
function buildInstallEnv(installDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: installDir };
  for (const key of Object.keys(env)) {
    if (/^FEISHU_SYNC_(AGENT_API_KEY|BUILD_MCP_TOKEN|AGENT_RUN_TOKEN)$/.test(key)) delete env[key];
  }
  delete env.ZHIPU_API_KEY;
  delete env.PI_OFFLINE;
  env.PI_SKIP_VERSION_CHECK = '1';
  env.PI_TELEMETRY = '0';
  return env;
}

async function runPiInstall(input: {
  nodePath: string; piCliPath: string; installDir: string; packageArg: string;
  npmRegistry?: string; timeoutMs?: number; log?: (line: string) => void;
}): Promise<string[]> {
  const args = [input.piCliPath, 'install', input.packageArg];
  if (input.npmRegistry) args.push('--registry', input.npmRegistry);
  input.log?.(`[build-runtime] pi install ${input.packageArg} → ${input.installDir}`);
  const env = buildInstallEnv(input.installDir);
  let stdout = '';
  let stderr = '';
  try {
    const result = await run(input.nodePath, args, {
      cwd: input.installDir,
      env,
      timeout: input.timeoutMs ?? INSTALL_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout; stderr = result.stderr;
  } catch (error) {
    const err = error as Error & { stderr?: string; killed?: boolean };
    throw new AmagiPackageError('amagi_install_failed',
      `pi install ${input.packageArg} 失败: ${err.message}${err.killed ? '（超时）' : ''}${err.stderr ? `\nstderr: ${String(err.stderr).slice(-2000)}` : ''}`);
  }
  input.log?.(`[build-runtime] install stdout 尾部: ${String(stdout).slice(-400)}`);
  if (String(stderr).trim()) input.log?.(`[build-runtime] install stderr 尾部: ${String(stderr).slice(-400)}`);
  return args;
}

/**
 * 安装固定版本 amagi-pi。幂等复用默认【完整哈希校验】——已安装但被篡改时，
 * 本函数抛 amagi_content_drift，绝不以 fresh:false 可信返回。
 */
export async function installAmagiPackage(input: {
  nodePath: string;
  piCliPath: string;
  dataRoot: string;
  version: string;
  /** 本地 amagi-pi 包根（未发布 npm 时用；source 模式）。 */
  sourceDir?: string;
  /** 连同 node_modules 运行依赖冻结（Git 获取链用；手填 sourceDir 不启用）。 */
  includeDependencies?: boolean;
  /** Git 获取溯源（写入安装记录；Git 默认安装链由 installAmagiFromGit 传入）。 */
  acquisition?: AmagiGitAcquisition;
  npmRegistry?: string;
  timeoutMs?: number;
  log?: (line: string) => void;
}): Promise<AmagiPackageRef & { record: AmagiPackageInstallRecord; fresh: boolean }> {
  const installDir = amagiInstallDir(input.dataRoot, input.version);
  if (fs.existsSync(path.join(installDir, INSTALL_RECORD_FILENAME))) {
    // 完整校验（默认）：篡改包在这里失败，复用才可信
    const existing = verifyAmagiPackage({ dataRoot: input.dataRoot, version: input.version });
    return { ...existing, fresh: false };
  }
  fs.mkdirSync(path.dirname(installDir), { recursive: true });
  if (input.sourceDir) {
    return installFromSource(input, installDir);
  }
  return installFromNpm(input, installDir);
}

/** npm 模式：`pi install npm:amagi-pi@<版本>`（包发布后可用；实测 2.21.31 未发布→404）。 */
async function installFromNpm(
  input: { nodePath: string; piCliPath: string; dataRoot: string; version: string; npmRegistry?: string; timeoutMs?: number; log?: (line: string) => void },
  installDir: string,
): Promise<AmagiPackageRef & { record: AmagiPackageInstallRecord; fresh: boolean }> {
  fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });
  const packageRoot = amagiPackageRoot(installDir);
  const piInstallArgs = await runPiInstall({
    ...input, installDir, packageArg: `npm:amagi-pi@${input.version}`,
  });
  const actualVersion = readPackageVersion(packageRoot);
  if (actualVersion !== input.version) {
    throw new AmagiPackageError('amagi_version_mismatch',
      `pi 安装结果版本 ${actualVersion} ≠ 请求版本 ${input.version}（检查该版本是否存在于 npm registry）`);
  }
  const { contentHash, files, bytes } = computePackageContentHash(packageRoot);
  const record: AmagiPackageInstallRecord = {
    schemaVersion: 1,
    package: 'amagi-pi',
    version: actualVersion,
    installedAt: new Date().toISOString(),
    layout: 'npm',
    installedVia: { nodePath: input.nodePath, piCliPath: input.piCliPath, piInstallArgs },
    contentHash,
    hashedFiles: files,
    hashedBytes: bytes,
  };
  return writeRecord(installDir, record, packageRoot);
}

const SOURCE_COPY_EXCLUDE = new Set(['node_modules', '.git', '.agent-outputs', 'agent-outputs', 'amagi-task', '.amagi-worktrees']);

/**
 * 拷贝阶段与哈希同规则：源内 symlink 一律拒绝（不静默丢弃——丢弃即留下与源不一致的包）。
 * includeNodeModules（Git 获取链）：连带冻结 node_modules 运行依赖。npm 布局的
 * node_modules/.bin shim 是指向包内真实文件的 symlink——物化为**稳定 launcher 转发
 * shim**（POSIX sh exec wrapper）：exec 目标于其原包内位置。不能用字节拷贝冒充——
 * 实测（Leader 真机 + 复现）：typescript-language-server 从自身文件位置向上找
 * package.json（findUpSync），拷到 .bin 后 `../package.json` 变成
 * node_modules/package.json → ENOENT exit 1（相对 import/import.meta.url 同理漂移）。
 * exec 转发则保持目标在原位置运行：ESM import.meta.url、CJS require.main、
 * 相对定位全部不漂移；转发目标用相对 .bin 的路径（随冻结包移动，不残留获取
 * 临时目录绝对路径）；目标必须仍在包内，指向包外的一律拒绝；其余位置 symlink
 * 仍拒绝。Windows npm .bin 为常规 .cmd/.ps1 文件（非 symlink），不走本分支。
 */

/** 双引号 shell 上下文安全转义（路径含空格/引号/`$`/反引号时不注入不漂移）。 */
function shDoubleQuoteEscape(value: string): string {
  return value.replace(/([\\"`$])/g, '\\$1');
}

/** 生成 .bin 转发 shim：#!/bin/sh，exec 包内目标于原位置（相对路径 + 运行时 $0 定位）。 */
function writeBinForwardingShim(dest: string, srcLink: string): void {
  // 相对路径在源树内计算（两侧 realpath 归一，防 /tmp→/private/tmp 别名互算）；
  // 冻结拷贝保持同构布局，相对路径在新位置同样成立。
  const targetReal = fs.realpathSync(srcLink);
  const binDirReal = fs.realpathSync(path.dirname(srcLink));
  const rel = path.relative(binDirReal, targetReal).split(path.sep).join('/');
  if (!rel || rel.startsWith('/') || path.isAbsolute(rel)) {
    throw new AmagiPackageError('amagi_symlink_in_source',
      `node_modules/.bin shim 相对目标计算失败: ${srcLink} → ${targetReal}`);
  }
  const script = `#!/bin/sh\nexec "$(dirname "$0")/${shDoubleQuoteEscape(rel)}" "$@"\n`;
  fs.writeFileSync(dest, script, { mode: 0o755 });
}

function copyTreeFiltered(from: string, to: string, options: { includeNodeModules?: boolean } = {}, packageRoot?: string): void {
  const root = packageRoot ?? from;
  // realpath 对齐两侧（macOS /var→/private/var 等）：symlink 目标经 realpath 解析，
  // 包根也必须同样归一，否则同一路径会被误判为包外。
  const rootReal = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const excluded = SOURCE_COPY_EXCLUDE.has(entry.name) && !(options.includeNodeModules && entry.name === 'node_modules');
    if (excluded) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isSymbolicLink()) {
      const inNpmBin = path.basename(path.dirname(src)) === '.bin' && path.basename(path.dirname(path.dirname(src))) === 'node_modules';
      if (!(options.includeNodeModules && inNpmBin)) {
        throw new AmagiPackageError('amagi_symlink_in_source',
          `源目录存在 symlink（拒绝物化，防包外可变入口）: ${src}`);
      }
      const target = fs.realpathSync(src);
      if (!isInsideOrEqual(target, rootReal)) {
        throw new AmagiPackageError('amagi_symlink_in_source',
          `node_modules/.bin shim 指向包外（拒绝物化）: ${src} → ${target}`);
      }
      if (!fs.statSync(target).isFile()) {
        throw new AmagiPackageError('amagi_symlink_in_source',
          `node_modules/.bin shim 目标不是常规文件（拒绝物化）: ${src} → ${target}`);
      }
      writeBinForwardingShim(dest, src);
      continue;
    }
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyTreeFiltered(src, dest, options, root);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
}

/** 目录包含关系（a 在 b 内或相等）。 */
function isInsideOrEqual(a: string, b: string): boolean {
  const rel = path.relative(path.resolve(b), path.resolve(a));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * source 模式：物化冻结包后正式 pi install。
 * 1) 源/目标包含关系守卫（防递归拷贝与自我覆盖）；
 * 2) staging 临时目录物化 + 版本/完整哈希验证；
 * 3) rename 入位（不覆盖已冻结版本；无记录的残留目录移 aside 不删除）；
 * 4) `pi install <绝对物化包路径>`（专用安装 home = installDir）；
 * 5) 核对 pi settings.json 实际包来源 + 版本/哈希复核；
 * 6) 写安装记录（installedVia 含实际 pi 命令）。
 */
async function installFromSource(
  input: { nodePath: string; piCliPath: string; dataRoot: string; version: string; sourceDir?: string; includeDependencies?: boolean; acquisition?: AmagiGitAcquisition; npmRegistry?: string; timeoutMs?: number; log?: (line: string) => void },
  installDir: string,
): Promise<AmagiPackageRef & { record: AmagiPackageInstallRecord; fresh: boolean }> {
  const sourceDir = path.resolve(input.sourceDir!);
  if (isInsideOrEqual(sourceDir, installDir) || isInsideOrEqual(installDir, sourceDir)) {
    throw new AmagiPackageError('amagi_source_target_overlap',
      `源目录 ${sourceDir} 与安装目录 ${installDir} 存在包含关系，拒绝（防递归拷贝/自我覆盖）`);
  }
  const sourceVersion = readPackageVersion(sourceDir);
  if (sourceVersion !== input.version) {
    throw new AmagiPackageError('amagi_version_mismatch',
      `源目录版本 ${sourceVersion} ≠ 请求版本 ${input.version}（source 模式要求源与请求版本一致，不猜测）`);
  }

  // ── staging 物化 + 验证 ──
  const staging = `${installDir}.staging-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const stagingPackage = path.join(staging, 'package');
  try {
    fs.mkdirSync(stagingPackage, { recursive: true, mode: 0o700 });
    input.log?.(`[build-runtime] source 物化 ${sourceDir} → ${stagingPackage}（staging，验证后 rename）`);
    copyTreeFiltered(sourceDir, stagingPackage, input.includeDependencies ? { includeNodeModules: true } : {});
    const stagedVersion = readPackageVersion(stagingPackage);
    if (stagedVersion !== input.version) {
      throw new AmagiPackageError('amagi_version_mismatch', `物化结果版本 ${stagedVersion} ≠ ${input.version}`);
    }
    const staged = computePackageContentHash(stagingPackage);

    // ── 入位：不覆盖已冻结版本；无记录残留移 aside ──
    if (fs.existsSync(installDir)) {
      if (fs.existsSync(path.join(installDir, INSTALL_RECORD_FILENAME))) {
        // 并发安装已完成（或上一轮已装）：丢弃 staging，走完整校验复用
        const existing = verifyAmagiPackage({ dataRoot: input.dataRoot, version: input.version });
        return { ...existing, fresh: false };
      }
      const aside = `${installDir}.stale-${Date.now()}`;
      fs.renameSync(installDir, aside); // 残留（无记录的半成品）保留 aside 供排查，不删除
      input.log?.(`[build-runtime] 残留目录移至 ${aside}`);
    }
    fs.renameSync(staging, installDir);
    const packageRoot = amagiSourcePackageRoot(installDir);

    // ── 正式 pi install（专用安装 home = installDir）──
    const piInstallArgs = await runPiInstall({
      ...input, installDir, packageArg: packageRoot,
    });
    // 核对 pi 实际写入的 settings.json 包来源
    const piSettingsPackages = readPiSettingsPackages(installDir);
    if (!piSettingsPackages.resolvesToPackageRoot) {
      throw new AmagiPackageError('amagi_pi_settings_mismatch',
        `pi install 后 settings.json 包声明未指向物化包根 ${packageRoot}（实际: ${JSON.stringify(piSettingsPackages.entries)}）`);
    }
    // pi local install 不复制包体，但安装命令可能改动目录：复核版本与完整哈希
    const finalVersion = readPackageVersion(packageRoot);
    if (finalVersion !== input.version) {
      throw new AmagiPackageError('amagi_version_mismatch', `pi install 后包版本 ${finalVersion} ≠ ${input.version}`);
    }
    const final = computePackageContentHash(packageRoot);
    if (final.contentHash !== staged.contentHash) {
      throw new AmagiPackageError('amagi_content_drift',
        `pi install 前后内容哈希漂移（staging ${staged.contentHash.slice(0, 12)} vs 最终 ${final.contentHash.slice(0, 12)}）`);
    }
    const record: AmagiPackageInstallRecord = {
      schemaVersion: 1,
      package: 'amagi-pi',
      version: finalVersion,
      installedAt: new Date().toISOString(),
      layout: 'source',
      installedVia: { nodePath: input.nodePath, piCliPath: input.piCliPath, sourceDir, piInstallArgs },
      piSettingsPackages: piSettingsPackages.entries,
      ...(input.includeDependencies ? { dependenciesIncluded: true } : {}),
      ...(input.acquisition ? { acquisition: input.acquisition } : {}),
      contentHash: final.contentHash,
      hashedFiles: final.files,
      hashedBytes: final.bytes,
    };
    return writeRecord(installDir, record, packageRoot);
  } finally {
    // staging 未成功 rename 时清理（rename 后 staging 已不存在，rmSync force 容忍）
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** 读取 pi 写入安装 home 的 settings.json packages，并核对是否解析到物化包根。 */
function readPiSettingsPackages(installDir: string): { entries: unknown[]; resolvesToPackageRoot: boolean } {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(installDir, 'settings.json'), 'utf-8'));
    const entries = Array.isArray(settings?.packages) ? (settings.packages as unknown[]) : [];
    const packageRoot = amagiSourcePackageRoot(installDir);
    const resolves = entries.some((entry: unknown) => {
      const source = typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? String((entry as { source?: unknown }).source ?? '') : '');
      if (!source) return false;
      const resolved = path.isAbsolute(source) ? source : path.resolve(installDir, source);
      return resolved === packageRoot;
    });
    return { entries, resolvesToPackageRoot: resolves };
  } catch (error) {
    throw new AmagiPackageError('amagi_pi_settings_mismatch',
      `读取 pi settings.json 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeRecord(
  installDir: string,
  record: AmagiPackageInstallRecord,
  packageRoot: string,
): AmagiPackageRef & { record: AmagiPackageInstallRecord; fresh: boolean } {
  const recordPath = path.join(installDir, INSTALL_RECORD_FILENAME);
  const tmp = `${recordPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, recordPath);
  return { version: record.version, installDir, packageRoot, contentHash: record.contentHash, record, fresh: true };
}

/** 供集成方核对包根关键结构（agents/、extensions/amagi-core）。 */
export function inspectAmagiPackageLayout(packageRoot: string): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!fs.existsSync(path.join(packageRoot, 'extensions', 'amagi-core'))) issues.push('缺少 extensions/amagi-core');
  if (!fs.existsSync(path.join(packageRoot, 'agents', 'luban.md'))) issues.push('缺少 agents/luban.md');
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Git 官方获取链（plugin-install-fix 默认安装）：正式 pi CLI git install 到临时
// 获取 home → SDK 解析真实包根 → 三重校验（容器约束/HEAD commit/manifest 版本）。
// ---------------------------------------------------------------------------

/** 只读解析 pi 写入获取 home settings.json 的包声明，返回实体路径（SDK list 模式）。 */
async function resolveAcquiredPackageRoot(input: {
  nodePath: string; helperPackageRoot: string; piPackageRoot: string | null;
  acquisitionRoot: string; gitSource: string; timeoutMs?: number; log?: (line: string) => void;
}): Promise<string> {
  const helper = path.join(input.helperPackageRoot, 'inspect-packages.mjs');
  const env = buildInstallEnv(input.acquisitionRoot);
  env.PI_OFFLINE = '1'; // 获取已完成，解析只读；缺失即显式失败，绝不触发补装
  if (!input.piPackageRoot) {
    throw new AmagiPackageError('amagi_acquisition_incomplete', 'Pi 包根缺失，无法解析获取实体');
  }
  const { stdout } = await run(input.nodePath, [helper, input.piPackageRoot, input.acquisitionRoot, 'list'], {
    cwd: input.acquisitionRoot,
    env,
    timeout: Math.min(input.timeoutMs ?? INSTALL_TIMEOUT_MS, 60_000),
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const line = stdout.split('\n').find((value) => value.startsWith('FEISHU_PACKAGES_JSON='));
  if (!line) throw new AmagiPackageError('amagi_acquisition_incomplete', '获取 home 内 SDK 未能解析包清单');
  const data = JSON.parse(line.slice('FEISHU_PACKAGES_JSON='.length)) as {
    packages?: Array<{ source?: unknown; installedPath?: unknown }>;
  };
  const hit = (Array.isArray(data.packages) ? data.packages : []).find((entry) => entry?.source === input.gitSource);
  const installedPath = typeof hit?.installedPath === 'string' ? hit.installedPath : '';
  if (!installedPath) {
    throw new AmagiPackageError('amagi_acquisition_incomplete',
      `SDK 未在获取 home 解析到 ${input.gitSource} 的实体（声明缺失或实体未落地）`);
  }
  input.log?.(`[build-runtime] SDK 解析获取实体: ${installedPath}`);
  return installedPath;
}

/**
 * 官方 Git 获取：在临时获取 home 内真实执行 `pi install git:…@<完整 commit>`。
 * pi 按 packages.md 语义 clone + checkout + 安装 dependencies（跳过 host peers）；
 * 获取后用 SDK 解析真实包根并验证：路径在获取 root 内、HEAD 恰为期望 commit、
 * manifest 是 amagi-pi 且版本恰为 pin（全局 36 ≠ 31，不受其影响）。
 * 任何失败抛错并如实报告，绝不返回半成品；临时目录清理由调用方（finally）。
 */
export async function acquireAmagiFromGit(input: {
  nodePath: string;
  piCliPath: string;
  /** inspect-packages.mjs 所在包根（应用工作台内置包）。 */
  helperPackageRoot: string;
  /** Pi 包根（SDK 来源；不可用则显式拒绝，不猜路径）。 */
  piPackageRoot: string | null;
  dataRoot: string;
  /** 期望的 amagi-pi 版本（构建 pin）。 */
  version: string;
  /** 缺省官方源；测试可注入（须与 expectedCommit 同源）。 */
  gitSource?: string;
  expectedCommit?: string;
  timeoutMs?: number;
  log?: (line: string) => void;
}): Promise<{ packageRoot: string; acquisitionRoot: string; acquisition: AmagiGitAcquisition }> {
  const gitSource = input.gitSource ?? amagiGitSourceSpec();
  const expectedCommit = (input.expectedCommit ?? AMAGI_PI_GIT_COMMIT).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
    throw new AmagiPackageError('amagi_git_ref_invalid', `期望 commit 必须是完整 40 位: ${expectedCommit}`);
  }
  if (!input.piPackageRoot || !fs.existsSync(path.join(input.piPackageRoot, 'dist', 'core', 'package-manager.js'))) {
    throw new AmagiPackageError('amagi_acquisition_failed',
      'Pi 包管理 SDK 不可用（无法解析 Git 获取结果）；请先在「运行时与模型」确认 Pi 运行时就绪，或改填本地 amagi-pi 目录安装');
  }
  const acquisitionRoot = path.join(runtimePackagesRoot(input.dataRoot), `.acquire-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(acquisitionRoot, { recursive: true, mode: 0o700 });
  input.log?.(`[build-runtime] Git 获取 ${gitSource} → 临时获取 home ${acquisitionRoot}`);
  // 失败自清理：临时获取目录是本函数的私有工作区，任何失败都不得残留；
  // 成功后由调用方（installAmagiFromGit finally）在冻结完成后回收。
  try {
    return await acquireIntoRoot(input, acquisitionRoot, gitSource, expectedCommit);
  } catch (error) {
    fs.rmSync(acquisitionRoot, { recursive: true, force: true });
    throw error;
  }
}

async function acquireIntoRoot(
  input: Parameters<typeof acquireAmagiFromGit>[0] & object,
  acquisitionRoot: string,
  gitSource: string,
  expectedCommit: string,
): Promise<{ packageRoot: string; acquisitionRoot: string; acquisition: AmagiGitAcquisition }> {
  let piInstallArgs: string[];
  try {
    piInstallArgs = await runPiInstall({ ...input, installDir: acquisitionRoot, packageArg: gitSource });
  } catch (error) {
    throw new AmagiPackageError('amagi_acquisition_failed',
      `Git 获取失败（需本机可用 git 与网络；也可改填本地 amagi-pi 目录安装）: ${error instanceof Error ? error.message : String(error)}`);
  }
  // SDK 解析真实包根（只读 list 模式）
  let packageRoot: string;
  try {
    packageRoot = await resolveAcquiredPackageRoot({ ...input, acquisitionRoot, gitSource });
  } catch (error) {
    if (error instanceof AmagiPackageError) throw error;
    throw new AmagiPackageError('amagi_acquisition_incomplete',
      `获取实体解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  // 约束 1：实体必须在临时获取 root 内且在 git/ 布局下（防预期包被调包）
  const sdkPackageRoot = packageRoot;
  const resolveContainedPackage = (): string => {
    try {
      if (fs.lstatSync(acquisitionRoot).isSymbolicLink()) throw new Error('获取根不能为链接');
      const root = fs.realpathSync.native(acquisitionRoot);
      const gitRoot = fs.realpathSync.native(path.join(root, 'git'));
      const actual = fs.realpathSync.native(sdkPackageRoot);
      const rel = path.relative(gitRoot, actual);
      if (path.relative(root, gitRoot) !== 'git' || rel === ''
        || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new Error('实体未严格包含于实际 git/ 容器');
      }
      return actual;
    } catch (error) {
      throw new AmagiPackageError('amagi_acquisition_incomplete',
        `获取实体不在临时获取 root 的实际 git/ 布局内: ${sdkPackageRoot}（${error instanceof Error ? error.message : String(error)}）`);
    }
  };
  packageRoot = resolveContainedPackage();
  // 约束 2：checkout HEAD 恰为期望完整 commit（git clone/checkout 由 pi 执行；此处复核）
  let head: string;
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, timeout: 30_000, windowsHide: true, maxBuffer: 4096 });
    head = stdout.trim().toLowerCase();
  } catch (error) {
    throw new AmagiPackageError('amagi_acquisition_failed',
      `获取实体无法验证 HEAD commit（需本机 git）: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (head !== expectedCommit) {
    throw new AmagiPackageError('amagi_acquisition_commit_mismatch',
      `获取实体 HEAD ${head} ≠ 期望 commit ${expectedCommit}（拒绝非预期内容）`);
  }
  // git 子进程等待期间不得更换实体；后续物化沿用同一实际路径。
  if (resolveContainedPackage() !== packageRoot) {
    throw new AmagiPackageError('amagi_acquisition_incomplete', '获取实体在 HEAD 校验期间发生变化');
  }
  // 约束 3：manifest 是 amagi-pi 且版本恰为 pin（全局 36 / 其他版本一律拒绝）
  const actualVersion = readPackageVersion(packageRoot);
  if (actualVersion !== input.version) {
    throw new AmagiPackageError('amagi_version_mismatch',
      `Git 获取结果版本 ${actualVersion} ≠ 请求版本 ${input.version}（固定版本不接受其他版本；本机全局安装的其他 amagi-pi 不影响构建）`);
  }
  return {
    packageRoot,
    acquisitionRoot,
    acquisition: {
      via: 'pi-git-install',
      gitSource,
      repoUrl: AMAGI_PI_GIT_REPO_URL,
      commit: head,
      acquiredAt: new Date().toISOString(),
      acquiredPackageRoot: packageRoot,
      piInstallArgs,
    },
  };
}

/**
 * 默认安装链（plugin-install-fix）：
 * 1) 已有安装记录 → 完整校验复用（幂等；漂移抛 amagi_content_drift，不覆盖不重装）；
 * 2) 否则官方 Git 固定 commit 获取（真实 pi CLI + 网络）→ 沿既有 source 冻结链
 *    （含 node_modules 运行依赖）→ 正式 pi local install 登记 → acquisition 入记录；
 * 3) 获取临时目录无论成败都清理（finally）；不走已知 404 的 npm 默认路径。
 */
export async function installAmagiFromGit(input: {
  nodePath: string;
  piCliPath: string;
  helperPackageRoot: string;
  piPackageRoot: string | null;
  dataRoot: string;
  version: string;
  gitSource?: string;
  expectedCommit?: string;
  timeoutMs?: number;
  log?: (line: string) => void;
}): Promise<AmagiPackageRef & { record: AmagiPackageInstallRecord; fresh: boolean }> {
  const installDir = amagiInstallDir(input.dataRoot, input.version);
  if (fs.existsSync(path.join(installDir, INSTALL_RECORD_FILENAME))) {
    const existing = verifyAmagiPackage({ dataRoot: input.dataRoot, version: input.version });
    return { ...existing, fresh: false };
  }
  fs.mkdirSync(path.dirname(installDir), { recursive: true });
  const acquired = await acquireAmagiFromGit(input);
  try {
    // Production pin carries two locally validated fixes: background length
    // continuation and shutdown queue closure. Apply only to the exact
    // upstream source/commit after its HEAD has been verified. The patch is
    // bundled with the app, hashed here, and the frozen package is rehashed
    // by installAmagiPackage; reinstall cannot silently fall back to old code.
    if ((input.gitSource ?? amagiGitSourceSpec()) === amagiGitSourceSpec()
      && (input.expectedCommit ?? AMAGI_PI_GIT_COMMIT).toLowerCase() === AMAGI_PI_GIT_COMMIT) {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const candidates = [
        path.resolve(here, '..', '..', 'patches', AMAGI_LOCAL_PATCH),
        path.resolve(here, '..', '..', '..', 'patches', AMAGI_LOCAL_PATCH),
      ];
      const patchPath = candidates.find((candidate) => fs.existsSync(candidate));
      if (!patchPath) throw new AmagiPackageError('amagi_local_patch_missing', `内置 amagi 修复补丁缺失：${AMAGI_LOCAL_PATCH}`);
      const patch = fs.readFileSync(patchPath);
      const digest = crypto.createHash('sha256').update(patch).digest('hex');
      if (digest !== AMAGI_LOCAL_PATCH_SHA256) {
        throw new AmagiPackageError('amagi_local_patch_drift', `内置 amagi 修复补丁哈希不符：${digest.slice(0, 12)}`);
      }
      const tempPatch = path.join(acquired.acquisitionRoot, AMAGI_LOCAL_PATCH);
      fs.writeFileSync(tempPatch, patch, { mode: 0o600 });
      try {
        await run('git', ['apply', '--check', tempPatch], { cwd: acquired.packageRoot, timeout: 30_000, windowsHide: true });
        await run('git', ['apply', tempPatch], { cwd: acquired.packageRoot, timeout: 30_000, windowsHide: true });
      } catch (error) {
        throw new AmagiPackageError('amagi_local_patch_failed', `固定版本修复补丁无法应用：${error instanceof Error ? error.message : String(error)}`);
      }
      acquired.acquisition.localPatchSha256 = digest;
      input.log?.(`[build-runtime] 已应用固定 amagi 修复补丁 sha256=${digest.slice(0, 16)}`);
    }
    return await installAmagiPackage({
      nodePath: input.nodePath,
      piCliPath: input.piCliPath,
      dataRoot: input.dataRoot,
      version: input.version,
      sourceDir: acquired.packageRoot,
      includeDependencies: true,
      acquisition: acquired.acquisition,
      timeoutMs: input.timeoutMs,
      log: input.log,
    });
  } finally {
    fs.rmSync(acquired.acquisitionRoot, { recursive: true, force: true });
  }
}
