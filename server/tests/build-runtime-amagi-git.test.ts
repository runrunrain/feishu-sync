/**
 * amagi Git 官方获取链单测（plugin-install-fix 默认安装）。
 *
 * fixtures（helpers/fake-pi-git-sdk）：假 Pi SDK（只读清单契约 + resolve 抛错正控）、
 * 真实 git 仓库模板（manifest/node_modules/.bin symlink 结构对齐 pi git install
 * 实测落盘）、假 pi CLI（git/local 落盘 + 全调用记录）。
 * 覆盖：默认链成功（含依赖冻结与溯源）、版本不匹配、CLI 失败、SDK 解析缺失、
 * commit 不匹配、凭据剔除/PI_OFFLINE 解除、.bin 外指 symlink 拒绝、幂等复用与
 * 漂移拒绝、host 并发 busy、host statusDto 在运行时不可用时仍如实报已装事实。
 */

import { describe, expect, it, afterAll, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AMAGI_PI_GIT_COMMIT, INSTALL_RECORD_FILENAME, amagiInstallDir,
  installAmagiFromGit, verifyAmagiPackage,
} from '../src/agent/build-runtime/amagi-package.js';
import {
  gitAvailable, makeFakePiCli, makeFakePiSdk, makeGitFixtureRepo, makeMiniSource,
} from './helpers/fake-pi-git-sdk.js';
import { BuildRuntimeHost } from '../src/kb/build-runtime-host.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import { piWorkbenchPackageRoot } from '../src/agent/agent-assets.js';

const runCli = promisify(execFile);

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amagi-git-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

interface Fixture {
  root: string;
  sdkRoot: string;
  cli: ReturnType<typeof makeFakePiCli>;
  gitSource: string;
  commit: string;
}

/** git 可用性门（无 git 全文件跳过——模板仓库与 HEAD 复核都是真 git）。 */
function needsGit(ctx: { skip(): void }): void {
  if (!gitAvailable()) ctx.skip();
}

async function makeFixture(version = '2.21.31', options: { binSymlinkOutside?: string } = {}): Promise<Fixture> {
  const root = tmpRoot();
  const template = makeGitFixtureRepo(root, { version, ...(options.binSymlinkOutside ? { binSymlinkOutside: options.binSymlinkOutside } : {}) });
  const sdkRoot = makeFakePiSdk(root);
  const cli = makeFakePiCli(root, template);
  // 与模板仓库同源的 spec/commit（生产路径缺省官方源；此处注入 fixture 对）
  const gitSource = `git:github.com/runrunrain/amagi-pi@${template.commit}`;
  return { root, sdkRoot, cli, gitSource, commit: template.commit };
}

const HELPER_ROOT = piWorkbenchPackageRoot();

const installVia = (f: Fixture) => installAmagiFromGit({
  nodePath: process.execPath,
  piCliPath: f.cli.cliPath,
  helperPackageRoot: HELPER_ROOT,
  piPackageRoot: f.sdkRoot,
  dataRoot: f.root,
  version: '2.21.31',
  gitSource: f.gitSource,
  expectedCommit: f.commit,
});

describe('installAmagiFromGit（默认 Git 获取链）', () => {
  it.skipIf(!gitAvailable()).each(['package', 'git', 'root'] as const)('拒绝 %s 获取位置被链接替换到容器外（HEAD/版本仍正确）', async kind => {
    const f = await makeFixture();
    let replaced = false;
    const promise = installAmagiFromGit({
      nodePath: process.execPath, piCliPath: f.cli.cliPath, helperPackageRoot: HELPER_ROOT,
      piPackageRoot: f.sdkRoot, dataRoot: f.root, version: '2.21.31',
      gitSource: f.gitSource, expectedCommit: f.commit,
      log: line => {
        if (replaced || !line.includes('install stdout 尾部')) return;
        const parent = path.join(f.root, 'agent', 'runtime-packages');
        const acquired = path.join(parent, fs.readdirSync(parent).find(name => name.startsWith('.acquire-'))!);
        const from = kind === 'root' ? acquired : kind === 'git'
          ? path.join(acquired, 'git') : path.join(acquired, 'git', 'github.com', 'runrunrain', 'amagi-pi');
        const outside = path.join(f.root, 'outside-acquisition');
        fs.renameSync(from, outside);
        fs.symlinkSync(outside, from, 'dir');
        replaced = true;
      },
    });
    await expect(promise).rejects.toMatchObject({ code: 'amagi_acquisition_incomplete' });
    expect(replaced).toBe(true);
    expect(fs.existsSync(path.join(amagiInstallDir(f.root, '2.21.31'), INSTALL_RECORD_FILENAME))).toBe(false);
  });

  it('git 前缀相近目录不是正式 git/ 布局', async ctx => {
    needsGit(ctx);
    const f = await makeFixture();
    const manager = path.join(f.sdkRoot, 'dist', 'core', 'package-manager.js');
    fs.writeFileSync(manager, fs.readFileSync(manager, 'utf8').replace("path.join(this.agentDir, 'git',", "path.join(this.agentDir, 'git-extra',"));
    let renamed = false;
    await expect(installAmagiFromGit({
      nodePath: process.execPath, piCliPath: f.cli.cliPath, helperPackageRoot: HELPER_ROOT,
      piPackageRoot: f.sdkRoot, dataRoot: f.root, version: '2.21.31',
      gitSource: f.gitSource, expectedCommit: f.commit,
      log: line => {
        if (renamed || !line.includes('install stdout 尾部')) return;
        const parent = path.join(f.root, 'agent', 'runtime-packages');
        const acquired = path.join(parent, fs.readdirSync(parent).find(name => name.startsWith('.acquire-'))!);
        fs.renameSync(path.join(acquired, 'git'), path.join(acquired, 'git-extra'));
        renamed = true;
      },
    })).rejects.toMatchObject({ code: 'amagi_acquisition_incomplete' });
    expect(renamed).toBe(true);
  });

  it('成功：获取→依赖冻结→正式 pi local install；溯源/哈希/布局齐全；临时获取目录清理', async (ctx) => {
    needsGit(ctx);
    const f = await makeFixture();
    const result = await installVia(f);
    expect(result.fresh).toBe(true);
    expect(result.version).toBe('2.21.31');
    expect(result.record.layout).toBe('source');
    expect(result.record.dependenciesIncluded).toBe(true);
    // 溯源：真实 git spec + commit + SDK 解析路径 + 获取命令
    expect(result.record.acquisition).toMatchObject({
      via: 'pi-git-install', gitSource: f.gitSource, commit: f.commit, repoUrl: 'https://github.com/runrunrain/amagi-pi.git',
    });
    expect(result.record.acquisition?.piInstallArgs).toEqual([f.cli.cliPath, 'install', f.gitSource]);
    expect(result.record.acquisition?.acquiredPackageRoot).toContain(path.join('.acquire-'));
    // 最终登记命令 = 正式 pi install <绝对物化包路径>
    expect(result.record.installedVia.piInstallArgs).toEqual([f.cli.cliPath, 'install', result.packageRoot]);
    // 依赖冻结：node_modules 保留；.bin 物化为转发 launcher（非 symlink、可执行、相对目标）
    const bin = path.join(result.packageRoot, 'node_modules', '.bin', 'typescript-language-server');
    expect(fs.existsSync(bin)).toBe(true);
    expect(fs.lstatSync(bin).isSymbolicLink()).toBe(false);
    expect(fs.statSync(bin).mode & 0o111).not.toBe(0);
    const shim = fs.readFileSync(bin, 'utf-8');
    expect(shim.startsWith('#!/bin/sh')).toBe(true);
    expect(shim).toContain('exec "$(dirname "$0")/../typescript-language-server/lib/cli.mjs" "$@"');
    // 相对目标：不残留获取临时目录绝对路径（随冻结包移动仍成立）
    expect(shim).not.toContain('.acquire-');
    expect(shim.split('\n')).toHaveLength(3); // shebang + exec 一行 + 空行——无绝对路径可藏
    expect(fs.existsSync(path.join(result.packageRoot, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'))).toBe(true);
    // 真实执行（获取临时目录已清理）：CLI 以目标原位置运行，相对 package.json 定位不漂移
    const executed = await runCli(bin, ['--version']);
    expect(executed.stdout.trim()).toBe('fixture-lsp/6.0.0');
    // .git 不进冻结包
    expect(fs.existsSync(path.join(result.packageRoot, '.git'))).toBe(false);
    // settings.json 包声明（相对路径归一）
    const settings = JSON.parse(fs.readFileSync(path.join(result.installDir, 'settings.json'), 'utf-8'));
    expect(settings.packages).toEqual(['package']);
    // 获取临时目录清理
    const residue = fs.readdirSync(path.join(f.root, 'agent', 'runtime-packages')).filter((name) => name.startsWith('.acquire-'));
    expect(residue).toEqual([]);
    // 记录不含密钥面
    const recordText = fs.readFileSync(path.join(result.installDir, INSTALL_RECORD_FILENAME), 'utf-8');
    expect(recordText).not.toMatch(/ZHIPU|TOKEN|SECRET/i);
    // 完整校验通过
    expect(verifyAmagiPackage({ dataRoot: f.root, version: '2.21.31' }).contentHash).toBe(result.contentHash);
  });

  it('默认链绝不出现 npm: 参数（两次 pi 调用=git 获取+local 登记）', async (ctx) => {
    needsGit(ctx);
    const f = await makeFixture();
    await installVia(f);
    const calls = f.cli.log();
    expect(calls).toHaveLength(2);
    expect(calls[0].source.startsWith('git:')).toBe(true);
    expect(path.isAbsolute(calls[1].source)).toBe(true);
    expect(calls.every((call) => !call.source.includes('npm:'))).toBe(true);
  });

  it('获取环境：凭据剔除、PI_OFFLINE 解除（安装需联网）、专用获取 home', async (ctx) => {
    needsGit(ctx);
    const f = await makeFixture();
    process.env.ZHIPU_API_KEY = 'sk-test-secret';
    process.env.PI_OFFLINE = '1';
    try {
      await installVia(f);
    } finally {
      delete process.env.ZHIPU_API_KEY;
      delete process.env.PI_OFFLINE;
    }
    const calls = f.cli.log();
    expect(calls[0].env.ZHIPU_API_KEY).toBeNull();
    expect(calls[0].env.PI_OFFLINE).toBeNull();
  });

  it('Git 结果版本 ≠ pin（如全局 36）→ 拒绝；不落最终目录、无临时残留', async (ctx) => {
    needsGit(ctx);
    const f = await makeFixture('2.21.36');
    try {
      await installVia(f);
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_version_mismatch');
      expect((error as Error).message).toContain('不影响构建');
    }
    expect(fs.existsSync(amagiInstallDir(f.root, '2.21.31'))).toBe(false);
    const residue = fs.readdirSync(path.join(f.root, 'agent', 'runtime-packages')).filter((name) => name.startsWith('.acquire-'));
    expect(residue).toEqual([]);
  });

  it('pi install 失败（如 git/网络不可用）→ 可操作错误，不残留', async (ctx) => {
    needsGit(ctx);
    const f = await makeFixture();
    const badCli = path.join(f.root, 'bad-pi.mjs');
    fs.writeFileSync(badCli, '#!/usr/bin/env node\nconsole.error("fatal: could not read from remote repository");\nprocess.exit(128);\n', { mode: 0o755 });
    try {
      await installAmagiFromGit({
        nodePath: process.execPath, piCliPath: badCli,
        helperPackageRoot: HELPER_ROOT,
        piPackageRoot: f.sdkRoot, dataRoot: f.root, version: '2.21.31',
        gitSource: f.gitSource, expectedCommit: f.commit,
      });
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_acquisition_failed');
      expect((error as Error).message).toContain('本地 amagi-pi 目录');
    }
    expect(fs.existsSync(amagiInstallDir(f.root, '2.21.31'))).toBe(false);
  });

  it('SDK 未解析到获取实体（settings 声明缺失）→ amagi_acquisition_incomplete', async (ctx) => {
    needsGit(ctx);
    const f = await makeFixture();
    // 变体 CLI：git 落盘但不写 settings.json（SDK list 找不到声明→实体解析失败）
    const silent = path.join(f.root, 'silent-pi.mjs');
    fs.writeFileSync(silent, `#!/usr/bin/env node
const fs = await import('node:fs'); const path = await import('node:path');
const [, , cmd, source] = process.argv;
if (cmd === 'install' && source.startsWith('git:')) {
  const spec = source.slice(4); const repoPath = spec.slice(0, spec.lastIndexOf('@'));
  const target = path.join(process.env.PI_CODING_AGENT_DIR, 'git', ...repoPath.split('/'));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'amagi-pi', version: '2.21.31' }));
  // 故意不写 settings.json
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
    try {
      await installAmagiFromGit({
        nodePath: process.execPath, piCliPath: silent,
        helperPackageRoot: HELPER_ROOT,
        piPackageRoot: f.sdkRoot, dataRoot: f.root, version: '2.21.31',
        gitSource: f.gitSource, expectedCommit: f.commit,
      });
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_acquisition_incomplete');
    }
  });

  it('HEAD commit 与期望不符 → amagi_acquisition_commit_mismatch', async (ctx) => {
    needsGit(ctx);
    const f = await makeFixture();
    const other = f.commit.split('').reverse().join('').slice(0, 40).replace(/[^0-9a-f]/g, '0').padEnd(40, '0');
    try {
      await installAmagiFromGit({
        nodePath: process.execPath, piCliPath: f.cli.cliPath,
        helperPackageRoot: HELPER_ROOT,
        piPackageRoot: f.sdkRoot, dataRoot: f.root, version: '2.21.31',
        gitSource: `git:github.com/runrunrain/amagi-pi@${f.commit}`,
        expectedCommit: other,
      });
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_acquisition_commit_mismatch');
    }
  });

  it('.bin shim 指向包外 → 拒绝物化（不留可变入口）', async (ctx) => {
    needsGit(ctx);
    const outside = tmpRoot();
    const outsideFile = path.join(outside, 'evil-server.mjs');
    fs.writeFileSync(outsideFile, '#!/usr/bin/env node\n');
    const f = await makeFixture('2.21.31', { binSymlinkOutside: outsideFile });
    try {
      await installVia(f);
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_symlink_in_source');
    }
    expect(fs.existsSync(amagiInstallDir(f.root, '2.21.31'))).toBe(false);
  });

  it('路径含空格/引号/$ 的冻结包：shim 安全引号，执行仍正确（负对照：不注入不漂移）', async (ctx) => {
    needsGit(ctx);
    // 新临时 root + 敌意目录名（空格、双引号、反引号、$ 变量名——未转义即注入/断链）
    const hostile = tmpRoot();
    const weird = path.join(hostile, 'weird dir "q" $HOME `x`');
    fs.mkdirSync(weird, { recursive: true });
    const template = makeGitFixtureRepo(weird, { version: '2.21.31' });
    const sdkRoot = makeFakePiSdk(hostile);
    const cli = makeFakePiCli(hostile, template);
    const result = await installAmagiFromGit({
      nodePath: process.execPath, piCliPath: cli.cliPath, helperPackageRoot: HELPER_ROOT,
      piPackageRoot: sdkRoot, dataRoot: hostile, version: '2.21.31',
      gitSource: `git:github.com/runrunrain/amagi-pi@${template.commit}`, expectedCommit: template.commit,
    });
    // shim 引用相对目标；执行不经 $HOME 展开/引号断裂（目标真实跑在原位置）
    const bin = path.join(result.packageRoot, 'node_modules', '.bin', 'typescript-language-server');
    const shim = fs.readFileSync(bin, 'utf-8');
    expect(shim).not.toContain(hostile);
    expect(shim).not.toContain('/Users/');
    const executed = await runCli(bin, ['--version']);
    expect(executed.stdout.trim()).toBe('fixture-lsp/6.0.0');
  });

  it('source 模式直装（includeDependencies）同样生成可执行转发 shim（非 git 链专属）', async (ctx) => {
    needsGit(ctx);
    const f = await makeFixture();
    const template2 = makeGitFixtureRepo(f.root, { version: '2.21.31' });
    const { installAmagiPackage } = await import('../src/agent/build-runtime/amagi-package.js');
    const result = await installAmagiPackage({
      nodePath: process.execPath, piCliPath: f.cli.cliPath, dataRoot: f.root,
      version: '2.21.31', sourceDir: template2.repoDir, includeDependencies: true,
    });
    const bin = path.join(result.packageRoot, 'node_modules', '.bin', 'typescript-language-server');
    expect(fs.lstatSync(bin).isSymbolicLink()).toBe(false);
    const executed = await runCli(bin, ['--version']);
    expect(executed.stdout.trim()).toBe('fixture-lsp/6.0.0');
  });

  it('幂等：二次安装 fresh=false 完整校验复用；篡改后 amagi_content_drift 不覆盖', async (ctx) => {
    needsGit(ctx);
    const f = await makeFixture();
    const first = await installVia(f);
    const second = await installVia(f);
    expect(second.fresh).toBe(false);
    expect(second.contentHash).toBe(first.contentHash);
    fs.appendFileSync(path.join(second.packageRoot, 'extensions', 'amagi-core', 'index.ts'), '// tampered\n');
    try {
      await installVia(f);
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_content_drift');
    }
    expect(fs.readFileSync(path.join(second.packageRoot, 'extensions', 'amagi-core', 'index.ts'), 'utf-8')).toContain('tampered');
  });
});

// ---------------------------------------------------------------------------
// BuildRuntimeHost：默认安装/并发/状态诚实性
// ---------------------------------------------------------------------------

function fixtureHost(root: string, sdkRoot: string, cliPath: string, options: { failRuntime?: boolean } = {}): { host: BuildRuntimeHost; manager: ConfigManager } {
  const manager = new ConfigManager(path.join(root, 'config.json'));
  const resolver = new PiRuntimeResolver();
  if (options.failRuntime) {
    vi.spyOn(resolver, 'resolveRuntime').mockRejectedValue(new Error('Pi 运行时未就绪'));
  } else {
    vi.spyOn(resolver, 'resolveRuntime').mockResolvedValue({
      nodePath: process.execPath, nodeVersion: 'v24.0.0', piPackageRoot: sdkRoot,
      piCliPath: cliPath, piVersion: '1.4.0', claudeCliPath: null,
    } as never);
  }
  const host = new BuildRuntimeHost({
    dataRoot: root,
    resolver,
    toolService: null as never,
    pool: null as never,
    configProvider: () => manager.getConfig(),
    internalBaseUrl: () => '',
    knowledgeBaseRoot: () => '',
    outputRoot: () => '',
  });
  return { host, manager };
}

describe('BuildRuntimeHost 安装门（默认 Git / busy / 状态诚实）', () => {
  it('并发安装 → 后来者 409 amagi_install_busy（同版本串行）', async (ctx) => {
    needsGit(ctx);
    const f = await makeFixture();
    // 慢 CLI：local 登记前延时 1.5s，制造在飞窗口（busy 门与安装方式无关）
    const slow = path.join(f.root, 'slow-pi.mjs');
    fs.writeFileSync(slow, `#!/usr/bin/env node
const fs = await import('node:fs'); const path = await import('node:path');
const [, , cmd, source] = process.argv;
if (cmd === 'install' && path.isAbsolute(source) && fs.existsSync(source)) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const rel = path.relative(process.env.PI_CODING_AGENT_DIR, source) || '.';
  fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ packages: [rel] }, null, 2));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
    const { host, manager } = fixtureHost(f.root, f.sdkRoot, slow);
    await manager.load();
    const sourceDir = makeMiniSource(f.root);
    const first = host.installAmagi({ sourceDir });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      await host.installAmagi({ sourceDir });
      expect.unreachable('应 409');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_install_busy');
      expect((error as { status?: number }).status).toBe(409);
    }
    const done = await first;
    expect(done.version).toBe('2.21.31');
  });

  it('statusDto：运行时不可用仍如实报已装事实（installed 不被探测失败抹掉）', async (ctx) => {
    needsGit(ctx);
    const f = await makeFixture();
    // 先经 fixture 获取链装好（host 默认链要求官方 commit，fixture 无法伪造——
    // 官方默认链的真实安装由 build-runtime-amagi-live.test.ts 覆盖）
    const installed = await installVia(f);
    expect(installed.version).toBe('2.21.31');
    const { manager } = fixtureHost(f.root, f.sdkRoot, f.cli.cliPath);
    await manager.load();
    // 换一个解析失败的 host（同一 dataRoot：安装事实仍在）
    const failHostFixture = fixtureHost(f.root, f.sdkRoot, f.cli.cliPath, { failRuntime: true });
    await failHostFixture.manager.load();
    const dto = await failHostFixture.host.statusDto();
    expect(dto.runtime).toBeNull();
    expect(dto.error).toContain('Pi 运行时');
    expect(dto.amagi?.installed).toBe(true);
    expect(dto.amagi?.installState).toBe('installed');
    expect(dto.amagi?.version).toBe('2.21.31');
    expect(dto.amagi?.pinnedVersion).toBe('2.21.31');
    expect(dto.amagi?.gitSource).toBe(`git:github.com/runrunrain/amagi-pi@${AMAGI_PI_GIT_COMMIT}`);
    expect(dto.amagi?.commit).toBe(AMAGI_PI_GIT_COMMIT);
    // 发现不可用 ≠ 未安装（两处 home 单独表达）
    expect(dto.amagi?.discoveryIssues).toHaveLength(2);
    expect(dto.amagi?.discoveryIssues.every((issue) => issue.status === 'unavailable')).toBe(true);
    expect(dto.amagi?.candidates).toEqual([]);
  });

  it('已配置的较新本地版会在新构建探测时自动冻结，旧回退版不被覆盖', async (ctx) => {
    needsGit(ctx);
    const f = await makeFixture();
    // 假全局 home：settings 声明本地 amagi-pi 2.21.36（manifest 落盘）
    const globalHome = path.join(f.root, 'fake-global-pi-home');
    const globalPkg = path.join(f.root, 'user-amagi-2.21.36');
    fs.mkdirSync(globalPkg, { recursive: true });
    fs.writeFileSync(path.join(globalPkg, 'package.json'), JSON.stringify({ name: 'amagi-pi', version: '2.21.36' }));
    fs.mkdirSync(path.join(globalPkg, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(globalPkg, 'agents', 'luban.md'), '# luban\n');
    fs.mkdirSync(path.join(globalPkg, 'extensions', 'amagi-core'), { recursive: true });
    fs.writeFileSync(path.join(globalPkg, 'extensions', 'amagi-core', 'index.ts'), 'export default () => {};\n');
    fs.mkdirSync(path.join(globalPkg, 'agent-outputs'), { recursive: true });
    fs.symlinkSync(f.root, path.join(globalPkg, 'agent-outputs', 'transient-link'), 'dir');
    fs.mkdirSync(globalHome, { recursive: true });
    fs.writeFileSync(path.join(globalHome, 'settings.json'), JSON.stringify({ packages: [globalPkg] }));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalHome;
    try {
      const { host, manager } = fixtureHost(f.root, f.sdkRoot, f.cli.cliPath);
      await manager.load();
      const dto = await host.statusDto();
      const globalCandidates = dto.amagi?.candidates.filter((item) => item.origin === 'global-pi-home') ?? [];
      expect(globalCandidates).toHaveLength(1);
      expect(globalCandidates[0]).toMatchObject({ version: '2.21.36', matchesPin: false, sourceType: 'local', packagePath: globalPkg });
      expect(dto.amagi).toMatchObject({ pinnedVersion: '2.21.36', selectedSource: globalPkg, installed: false });
      const probed = await (host as unknown as { probeOrFail: (key: string) => Promise<{ amagiPackage: { version: string; packageRoot: string } }> }).probeOrFail('fixture-key');
      expect(probed.amagiPackage.version).toBe('2.21.36');
      expect(probed.amagiPackage.packageRoot).toContain('amagi-pi@2.21.36');
      expect(fs.existsSync(path.join(probed.amagiPackage.packageRoot, 'agent-outputs'))).toBe(false);
      expect(fs.existsSync(path.join(f.root, 'agent', 'runtime-packages', 'amagi-pi@2.21.31'))).toBe(false);
      expect((await host.statusDto()).amagi).toMatchObject({ pinnedVersion: '2.21.36', installed: true, version: '2.21.36' });
      // 同一应用进程内更新已配置插件 manifest：下次新构建自动采用新版本，
      // 已冻结的旧版本仍可供会话恢复。
      fs.writeFileSync(path.join(globalPkg, 'package.json'), JSON.stringify({ name: 'amagi-pi', version: '2.21.37' }));
      expect((await host.statusDto()).amagi).toMatchObject({ pinnedVersion: '2.21.37', selectedSource: globalPkg, installed: false });
      const upgraded = await (host as unknown as { probeOrFail: (key: string) => Promise<{ amagiPackage: { version: string } }> }).probeOrFail('fixture-key');
      expect(upgraded.amagiPackage.version).toBe('2.21.37');
      expect(fs.existsSync(path.join(f.root, 'agent', 'runtime-packages', 'amagi-pi@2.21.36'))).toBe(true);
      await host.installAmagi({ sourceDir: makeMiniSource(f.root) });
      const resumed = await (host as unknown as { probeOrFail: (key: string, version: string) => Promise<{ amagiPackage: { version: string } }> }).probeOrFail('fixture-key', '2.21.31');
      expect(resumed.amagiPackage.version).toBe('2.21.31');
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });
});
