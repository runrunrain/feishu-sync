import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeExecutable } from '../modules/runtime-executable.js';

export const CLI_SKILL_TARGETS = ['agents', 'claude', 'codex'] as const;
export type CliSkillTarget = typeof CLI_SKILL_TARGETS[number];
type State = 'not_installed' | 'installed' | 'needs_update' | 'conflict' | 'invalid';
type Status = { path: string; state: State; message?: string };
type File = { path: string; body?: string; mark: (hash: string) => string; legacy?: string; legacyShape?: RegExp; mode?: number };
type Default = 'shim' | 'agents';

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(moduleRoot, '../../dist/cli');
const asset = (...parts: string[]) => {
  const local = path.join(moduleRoot, ...parts);
  return fs.existsSync(local) ? local : path.join(distRoot, ...parts);
};
const sha = (body: string) => createHash('sha256').update(body).digest('hex');
const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';
const message = (err: unknown) => err instanceof Error ? err.message : String(err);

export class CliInstallError extends Error {}

function atomicWrite(file: string, text: string, mode = 0o600): void {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, text, { flag: 'wx', mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

function inspect(file: File): Status {
  try {
    const stat = fs.lstatSync(file.path);
    if (!stat.isFile() || stat.size > 64 * 1024) return { path: file.path, state: 'conflict' };
    const text = fs.readFileSync(file.path, 'utf8');
    const start = text.lastIndexOf('\n', text.length - 2) + 1;
    const tail = text.slice(start);
    const digest = sha(text.slice(0, start));
    const managed = tail === file.mark(digest);
    // 旧版应用写出的无哈希 shim：只要与应用生成的整体结构逐行吻合（路径可因 Node/Electron、
    // 开发/打包位置不同而不同）就视为可管理的旧版文件，状态 needs_update，允许升级或清理；
    // 任何多余/改动的行都不匹配，仍按外部修改保留（conflict）。
    const legacy = text === file.legacy || (file.legacyShape?.test(text) ?? false);
    if (!managed && !legacy) return { path: file.path, state: 'conflict' };
    return { path: file.path, state: file.body === undefined || text === file.body + file.mark(sha(file.body))
      ? 'installed' : 'needs_update' };
  } catch (err) {
    if (missing(err)) return { path: file.path, state: 'not_installed' };
    throw err;
  }
}

function assertManageable(status: Status): void {
  if (status.state === 'conflict') throw new CliInstallError('检测到同名文件或外部修改，已保留：' + status.path);
}

/** Only traverse ordinary directories below a trusted, resolved root. */
function checkDirectory(root: string, segments: string[], create: boolean): void {
  if (!fs.statSync(root).isDirectory()) throw new CliInstallError('安装根目录不可用：' + root);
  let dir = root;
  for (const segment of segments) {
    dir = path.join(dir, segment);
    try {
      if (!fs.lstatSync(dir).isDirectory()) throw new CliInstallError('安装路径包含链接或非目录项：' + dir);
    } catch (err) {
      if (!missing(err)) throw err;
      if (!create) return;
      fs.mkdirSync(dir);
    }
  }
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export class CliLocalInstaller {
  readonly cliScript = asset('feishu-sync-cli.cjs');
  readonly skillSource = asset('skills', 'feishu-sync', 'SKILL.md');
  readonly command = runtimeExecutable();
  readonly env: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  private readonly home: string;
  private readonly dataRoot: string;

  constructor(dataRoot: string, homeDir = os.homedir()) {
    this.home = path.resolve(homeDir);
    this.dataRoot = path.resolve(dataRoot);
  }

  get binDir() { return path.join(this.dataRoot, 'bin'); }
  get shimPath() { return path.join(this.binDir, 'feishu-sync'); }
  get cmdPath() { return this.shimPath + '.cmd'; }
  get nativeShimPath() { return process.platform === 'win32' ? this.cmdPath : this.shimPath; }
  get cliAvailable() { return fs.existsSync(this.cliScript); }
  get skillAvailable() { return fs.existsSync(this.skillSource); }
  get pathHint() { return '将 ' + this.binDir + ' 加入 PATH，或直接使用上面的完整路径运行 feishu-sync。'; }

  private shimFiles(): File[] {
    const electron = Boolean(this.env.ELECTRON_RUN_AS_NODE);
    const q = shellQuote;
    const sh = ['#!/bin/sh',
      '# feishu-sync CLI shim —— 由 feishu-sync 应用生成；重新生成请使用应用设置。',
      '# 用法示例：feishu-sync status --json',
      'export FEISHU_SYNC_HOME=' + q(this.dataRoot),
      ...(electron ? ['export ELECTRON_RUN_AS_NODE=1'] : []),
      'exec ' + q(this.command) + ' ' + q(this.cliScript) + ' "$@"', ''].join('\n');
    const batch = (managed: boolean) => {
      const escape = (value: string) => managed ? value.replaceAll('%', '%%') : value;
      return [
        '@echo off',
        'rem feishu-sync CLI shim - generated by feishu-sync app',
        ...(managed ? ['setlocal DisableDelayedExpansion'] : []),
        'set "FEISHU_SYNC_HOME=' + escape(this.dataRoot) + '"',
        ...(electron ? ['set "ELECTRON_RUN_AS_NODE=1"'] : []),
        '"' + escape(this.command) + '" "' + escape(this.cliScript) + '" %*',
        'exit /b %ERRORLEVEL%', '',
      ].join('\r\n');
    };
    // 旧版 shim 的结构形状：路径与 Electron 开关随生成环境变化，但每个词必须是 shellQuote 产出的
    // 完整单引号词，整体逐行吻合；多余/改动的行不匹配，仍按外部修改保留。
    const sq = String.raw`'(?:[^'\n]|'\\'')*'`;
    const cliWord = String.raw`'(?:[^'\n]|'\\'')*feishu-sync-cli\.cjs'`;
    const shLegacyShape = new RegExp('^#!/bin/sh\n# feishu-sync CLI shim —— 由 feishu-sync 应用生成；重新生成请使用应用设置。\n'
      + '# 用法示例：feishu-sync status --json\nexport FEISHU_SYNC_HOME=' + sq + '\n'
      + '(?:export ELECTRON_RUN_AS_NODE=1\n)?exec ' + sq + ' ' + cliWord + ' "\\$@"\n$');
    const cmdLegacyShape = /^@echo off\r\nrem feishu-sync CLI shim - generated by feishu-sync app\r\n(?:setlocal DisableDelayedExpansion\r\n)?set "FEISHU_SYNC_HOME=[^"\r\n]*"\r\n(?:set "ELECTRON_RUN_AS_NODE=1"\r\n)?"[^"\r\n]*" "[^"\r\n]*feishu-sync-cli\.cjs" %\*\r\nexit \/b %ERRORLEVEL%\r\n$/;
    return [
      { path: this.shimPath, body: sh, legacy: sh, legacyShape: shLegacyShape, mode: 0o755, mark: hash => '# feishu-sync managed sha256:' + hash + '\n' },
      { path: this.cmdPath, body: batch(true), legacy: batch(false), legacyShape: cmdLegacyShape,
        mark: hash => 'rem feishu-sync managed sha256:' + hash + '\r\n' },
    ];
  }

  private skillLocation(target: CliSkillTarget) {
    const base = target === 'agents' ? '.agents' : target === 'claude' ? '.claude' : '.codex';
    const segments = [base, 'skills', 'feishu-sync'];
    return { segments, file: path.join(this.home, ...segments, 'SKILL.md') };
  }

  private skillFile(file: string): File {
    const body = this.skillAvailable ? fs.readFileSync(this.skillSource, 'utf8').replace(/\r\n/g, '\n')
      .trimEnd().replace('{{FEISHU_SYNC_SHIM}}', () => JSON.stringify(this.nativeShimPath)) + '\n\n' : undefined;
    return { path: file, body, mark: hash => '<!-- feishu-sync managed sha256:' + hash + ' -->\n' };
  }

  private preferences(): Partial<Record<Default, false>> {
    const file = path.join(this.dataRoot, 'cli-local-install.json');
    try {
      if (!fs.lstatSync(file).isFile()) throw new CliInstallError('CLI 安装偏好文件不可用。');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliInstallError('CLI 安装偏好格式无效。');
      return { ...(value.shim === false ? { shim: false } : {}), ...(value.agents === false ? { agents: false } : {}) };
    } catch (err) {
      if (missing(err)) return {};
      throw err;
    }
  }

  private setDefault(target: Default, enabled: boolean): void {
    const preferences = this.preferences();
    if (enabled ? preferences[target] === undefined : preferences[target] === false) return;
    if (enabled) delete preferences[target];
    else preferences[target] = false;
    atomicWrite(path.join(this.dataRoot, 'cli-local-install.json'), JSON.stringify(preferences) + '\n');
  }

  installDefaults(onError: (error: unknown) => void): void {
    let preferences: ReturnType<CliLocalInstaller['preferences']>;
    try { preferences = this.preferences(); } catch (error) { onError(error); return; }
    if (preferences.shim !== false && this.cliAvailable) {
      try { this.installShim(); } catch (error) { onError(error); }
    }
    if (preferences.agents !== false && this.skillAvailable) {
      try { this.installSkill('agents'); } catch (error) { onError(error); }
    }
  }

  shimStatus(): Status {
    const result: Status = { path: this.nativeShimPath, state: 'not_installed' };
    try {
      checkDirectory(this.dataRoot, ['bin'], false);
      const statuses = this.shimFiles().map(inspect);
      if (statuses.some(status => status.state === 'conflict')) return { ...result, state: 'conflict' };
      if (statuses.every(status => status.state === 'installed')) return { ...result, state: 'installed' };
      if (statuses.some(status => status.state !== 'not_installed')) return { ...result, state: 'needs_update' };
      return result;
    } catch (err) { return { ...result, state: 'invalid', message: message(err) }; }
  }

  installShim(): void {
    if (!this.cliAvailable) throw new CliInstallError('CLI 打包产物不存在，请更新应用版本。');
    checkDirectory(this.dataRoot, ['bin'], true);
    const files = this.shimFiles();
    const statuses = files.map(inspect);
    statuses.forEach(assertManageable);
    files.forEach((file, index) => {
      if (statuses[index].state !== 'installed') atomicWrite(file.path, file.body! + file.mark(sha(file.body!)), file.mode);
    });
    this.setDefault('shim', true);
  }

  removeShim(): void {
    checkDirectory(this.dataRoot, ['bin'], false);
    const statuses = this.shimFiles().map(inspect);
    statuses.forEach(assertManageable);
    this.setDefault('shim', false);
    for (const status of statuses) if (status.state !== 'not_installed') fs.unlinkSync(status.path);
  }

  skillStatus(target: CliSkillTarget): Status & { target: CliSkillTarget } {
    const { segments, file } = this.skillLocation(target);
    try {
      checkDirectory(this.home, segments, false);
      return { target, ...inspect(this.skillFile(file)) };
    } catch (err) { return { target, path: file, state: 'invalid', message: message(err) }; }
  }

  installSkill(target: CliSkillTarget): void {
    const { segments, file } = this.skillLocation(target);
    const entry = this.skillFile(file);
    if (entry.body === undefined) throw new CliInstallError('内置 Skill 文件缺失，请更新应用版本。');
    checkDirectory(this.home, segments, true);
    const status = inspect(entry);
    assertManageable(status);
    if (status.state !== 'installed') atomicWrite(file, entry.body + entry.mark(sha(entry.body)), 0o644);
    if (target === 'agents') this.setDefault('agents', true);
  }

  removeSkill(target: CliSkillTarget): void {
    const { segments, file } = this.skillLocation(target);
    checkDirectory(this.home, segments, false);
    const status = inspect(this.skillFile(file));
    assertManageable(status);
    if (target === 'agents') this.setDefault('agents', false);
    if (status.state === 'not_installed') return;
    fs.unlinkSync(file);
    try { fs.rmdirSync(path.dirname(file)); }
    catch (err) { if (!missing(err) && (err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw err; }
  }
}
