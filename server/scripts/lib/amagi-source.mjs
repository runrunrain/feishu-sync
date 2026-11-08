/** amagi-pi 构建源解析：显式目录 / 远端最新 / 同级 checkout / 检入冻结包。
 *
 * 优先级（高→低）：
 *   1. AMAGI_PI_USE_BUNDLED=1 或 sourceDir=false → 检入冻结包（显式关闭取源）
 *   2. AMAGI_PI_SOURCE_DIR 显式目录 → 直接使用（不联网）
 *   3. AMAGI_PI_LATEST=1 → 远端默认分支 HEAD（或 AMAGI_PI_REF 指定分支/40 位 sha）浅取源；
 *      失败/校验不过时降级：同级 ../amagi-pi → 冻结包（每步打 WARN），除非
 *      AMAGI_PI_REQUIRE_LATEST=1（取不到最新即抛错）
 *   4. 同级 ../amagi-pi 存在则用；否则冻结包（历史默认行为）
 *
 * 安全约束：访问令牌（AMAGI_PI_TOKEN）只经 GIT_CONFIG_* 环境变量注入 git，
 * 不进 argv、URL、日志、异常与 manifest；输出前统一脱敏。仅用 node 内置模块。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_AMAGI_MAJOR = 2;
export const DEFAULT_AMAGI_PI_REPO = 'https://github.com/runrunrain/amagi-pi.git';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultSibling = path.resolve(serverRoot, '../../amagi-pi');
const noop = () => {};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const stableSemver = (value) => (typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : null);
const shortCommit = (commit) => (commit ? String(commit).slice(0, 8) : 'unknown');

/** 稳定 semver 比较（仅 x.y.z；不可解析返回 null）。 */
export function compareStableVersions(left, right) {
  const a = stableSemver(left);
  const b = stableSemver(right);
  if (!a || !b) return null;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** 令牌脱敏：异常与日志输出前统一调用；令牌原文及其 base64 形态都不得出现。 */
function redactSecrets(text, token) {
  let out = String(text);
  if (!token) return out;
  for (const secret of [token, Buffer.from(token).toString('base64'), Buffer.from(`x-access-token:${token}`).toString('base64')]) {
    if (secret) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

const errorMessage = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** git 子进程环境：始终禁交互；有令牌时只经 GIT_CONFIG_* 注入 Authorization 头。 */
function gitEnv(baseEnv, token) {
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

function runGit(args, { cwd, env, timeoutMs }) {
  // stdio 必须显式 pipe：execFileSync 默认把子进程 stderr 直接写到父进程 stderr，
  // 原始 git 错误（可能携带仓库 URL/路径）会绕过脱敏直接进构建日志。
  return execFileSync('git', args, { cwd, env, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** AMAGI_PI_REF 合法值：40 位 sha 或分支名（拒绝以 - 开头的选项注入形态）。 */
function sanitizeRef(ref) {
  if (!ref) return null;
  const value = String(ref).trim();
  if (!value) return null;
  if (/^[0-9a-f]{40}$/i.test(value) || (/^[\w][\w./-]*$/.test(value) && !value.includes('..'))) return value;
  throw new Error(`AMAGI_PI_REF 非法（须为分支名或 40 位 sha）：${redactSecrets(value, null)}`);
}

/** 远端浅取源：临时目录 git init + fetch --depth 1 + detach FETCH_HEAD（支持 sha 与分支）。 */
async function fetchRemoteSource({ repo, ref, token, env }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-amagi-source-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    runGit(['init', '--quiet'], { cwd: dir, env: gitEnv(env, null), timeoutMs: 15_000 });
    runGit(['fetch', '--depth', '1', '--no-tags', repo, ref ?? 'HEAD'], { cwd: dir, env: gitEnv(env, token), timeoutMs: 120_000 });
    runGit(['checkout', '--detach', 'FETCH_HEAD'], { cwd: dir, env: gitEnv(env, null), timeoutMs: 30_000 });
    const commit = runGit(['rev-parse', 'HEAD'], { cwd: dir, env: gitEnv(env, null), timeoutMs: 15_000 });
    const pkg = readJson(path.join(dir, 'package.json'));
    return { dir, commit, pkg, cleanup };
  } catch (error) {
    cleanup();
    throw new Error(`git 取源失败（${repo} ${ref ?? 'HEAD'}）：${redactSecrets(errorMessage(error), token)}`);
  }
}

/** 远端候选校验：稳定 amagi-pi 包 + 受支持主版本 + 不低于检入冻结包版本。 */
function validateRemotePackage(pkg, bundledVersion) {
  if (pkg?.name !== 'amagi-pi' || !stableSemver(pkg?.version)) {
    return `远端 package.json 不是稳定的 amagi-pi 包（name=${String(pkg?.name)}, version=${String(pkg?.version)}）`;
  }
  const major = Number(pkg.version.split('.')[0]);
  if (major !== SUPPORTED_AMAGI_MAJOR) {
    return `远端 amagi-pi ${pkg.version} 主版本 ${major} 不受支持（当前支持主版本 ${SUPPORTED_AMAGI_MAJOR}）；跨主版本需先适配应用运行时再升级`;
  }
  if (stableSemver(bundledVersion) && compareStableVersions(pkg.version, bundledVersion) < 0) {
    return `远端 amagi-pi ${pkg.version} 低于检入冻结包 ${bundledVersion}：拒绝降级，保持冻结包`;
  }
  return null;
}

/** 读源目录的 version/commit（尽力而为；正式校验仍在 bundleAmagi 打包流程内）。 */
function describeLocalSource(dir) {
  let version = null;
  try { version = readJson(path.join(dir, 'package.json'))?.version ?? null; } catch { /* 由 bundleAmagi 校验 */ }
  let commit = null;
  try { commit = runGit(['rev-parse', 'HEAD'], { cwd: dir, env: gitEnv(process.env, null), timeoutMs: 15_000 }); } catch { /* source archive */ }
  return { version, commit };
}

/**
 * 解析 amagi-pi 构建源。
 * @returns {Promise<{dir: string|null, origin: 'explicit'|'remote-latest'|'sibling'|'bundled', commit: string|null, version: string|null, cleanup: () => void}>}
 */
export async function resolveAmagiSource({
  sourceDir = process.env.AMAGI_PI_SOURCE_DIR,
  bundleDir = path.join(serverRoot, 'bundled', 'amagi-pi'),
  sibling = defaultSibling,
  env = process.env,
} = {}) {
  // 优先级 1：显式关闭取源（行为与历史 bundleAmagi 一致）
  if (sourceDir === false || env.AMAGI_PI_USE_BUNDLED === '1') {
    return { dir: null, origin: 'bundled', commit: null, version: null, cleanup: noop };
  }
  // 优先级 2：显式目录（不联网）
  if (sourceDir) {
    const dir = path.resolve(sourceDir);
    const local = describeLocalSource(dir);
    return { dir, origin: 'explicit', commit: local.commit, version: local.version, cleanup: noop };
  }
  let bundled = null;
  try { bundled = readJson(path.join(bundleDir, 'manifest.json')); } catch { /* first bundle */ }
  const bundledResult = () => ({ dir: null, origin: 'bundled', commit: bundled?.sourceCommit ?? null, version: bundled?.version ?? null, cleanup: noop });
  // 优先级 3：远端最新模式（AMAGI_PI_LATEST=1）
  if (env.AMAGI_PI_LATEST === '1') {
    const token = env.AMAGI_PI_TOKEN || null;
    const repo = env.AMAGI_PI_REPO || DEFAULT_AMAGI_PI_REPO;
    try {
      const ref = sanitizeRef(env.AMAGI_PI_REF);
      const fetched = await fetchRemoteSource({ repo, ref, token, env });
      const invalid = validateRemotePackage(fetched.pkg, bundled?.version);
      if (invalid) {
        fetched.cleanup();
        throw new Error(invalid);
      }
      console.info(`[amagi-source] 远端最新取源成功：amagi-pi ${fetched.pkg.version} @ ${shortCommit(fetched.commit)}（${repo} ${ref ?? 'HEAD'}）`);
      return { dir: fetched.dir, origin: 'remote-latest', commit: fetched.commit, version: fetched.pkg.version, cleanup: fetched.cleanup };
    } catch (error) {
      const reason = redactSecrets(errorMessage(error), token);
      if (env.AMAGI_PI_REQUIRE_LATEST === '1') {
        throw new Error(`AMAGI_PI_REQUIRE_LATEST=1：取不到远端最新 amagi-pi，构建失败。原因：${reason}`);
      }
      if (fs.existsSync(path.join(sibling, 'package.json'))) {
        console.warn(`[amagi-source] WARN 远端最新取源失败（${reason}）；本次采用同级 checkout：${sibling}`);
        return { dir: sibling, origin: 'sibling', ...describeLocalSource(sibling), cleanup: noop };
      }
      console.warn(`[amagi-source] WARN 远端最新取源失败（${reason}）；本次采用检入冻结包 amagi-pi ${bundled?.version ?? '?'} @ ${shortCommit(bundled?.sourceCommit)}`);
      return bundledResult();
    }
  }
  // 优先级 4：同级 checkout（历史默认），否则冻结包
  if (fs.existsSync(path.join(sibling, 'package.json'))) {
    return { dir: sibling, origin: 'sibling', ...describeLocalSource(sibling), cleanup: noop };
  }
  return bundledResult();
}
