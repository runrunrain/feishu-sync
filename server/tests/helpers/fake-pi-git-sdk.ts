/**
 * fake-pi-git-sdk — amagi Git 获取链/发现链单测 fixtures。
 *
 * 组成：
 * - makeFakePiSdk：最小 Pi SDK 桩（dist/core/settings-manager.js + package-manager.js）。
 *   只实现被消费的契约（SettingsManager.create 读取 settings、listConfiguredPackages
 *   只读清单）；resolve() 显式抛错——list 模式绝不允许触发（只读护栏的正控锚点）。
 * - makeGitFixtureRepo：真实 git 仓库模板（固定提交），manifest/node_modules/.bin
 *   symlink 结构对齐 pi git install 的真实落盘（实测：pi 对 amagi-pi 落
 *   node_modules/typescript-language-server + .bin symlink）。
 * - makeFakePiCli：模拟 `pi install`：git 源 → 复制模板仓库 + 写 settings.json；
 *   local 绝对路径 → 写 settings.json（相对路径归一，对齐真实 pi）；所有调用
 *   记入日志文件供断言（如「默认链不出现 npm: 参数」）。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** git 是否可用（模板仓库与 HEAD 复核都依赖真实 git）。 */
export function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** 最小 Pi SDK 桩（ESM）。resolve() 抛错=只读护栏正控。 */
export function makeFakePiSdk(root: string, options: { resolveThrows?: boolean } = {}): string {
  const sdkRoot = path.join(root, `fake-pi-sdk-${crypto.randomBytes(3).toString('hex')}`);
  const core = path.join(sdkRoot, 'dist', 'core');
  fs.mkdirSync(core, { recursive: true });
  fs.writeFileSync(path.join(core, 'settings-manager.js'), `
import fs from 'node:fs';
import path from 'node:path';
export class SettingsManager {
  constructor(errors, globalSettings) { this.errors = errors; this.globalSettings = globalSettings; }
  static create(cwd, agentDir) {
    const errors = [];
    let globalSettings = {};
    const file = path.join(agentDir, 'settings.json');
    try {
      if (fs.existsSync(file)) globalSettings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push({ scope: 'global', path: file, error });
    }
    return new SettingsManager(errors, globalSettings);
  }
  getGlobalSettings() { return this.globalSettings; }
  getProjectSettings() { return {}; }
}
`);
  fs.writeFileSync(path.join(core, 'package-manager.js'), `
import fs from 'node:fs';
import path from 'node:path';
export class DefaultPackageManager {
  constructor(opts) { this.agentDir = opts.agentDir; this.settingsManager = opts.settingsManager; }
  // 只读清单：真实 SDK 此方法只读 settings + existsSync；不安装、不写盘。
  listConfiguredPackages() {
    const entries = this.settingsManager.getGlobalSettings().packages ?? [];
    return entries.map((pkg) => {
      const source = typeof pkg === 'string' ? pkg : pkg.source;
      const parsed = this.#parse(source);
      let installedPath;
      if (parsed?.npmPath && fs.existsSync(parsed.npmPath)) installedPath = parsed.npmPath;
      if (parsed?.gitPath && fs.existsSync(parsed.gitPath)) installedPath = parsed.gitPath;
      if (parsed?.type === 'local') {
        const resolved = path.isAbsolute(parsed.path) ? parsed.path : path.resolve(this.agentDir, parsed.path);
        if (fs.existsSync(resolved)) installedPath = resolved;
      }
      return { source, scope: 'user', filtered: typeof pkg === 'object', installedPath };
    });
  }
  #parse(source) {
    if (typeof source !== 'string') return undefined;
    if (source.startsWith('npm:')) {
      const name = source.slice(4).split('@')[0] || 'pkg';
      return { type: 'npm', npmPath: path.join(this.agentDir, 'npm', 'node_modules', name) };
    }
    if (source.startsWith('git:')) {
      const spec = source.slice(4);
      const at = spec.lastIndexOf('@');
      const repoPath = at >= 0 ? spec.slice(0, at) : spec;
      return { type: 'git', gitPath: path.join(this.agentDir, 'git', ...repoPath.split('/')) };
    }
    return { type: 'local', path: source };
  }
  ${options.resolveThrows === false ? '' : `async resolve() { throw new Error('RESOLVE_MUST_NOT_RUN_IN_LIST_MODE'); }`}
}
`);
  return sdkRoot;
}

export interface GitFixtureRepo {
  repoDir: string;
  commit: string;
}

/** 真实 git 仓库模板（结构对齐 pi git install 落盘；commit 读回供 expectedCommit）。 */
export function makeGitFixtureRepo(root: string, options: { version: string; binSymlinkOutside?: string }): GitFixtureRepo {
  const dir = path.join(root, `template-repo-${options.version}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'extensions', 'amagi-core'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'typescript-language-server', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'amagi-pi',
    version: options.version,
    description: 'fixture',
    type: 'module',
    pi: { extensions: ['./extensions'], skills: ['./skills'], prompts: ['./prompts'], themes: ['./themes'] },
    dependencies: { typescript: '^6.0.3', 'typescript-language-server': '6.0.0' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'extensions', 'amagi-core', 'index.ts'), '// fixture amagi-core\n');
  for (const agent of ['luban', 'diting', 'baize']) {
    fs.writeFileSync(path.join(dir, 'agents', `${agent}.md`), '---\ndescription: fixture\ntype: work\ntools: read\n---\n');
  }
  // 依赖包：CLI 从自身文件位置读 ../package.json（对齐真实 typescript-language-server
  // 的 findUp 定位语义）——字节拷贝到 .bin 时该查找落空，转发 shim 才能真正工作。
  const tlsDir = path.join(dir, 'node_modules', 'typescript-language-server');
  fs.mkdirSync(path.join(tlsDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tlsDir, 'package.json'), JSON.stringify({ name: 'typescript-language-server', version: '6.0.0' }, null, 2));
  const cli = path.join(tlsDir, 'lib', 'cli.mjs');
  fs.writeFileSync(cli, [
    '#!/usr/bin/env node',
    "import { readFileSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    "import path from 'node:path';",
    "// 从自身真实位置向上找最近的 package.json（真实 CLI 的 findUpSync 语义）",
    "const here = path.dirname(fileURLToPath(import.meta.url));",
    "const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));",
    "console.log(`fixture-lsp/${pkg.version}`);",
    '',
  ].join('\n'), { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync(path.join('..', 'typescript-language-server', 'lib', 'cli.mjs'), path.join(dir, 'node_modules', '.bin', 'typescript-language-server'));
  if (options.binSymlinkOutside) {
    fs.symlinkSync(options.binSymlinkOutside, path.join(dir, 'node_modules', '.bin', 'escaping-server'));
  }
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const git = (args: string[]): void => { execFileSync('git', args, { cwd: dir, env, windowsHide: true }); };
  git(['init', '--initial-branch=main']);
  git(['add', '-A']);
  git(['commit', '-m', 'fixture amagi-pi template', '--no-gpg-sign', '--no-verify']);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env, windowsHide: true }).toString().trim();
  return { repoDir: dir, commit };
}

export interface FakePiCli {
  cliPath: string;
  /** 全部调用记录（JSON 行：{cmd,source,env:{PI_OFFLINE,ZHIPU_API_KEY}}）。 */
  logPath: string;
  log(): Array<{ cmd: string; source: string; env: { PI_OFFLINE: string | null; ZHIPU_API_KEY: string | null } }>;
}

/** 模拟 pi install（git/local 两种落盘；调用全记录）。 */
export function makeFakePiCli(root: string, template: GitFixtureRepo): FakePiCli {
  const cliPath = path.join(root, `fake-pi-${crypto.randomBytes(3).toString('hex')}.mjs`);
  const logPath = path.join(root, 'fake-pi-calls.log');
  fs.writeFileSync(cliPath, `#!/usr/bin/env node
const [, , cmd, source] = process.argv;
const fs = await import('node:fs');
const path = await import('node:path');
const home = process.env.PI_CODING_AGENT_DIR;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ cmd, source, env: { PI_OFFLINE: process.env.PI_OFFLINE ?? null, ZHIPU_API_KEY: process.env.ZHIPU_API_KEY ?? null } }) + '\\n');
if (cmd === 'install' && typeof source === 'string' && source.startsWith('git:')) {
  const spec = source.slice(4);
  const at = spec.lastIndexOf('@');
  const repoPath = at >= 0 ? spec.slice(0, at) : spec;
  const target = path.join(home, 'git', ...repoPath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(${JSON.stringify(template.repoDir)}, target, { recursive: true });
  // node cpSync 会把 symlink 复制成指向源模板的绝对路径；真实 git clone 落盘
  // 的是仓库内相对链接——按模板的链接串重建（保持与真实 pi git install 一致）。
  const binDir = path.join(target, 'node_modules', '.bin');
  if (fs.existsSync(binDir)) {
    for (const name of fs.readdirSync(binDir)) {
      const link = path.join(binDir, name);
      if (!fs.lstatSync(link).isSymbolicLink()) continue;
      const tmpl = fs.readlinkSync(path.join(${JSON.stringify(template.repoDir)}, 'node_modules', '.bin', name));
      fs.rmSync(link); fs.symlinkSync(tmpl, link);
    }
  }
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ packages: [source] }, null, 2));
  console.log('fake-pi installed', source);
  process.exit(0);
}
if (cmd === 'install' && typeof source === 'string' && path.isAbsolute(source) && fs.existsSync(source)) {
  const rel = path.relative(home, source) || '.';
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ packages: [rel] }, null, 2));
  console.log('fake-pi installed local', source);
  process.exit(0);
}
console.error('fake-pi: unsupported', cmd, source);
process.exit(1);
`, { mode: 0o755 });
  return {
    cliPath,
    logPath,
    log(): Array<{ cmd: string; source: string; env: { PI_OFFLINE: string | null; ZHIPU_API_KEY: string | null } }> {
      if (!fs.existsSync(logPath)) return [];
      return fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

/** 迷你 source 模式目录（沿用 build-runtime-package.test 形状；依赖冻结用）。 */
export function makeMiniSource(root: string, version = '2.21.31'): string {
  const src = path.join(root, `amagi-src-${version}`);
  fs.mkdirSync(path.join(src, 'extensions', 'amagi-core'), { recursive: true });
  fs.mkdirSync(path.join(src, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'amagi-pi', version, pi: { extensions: ['./extensions'] } }, null, 2));
  fs.writeFileSync(path.join(src, 'extensions', 'amagi-core', 'index.ts'), '// mini\n');
  for (const agent of ['luban', 'diting', 'baize']) fs.writeFileSync(path.join(src, 'agents', `${agent}.md`), 'x\n');
  return src;
}
