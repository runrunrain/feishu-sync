/**
 * amagi-source.mjs 单测：来源解析/远端取源/校验降级链（不跑完整 npm ci 打包）。
 *
 * 用 git init 建临时“远端”仓库（本地路径作为 AMAGI_PI_REPO），覆盖：
 * 默认 HEAD / 指定 sha / 指定分支 / 主版本不符 / 禁止降级 / 取源失败降级 /
 * REQUIRE_LATEST 抛错 / 令牌脱敏 / 临时目录清理 / 显式来源优先级。
 */
import { afterAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const roots: string[] = [];
const temp = (prefix = 'amagi-source-test-') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};
afterAll(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

const git = (args: string[], cwd: string) => { execFileSync('git', args, { cwd, encoding: 'utf8' }); };

/** 临时“远端”仓库：每项一个 commit（最小 amagi-pi package.json + lock）。 */
function makeRemoteRepo(commits: Array<{ version: string; name?: string }>) {
  const dir = temp('amagi-source-remote-');
  git(['init', '--quiet', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  const shas: string[] = [];
  commits.forEach(({ version, name = 'amagi-pi' }, index) => {
    fs.mkdirSync(path.join(dir, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module' }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name, version, lockfileVersion: 3, packages: { '': { name, version } } }));
    fs.writeFileSync(path.join(dir, 'extensions/index.ts'), `export default function () { /* ${version}-${index} */ }\n`);
    git(['add', '.'], dir);
    git(['commit', '--quiet', '-m', `v${version}`], dir);
    shas.push(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());
  });
  // 与 GitHub 一致：允许按任意 sha 取源（uploadpack allowAnySHA1InWant 语义）。
  git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], dir);
  return { dir, shas };
}

function makeBundledDir(version: string, sourceCommit: string | null = null) {
  const dir = temp('amagi-source-bundled-');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version, sourceCommit }));
  return dir;
}

function makeSourceDir(version: string, name = 'amagi-pi') {
  const dir = temp('amagi-source-dir-');
  fs.mkdirSync(path.join(dir, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module' }));
  return dir;
}

const missing = (prefix = 'missing-') => path.join(temp(`amagi-source-${prefix}`), 'absent');

/** 干净环境：剥掉宿主 AMAGI_PI_ 与 GIT_ 前缀注入，测试用显式 env 对象驱动。 */
function envWith(overrides: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('AMAGI_PI_') || key.startsWith('GIT_') || value === undefined) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

const latest = (repo: string, extra: Record<string, string> = {}) => ({ AMAGI_PI_LATEST: '1', AMAGI_PI_REPO: repo, ...extra });

async function loadModule() {
  return import('../scripts/lib/amagi-source.mjs');
}

it('remote HEAD: fetches default-branch tip, reports version/commit and cleans the temp checkout', async () => {
  const { resolveAmagiSource, SUPPORTED_AMAGI_MAJOR } = await loadModule();
  const remote = makeRemoteRepo([{ version: '2.22.0' }, { version: '2.23.0' }]);
  const bundledDir = makeBundledDir('2.21.0');
  const result = await resolveAmagiSource({ bundleDir: bundledDir, sibling: missing(), env: envWith(latest(remote.dir)) });
  expect(result.origin).toBe('remote-latest');
  expect(result.version).toBe('2.23.0');
  expect(result.commit).toBe(remote.shas[1]);
  expect(String(result.version).split('.')[0]).toBe(String(SUPPORTED_AMAGI_MAJOR));
  expect(fs.existsSync(path.join(result.dir!, 'package.json'))).toBe(true);
  result.cleanup();
  expect(fs.existsSync(result.dir!)).toBe(false);
});

it('AMAGI_PI_REF accepts a 40-hex sha, a branch name, and treats an empty value as unset', async () => {
  const { resolveAmagiSource } = await loadModule();
  const remote = makeRemoteRepo([{ version: '2.22.0' }, { version: '2.23.0' }]);
  git(['branch', 'stable', remote.shas[0]], remote.dir);
  const base = { bundleDir: makeBundledDir('2.21.0'), sibling: missing() };
  const bySha = await resolveAmagiSource({ ...base, env: envWith(latest(remote.dir, { AMAGI_PI_REF: remote.shas[0] })) });
  expect(bySha.origin).toBe('remote-latest');
  expect(bySha.version).toBe('2.22.0');
  expect(bySha.commit).toBe(remote.shas[0]);
  bySha.cleanup();
  const byBranch = await resolveAmagiSource({ ...base, env: envWith(latest(remote.dir, { AMAGI_PI_REF: 'stable' })) });
  expect(byBranch.version).toBe('2.22.0');
  byBranch.cleanup();
  const headOnEmpty = await resolveAmagiSource({ ...base, env: envWith(latest(remote.dir, { AMAGI_PI_REF: '' })) });
  expect(headOnEmpty.version).toBe('2.23.0');
  headOnEmpty.cleanup();
});

it('an unsupported major version is rejected with a reason and degrades to the frozen bundle (WARN)', async () => {
  const { resolveAmagiSource, SUPPORTED_AMAGI_MAJOR } = await loadModule();
  const remote = makeRemoteRepo([{ version: `${SUPPORTED_AMAGI_MAJOR + 1}.0.1` }]);
  const warns: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args) => warns.push(args.join(' ')));
  try {
    const result = await resolveAmagiSource({ bundleDir: makeBundledDir('2.21.0'), sibling: missing(), env: envWith(latest(remote.dir)) });
    expect(result.origin).toBe('bundled');
    expect(result.dir).toBeNull();
    expect(result.version).toBe('2.21.0');
    expect(warns.join('\n')).toContain(`主版本 ${SUPPORTED_AMAGI_MAJOR + 1} 不受支持`);
  } finally { spy.mockRestore(); }
});

it('a remote version lower than the checked-in manifest is refused (no downgrade, frozen bundle kept, WARN)', async () => {
  const { resolveAmagiSource } = await loadModule();
  const remote = makeRemoteRepo([{ version: '2.21.9' }]);
  const warns: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args) => warns.push(args.join(' ')));
  try {
    const result = await resolveAmagiSource({ bundleDir: makeBundledDir('2.22.0'), sibling: missing(), env: envWith(latest(remote.dir)) });
    expect(result.origin).toBe('bundled');
    expect(result.version).toBe('2.22.0');
    expect(warns.join('\n')).toContain('拒绝降级');
    expect(warns.join('\n')).toContain('2.21.9');
  } finally { spy.mockRestore(); }
});

it('a failed fetch degrades to the sibling checkout, then to the frozen bundle, each with a one-line WARN', async () => {
  const { resolveAmagiSource } = await loadModule();
  const brokenRepo = missing('broken-repo');
  const siblingDir = makeSourceDir('2.20.0');
  let warns: string[] = [];
  let spy = vi.spyOn(console, 'warn').mockImplementation((...args) => warns.push(args.join(' ')));
  try {
    const toSibling = await resolveAmagiSource({ bundleDir: makeBundledDir('2.21.0'), sibling: siblingDir, env: envWith(latest(brokenRepo)) });
    expect(toSibling.origin).toBe('sibling');
    expect(toSibling.dir).toBe(siblingDir);
    expect(toSibling.version).toBe('2.20.0');
    expect(warns.filter((line) => line.startsWith('[amagi-source] WARN'))).toHaveLength(1);
    expect(warns.join('\n')).toContain('同级 checkout');
  } finally { spy.mockRestore(); }
  warns = [];
  spy = vi.spyOn(console, 'warn').mockImplementation((...args) => warns.push(args.join(' ')));
  try {
    const toBundled = await resolveAmagiSource({ bundleDir: makeBundledDir('2.21.0'), sibling: missing('no-sibling'), env: envWith(latest(brokenRepo)) });
    expect(toBundled.origin).toBe('bundled');
    expect(toBundled.version).toBe('2.21.0');
    expect(warns.join('\n')).toContain('检入冻结包');
  } finally { spy.mockRestore(); }
});

it('AMAGI_PI_REQUIRE_LATEST=1 turns any fetch/validation failure into an error', async () => {
  const { resolveAmagiSource } = await loadModule();
  await expect(resolveAmagiSource({ bundleDir: makeBundledDir('2.21.0'), sibling: missing('no-sibling'),
    env: envWith(latest(missing('broken-repo'), { AMAGI_PI_REQUIRE_LATEST: '1' })) }))
    .rejects.toThrow(/AMAGI_PI_REQUIRE_LATEST=1/);
  const remote = makeRemoteRepo([{ version: '2.21.9' }]);
  await expect(resolveAmagiSource({ bundleDir: makeBundledDir('2.22.0'), sibling: missing('no-sibling'),
    env: envWith(latest(remote.dir, { AMAGI_PI_REQUIRE_LATEST: '1' })) }))
    .rejects.toThrow(/拒绝降级/);
});

it('the access token never appears in thrown messages or logs (raw or base64 forms)', async () => {
  const { resolveAmagiSource } = await loadModule();
  const token = 'SECRET-TARKIN-TOKEN-zz9x';
  // 仓库路径本身含令牌特征串：若未脱敏，错误消息与 WARN 必然携带它。
  const poisonedRepo = path.join(temp('amagi-source-poison-'), `${token}-repo`);
  const tokenEnv = latest(poisonedRepo, { AMAGI_PI_TOKEN: token });
  const captured: string[] = [];
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => captured.push(args.join(' ')));
  const infoSpy = vi.spyOn(console, 'info').mockImplementation((...args) => captured.push(args.join(' ')));
  try {
    try {
      await resolveAmagiSource({ bundleDir: makeBundledDir('2.21.0'), sibling: missing('no-sibling'),
        env: envWith({ ...tokenEnv, AMAGI_PI_REQUIRE_LATEST: '1' }) });
      expect.unreachable('expected REQUIRE_LATEST failure');
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      expect(message).not.toContain(token);
      expect(message).not.toContain(Buffer.from(token).toString('base64'));
      expect(message).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));
      expect(message).toContain('[REDACTED]');
    }
    await resolveAmagiSource({ bundleDir: makeBundledDir('2.21.0'), sibling: missing('no-sibling'), env: envWith(tokenEnv) });
    const logged = captured.join('\n');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(Buffer.from(token).toString('base64'));
  } finally { warnSpy.mockRestore(); infoSpy.mockRestore(); }
});

it('explicit AMAGI_PI_SOURCE_DIR and AMAGI_PI_USE_BUNDLED outrank the latest mode', async () => {
  const { resolveAmagiSource } = await loadModule();
  const explicitDir = makeSourceDir('2.19.0');
  const bundledDir = makeBundledDir('2.21.0');
  const explicit = await resolveAmagiSource({ sourceDir: explicitDir, bundleDir: bundledDir, sibling: missing('no-sibling'),
    env: envWith(latest(missing('broken-repo'))) });
  expect(explicit.origin).toBe('explicit');
  expect(explicit.dir).toBe(path.resolve(explicitDir));
  const frozen = await resolveAmagiSource({ sourceDir: explicitDir, bundleDir: bundledDir, sibling: missing('no-sibling'),
    env: envWith(latest(missing('broken-repo'), { AMAGI_PI_USE_BUNDLED: '1' })) });
  expect(frozen.origin).toBe('bundled');
  expect(frozen.dir).toBeNull();
});

it('without the latest mode the historical priority stays: sibling checkout when present, else the frozen bundle', async () => {
  const { resolveAmagiSource } = await loadModule();
  const siblingDir = makeSourceDir('2.20.0');
  const viaSibling = await resolveAmagiSource({ bundleDir: makeBundledDir('2.21.0'), sibling: siblingDir, env: envWith({}) });
  expect(viaSibling.origin).toBe('sibling');
  const viaBundled = await resolveAmagiSource({ bundleDir: makeBundledDir('2.21.0'), sibling: missing('no-sibling'), env: envWith({}) });
  expect(viaBundled.origin).toBe('bundled');
});
