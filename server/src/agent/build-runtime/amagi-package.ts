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
 * - source 模式：应用物化拷贝到 `<目录>/package/`（staging 验证后 rename，不覆盖已
 *   冻结版本），pi 对 local source 本就不复制（packages.md），拷贝是应用侧的版本化
 *   物化动作，pi install 负责登记与校验。
 * - 安装后目录视为不可变（“装好后不原地修改”）；清理走整目录删除。
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
  contentHash: string;
  /** 哈希覆盖的文件数/字节数（审计）。 */
  hashedFiles: number;
  hashedBytes: number;
}

export const INSTALL_RECORD_FILENAME = 'install-record.json';

/** 内容哈希预算：超出即明确拒绝（fail-closed），不产出截断哈希。 */
export interface HashBudget {
  maxFiles: number;
  maxTotalBytes: number;
}

/** 缺省预算：amagi-pi 2.21.31 source 物化实测约 3545 文件 / 85.5 MiB，留足余量。 */
export const DEFAULT_HASH_BUDGET: HashBudget = {
  maxFiles: 20_000,
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

function readPackageVersion(packageRoot: string): string {
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

/** 安装子进程环境：继承父环境但剔除应用凭据面，注入专用安装 home。 */
function buildInstallEnv(installDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: installDir };
  for (const key of Object.keys(env)) {
    if (/^FEISHU_SYNC_(AGENT_API_KEY|BUILD_MCP_TOKEN|AGENT_RUN_TOKEN)$/.test(key)) delete env[key];
  }
  delete env.ZHIPU_API_KEY;
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

const SOURCE_COPY_EXCLUDE = new Set(['node_modules', '.git', '.agent-outputs', 'amagi-task', '.amagi-worktrees']);

/** 拷贝阶段与哈希同规则：源内 symlink 一律拒绝（不静默丢弃——丢弃即留下与源不一致的包）。 */
function copyTreeFiltered(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SOURCE_COPY_EXCLUDE.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isSymbolicLink()) {
      throw new AmagiPackageError('amagi_symlink_in_source',
        `源目录存在 symlink（拒绝物化，防包外可变入口）: ${src}`);
    }
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyTreeFiltered(src, dest);
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
  input: { nodePath: string; piCliPath: string; dataRoot: string; version: string; sourceDir?: string; npmRegistry?: string; timeoutMs?: number; log?: (line: string) => void },
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
    copyTreeFiltered(sourceDir, stagingPackage);
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
