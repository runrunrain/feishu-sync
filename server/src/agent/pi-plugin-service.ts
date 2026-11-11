/** Pi原生package管理，参考CodeBox：CLI安装/更新/移除，Pi SDK解析manifest与资源。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { atomicWriteFile, resolveInside, isPathInside } from './path-guard.js';
import { piWorkbenchPackageRoot } from './agent-assets.js';
import { buildPiProcessEnv } from './pi-rpc-process.js';
import { ToolError } from './agent-tool-service.js';
import type { PiRuntimeResolver } from './runtime-resolver.js';
import type { AgentConfig } from '../types/agent-knowledge.js';
import type { PiPackagePlugin, PiPluginsDto } from '../types/pi-plugin.js';
import { installBundledAmagi, readBundledAmagi, type BundledAmagi } from './bundled-amagi.js';
import { runtimePackagesRoot } from './build-runtime/amagi-package.js';

const run = promisify(execFile);
type Declaration = string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] };
const sourceOf = (entry: Declaration) => typeof entry === 'string' ? entry : entry.source;
const disabled = (entry: Declaration) => typeof entry === 'object' && ['extensions', 'skills', 'prompts', 'themes'].every((key) => Array.isArray(entry[key as keyof typeof entry]) && (entry[key as keyof typeof entry] as unknown[]).length === 0);

export class PiPluginService {
  readonly agentDir: string;
  readonly builtinRoot: string;
  private cache: PiPackagePlugin[] = [];
  private mutating = false;
  private revision = '';
  private generation = 0;
  private readonly bundle: BundledAmagi | null;
  private bundledReady = false;
  private bundlePending: Promise<void> | null = null;
  constructor(private deps: { dataRoot: string; resolver: PiRuntimeResolver; agentConfig: () => AgentConfig;
    running: () => boolean; retireIdle: () => Promise<void>; bundledAmagi?: BundledAmagi | null }) {
    this.bundle = deps.bundledAmagi === undefined ? readBundledAmagi() : deps.bundledAmagi;
    this.agentDir = resolveInside(deps.dataRoot, 'agent/pi-home', 'mkdir');
    this.builtinRoot = resolveInside(deps.dataRoot, 'agent/plugins/knowledge-workbench', 'mkdir');
    for (const name of ['package.json', 'feishu-sync-context.js']) {
      const bytes = fs.readFileSync(path.join(piWorkbenchPackageRoot(), name));
      const target = resolveInside(this.builtinRoot, name, 'write');
      if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) atomicWriteFile(target, bytes);
    }
    const settings = this.settings();
    if (!this.declarations(settings).some((entry) => path.resolve(this.agentDir, sourceOf(entry)) === this.builtinRoot)) {
      settings.packages = [...this.declarations(settings), this.builtinRoot]; this.saveSettings(settings);
    }
    this.cache = [this.describe(this.builtinRoot, this.builtinRoot, false, [])];
    this.updateRevision();
  }
  private isManagedAmagi(source: string): boolean {
    const full = path.resolve(this.agentDir, source);
    const rel = path.relative(runtimePackagesRoot(this.deps.dataRoot), full).split(path.sep).join('/');
    return /^amagi-pi@\d+\.\d+\.\d+\+[a-f0-9]{64}\/package$/.test(rel);
  }
  /** Idempotent first-launch provisioning; registration happens only after complete package verification. */
  async ensureBundled(): Promise<void> {
    if (!this.bundle || this.bundledReady) return;
    if (this.bundlePending) return this.bundlePending;
    this.bundlePending = (async () => {
      const runtime = await this.deps.resolver.resolveRuntime(this.deps.agentConfig());
      if (!runtime.nodePath || !runtime.piCliPath) return; // RuntimeInstaller completion retries this path.
      const installed = await installBundledAmagi({ dataRoot: this.deps.dataRoot, nodePath: runtime.nodePath,
        piCliPath: runtime.piCliPath, bundle: this.bundle!, log: (line) => console.info(line) });
      const settings = this.settings();
      const entries = this.declarations(settings);
      const previous = entries.find((entry) => this.isManagedAmagi(sourceOf(entry)));
      const next: Declaration = previous && typeof previous === 'object'
        ? { ...previous, source: installed.packageRoot } : installed.packageRoot;
      const packages = [...entries.filter((entry) => !this.isManagedAmagi(sourceOf(entry))), next];
      if (JSON.stringify(packages) !== JSON.stringify(entries)) {
        settings.packages = packages; this.saveSettings(settings);
        const filters = this.savedFilters();
        if (previous && filters[sourceOf(previous)]) {
          const restored = filters[sourceOf(previous)]; delete filters[sourceOf(previous)];
          filters[installed.packageRoot] = typeof restored === 'object' ? { ...restored, source: installed.packageRoot } : installed.packageRoot;
          this.saveFilters(filters);
        }
      }
      this.bundledReady = true;
    })().finally(() => { this.bundlePending = null; });
    return this.bundlePending;
  }
  private settings(): Record<string, unknown> {
    const target = resolveInside(this.agentDir, 'settings.json', 'write');
    if (!fs.existsSync(target)) return {};
    try {
      const data = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data) || (data.packages !== undefined && !Array.isArray(data.packages))) throw new Error('schema');
      return data;
    } catch { throw new ToolError('pi_settings_invalid', '应用Pi settings.json无效，请检查应用插件目录', 409); }
  }
  private saveSettings(settings: Record<string, unknown>) {
    atomicWriteFile(resolveInside(this.agentDir, 'settings.json', 'write'), JSON.stringify(settings, null, 2));
  }
  private savedFilters(): Record<string, Declaration> {
    const target = resolveInside(this.deps.dataRoot, 'agent/plugins/disabled-packages.json', 'write');
    if (!fs.existsSync(target)) return {};
    try {
      const value = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schema');
      return value;
    } catch { throw new ToolError('pi_settings_invalid', '插件停用前的资源筛选备份无效', 409); }
  }
  private saveFilters(value: Record<string, Declaration>) {
    atomicWriteFile(resolveInside(this.deps.dataRoot, 'agent/plugins/disabled-packages.json', 'write'), JSON.stringify(value, null, 2));
  }
  private declarations(settings = this.settings()): Declaration[] {
    const entries = (settings.packages ?? []) as Declaration[];
    if (entries.some((entry) => !(typeof entry === 'string' || (entry && typeof entry === 'object' && typeof entry.source === 'string')))) throw new ToolError('pi_settings_invalid', '应用Pi包声明无效', 409);
    return entries;
  }
  private describe(source: string, installPath: string, off: boolean, resources: PiPackagePlugin['resources']): PiPackagePlugin {
    let manifest: Record<string, unknown> = {};
    if (fs.existsSync(installPath) && fs.statSync(installPath).isDirectory()) {
      try { manifest = JSON.parse(fs.readFileSync(path.join(installPath, 'package.json'), 'utf8')); } catch { /* 单文件/约定目录包可无manifest */ }
    }
    const workbench = path.resolve(installPath) === this.builtinRoot;
    const amagi = this.isManagedAmagi(source);
    const builtin = workbench || amagi;
    return { id: crypto.createHash('sha256').update(source).digest('hex').slice(0, 24), source,
      sourceType: builtin ? 'builtin' : source.startsWith('npm:') ? 'npm' : /^(git:|https?:|git@)/.test(source) ? 'git' : 'local',
      name: workbench ? '知识库工作台' : typeof manifest.name === 'string' ? manifest.name : path.basename(installPath || source),
      description: amagi ? '应用内置的构建编排插件，启动时自动安装，随应用更新。构建运行时按角色加载；普通会话使用应用自己的任务工具。' : typeof manifest.description === 'string' ? manifest.description : '', version: typeof manifest.version === 'string' ? manifest.version : '',
      enabled: !off, installPath, resources, ...(amagi ? { managed: true } : {}) };
  }
  private env() {
    const env = buildPiProcessEnv({ mode: 'app-llm', parentEnv: process.env, dataRoot: this.deps.dataRoot, agentUrl: '', runToken: '' });
    // 包管理走显式CLI，安装可联网；运行期仍offline。不给包安装环境任何应用模型key。
    env.PI_CODING_AGENT_DIR = this.agentDir;
    delete env.PI_OFFLINE; delete env.FEISHU_SYNC_AGENT_RUN_TOKEN; delete env.FEISHU_SYNC_AGENT_URL;
    return env;
  }
  async refresh(): Promise<PiPluginsDto> {
    if (this.mutating) throw new ToolError('plugin_busy', '正在管理插件，请稍后重试', 409);
    await this.ensureBundled();
    return this.inspect();
  }
  private async inspect(): Promise<PiPluginsDto> {
    const generation = this.generation;
    const runtime = await this.deps.resolver.resolveRuntime(this.deps.agentConfig());
    if (!runtime.nodePath || !runtime.piPackageRoot) {
      if (this.declarations().length > 1) throw new ToolError('agent_not_ready', '请先配置Pi运行时以读取已安装包', 503);
    } else {
      if (!fs.existsSync(runtime.nodePath) || !fs.existsSync(path.join(runtime.piPackageRoot, 'dist/core/package-manager.js'))) throw new ToolError('agent_not_ready', 'Pi包管理SDK不可用，请重新配置运行时后刷新', 503);
      const env = this.env(); env.PI_OFFLINE = '1';
      const { stdout } = await run(runtime.nodePath, [path.join(piWorkbenchPackageRoot(), 'inspect-packages.mjs'), runtime.piPackageRoot, this.agentDir],
        { cwd: this.agentDir, env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      const line = stdout.split('\n').find((value) => value.startsWith('FEISHU_PACKAGES_JSON='));
      if (!line) throw new ToolError('plugin_inspect_failed', 'Pi未返回包资源信息');
      const data = JSON.parse(line.slice('FEISHU_PACKAGES_JSON='.length));
      if (generation !== this.generation) throw new ToolError('plugin_busy', '插件操作后旧列表已失效，请刷新', 409);
      this.cache = data.packages.filter((entry: { scope: string }) => entry.scope === 'user').map((entry: { source: string; installedPath: string }) => {
        const declaration = this.declarations().find((item) => sourceOf(item) === entry.source)!;
        if (/^(npm:|git:|https?:|git@)/.test(entry.source) && entry.installedPath && !isPathInside(this.agentDir, fs.realpathSync.native(entry.installedPath))) throw new ToolError('plugin_outside_application', 'Pi包实体位于应用目录之外，请重新安装到本应用', 409);
        const resources = Object.entries(data.resources).flatMap(([type, items]) => Array.isArray(items) ? items
          .filter((resource: { metadata?: { packageRoot?: string; source?: string } }) => (!!entry.installedPath && resource.metadata?.packageRoot === entry.installedPath) || resource.metadata?.source === entry.source)
          .map((resource: { path: string; enabled?: boolean }) => ({ type, path: resource.path, enabled: resource.enabled !== false })) : []);
        return this.describe(entry.source, entry.installedPath || '', disabled(declaration), resources);
      });
    }
    this.updateRevision(); return this.dto();
  }
  private updateRevision() {
    this.revision = crypto.createHash('sha256').update(JSON.stringify({ declarations: this.declarations(), packages: this.cache, savedFilters: this.savedFilters() })).digest('hex');
  }
  private dto(): PiPluginsDto { return { revision: this.revision, agentDir: this.agentDir, packages: this.cache, busy: this.mutating }; }
  externalCount(): number { return this.cache.filter((pkg) => pkg.enabled && pkg.sourceType !== 'builtin').length; }
  protectedRoots(): string[] { return this.cache.map((pkg) => pkg.installPath).filter(Boolean); }
  private assertRuntimeReady() {
    if (this.mutating) throw new ToolError('plugin_busy', '插件管理进行中，请完成后再启动对话或构建', 409);
    if (this.cache.length !== this.declarations().length) throw new ToolError('plugin_refresh_required', '插件资源尚未就绪，请先在设置中刷新插件', 409);
    if (this.bundle && !this.bundledReady) throw new ToolError('plugin_not_ready', '内置 amagi-pi 正在等待 Pi 运行时安装，请稍后重试', 503);
  }
  /**
   * 原生 Work 使用的应用内包资源（含内置 amagi-pi）。原生 Work 没有应用 task_* 工具族，
   * 因此与 amagi 的任务工具不冲突。packageName 取包 manifest 名，用于与本机包去重。
   */
  nativeWorkPackages(): { revision: string; packages: Array<{ packageName: string; extensions: string[]; skills: string[]; prompts: string[]; themes: string[] }> } {
    this.assertRuntimeReady();
    const enabled = this.cache.filter((pkg) => pkg.enabled);
    const hash = crypto.createHash('sha256').update(this.revision);
    hash.update(JSON.stringify(this.settings().extensions ?? []));
    const packages = enabled.map((pkg) => {
      if (!fs.existsSync(pkg.installPath)) throw new ToolError('plugin_missing', `插件文件缺失：${pkg.name}`, 409);
      let packageName = '';
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(pkg.installPath, 'package.json'), 'utf8')) as { name?: unknown };
        if (typeof manifest.name === 'string' && manifest.name) packageName = manifest.name;
      } catch { /* 没有 manifest 名的资源不能按名称去重 */ }
      const of = (type: string) => [...new Set(pkg.resources.filter((resource) => resource.type === type && resource.enabled !== false).map((resource) => resource.path))];
      for (const file of pkg.resources.filter((resource) => resource.enabled !== false).map((resource) => resource.path)) {
        try { if (fs.statSync(file).isFile()) hash.update(fs.readFileSync(file)); } catch { /* 解析结果缺失时由 Pi 启动报错 */ }
      }
      return { packageName, extensions: of('extensions'), skills: of('skills'), prompts: of('prompts'), themes: of('themes') };
    });
    return { revision: hash.digest('hex'), packages };
  }
  /** 只读取用户设置与 manifest；Pi SDK 仅使用内存 settings 推导已安装路径，不获取用户目录锁。 */
  private async localPackages(agentDir: string, cwd?: string, inheritedNpmCommand?: unknown): Promise<Array<{ name: string; declaration: Declaration | null; source: string; installedPath: string | null }>> {
    const packages: Array<{ name: string; declaration: Declaration | null; source: string; installedPath: string | null }> = [];
    const scope = cwd ? 'project' : 'user';
    // Pi FileSettingsStorage 实测只读取 cwd/.pi/settings.json，不查祖先（见祖先 fixture）。
    const settingsFile = cwd ? path.join(cwd, '.pi', 'settings.json') : path.join(agentDir, 'settings.json');
    if (!fs.existsSync(settingsFile)) return packages;
    try {
      const errors: ParseError[] = [];
      const settings = parseJsonc(fs.readFileSync(settingsFile, 'utf8'), errors) as Record<string, unknown>;
      if (errors.length || !settings || typeof settings !== 'object' || Array.isArray(settings)
        || (settings.packages !== undefined && !Array.isArray(settings.packages))) throw new Error('invalid settings.json');
      const entries = (settings.packages ?? []) as unknown[];
      const declarations = entries.filter((entry): entry is Declaration => typeof entry === 'string'
        || (!!entry && typeof entry === 'object' && typeof (entry as { source?: unknown }).source === 'string'))
        .filter((entry) => !disabled(entry));
      const sources = declarations.map(sourceOf);
      if (!sources.length) return packages;
      const runtime = await this.deps.resolver.resolveRuntime(this.deps.agentConfig());
      if (!runtime.nodePath || !runtime.piPackageRoot) throw new Error('Pi runtime unavailable');
      // getInstalledPath applies the installed Pi version's npm/git/local path rules,
      // including its legacy global npm fallback. It does not resolve or install packages.
      const script = `const {pathToFileURL}=require('node:url'); const path=require('node:path');
        (async()=>{const [root,dir,input]=process.argv.slice(1); const load=n=>import(pathToFileURL(path.join(root,'dist/core',n+'.js')).href);
        const {SettingsManager}=await load('settings-manager'); const {DefaultPackageManager}=await load('package-manager');
        const {sources,settings,cwd,scope}=JSON.parse(input); const manager=new DefaultPackageManager({cwd:cwd||dir,agentDir:dir,settingsManager:SettingsManager.inMemory(settings)});
        console.log(JSON.stringify(sources.map(source=>{try{return manager.getInstalledPath(source,scope)||null}catch{return null}})));})().catch(e=>{console.error(e);process.exitCode=1});`;
      const env = this.env(); env.PI_OFFLINE = '1';
      const { stdout } = await run(runtime.nodePath, ['-e', script, runtime.piPackageRoot, agentDir, JSON.stringify({ sources, cwd, scope, settings: { npmCommand: settings.npmCommand ?? inheritedNpmCommand } })],
        { cwd: this.agentDir, env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      const paths = JSON.parse(stdout) as Array<string | null>;
      for (let index = 0; index < sources.length; index++) {
        try {
          if (!paths[index] || !fs.existsSync(paths[index]!)) {
            if (cwd) {
              console.warn(`[PiPluginService] Project package not installed; first run cannot deduplicate: ${sources[index]}`);
              packages.push({ name: '', declaration: null, source: sources[index], installedPath: null });
              continue;
            }
            throw new Error('not installed');
          }
          let name = '';
          try {
            const manifest = JSON.parse(fs.readFileSync(path.join(paths[index]!, 'package.json'), 'utf8').replace(/^\uFEFF/, '')) as { name?: unknown };
            if (typeof manifest.name === 'string') name = manifest.name;
          } catch { console.warn(`[PiPluginService] Local package has no readable manifest: ${sources[index]}`); }
          const declaration = declarations[index];
          packages.push({ name, declaration: typeof declaration === 'string' ? paths[index]! : { ...declaration, source: paths[index]! }, source: sources[index], installedPath: paths[index] });
        } catch (error) {
          if (error instanceof ToolError) throw error;
          console.warn(`[PiPluginService] Local package cannot be deduplicated: ${sources[index]}`, error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      if (cwd) throw error instanceof ToolError ? error : new ToolError('pi_settings_invalid', '无法读取项目 Pi 包以安全去重', 409);
      console.warn('[PiPluginService] Could not list local Pi packages:', error instanceof Error ? error.message : String(error));
    }
    return packages;
  }
  async localPackageNames(agentDir: string): Promise<Set<string>> {
    return new Set((await this.localPackages(agentDir)).map((entry) => entry.name).filter(Boolean));
  }
  async localWorkRevision(agentDir: string, cwd?: string): Promise<string> {
    // 包路径查询可能执行外部 npm；对查询前后的源字节做同步复核，避免返回混合快照。
    const capture = () => {
      const read = (file: string): string | null => {
        try { return fs.readFileSync(file).toString('base64'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      };
      return {
        app: this.nativeWorkPackages(), settings: this.settings(),
        userSettings: read(path.join(agentDir, 'settings.json')), userMcp: read(path.join(agentDir, 'mcp.json')),
        projectSettings: cwd ? read(path.join(cwd, '.pi', 'settings.json')) : null,
        projectMcp: cwd ? read(path.join(cwd, '.pi', 'mcp.json')) : null,
        paths: ['mcp-auth.json', 'extensions', 'skills', 'prompts', 'themes'].map((name) => fs.existsSync(path.join(agentDir, name))),
      };
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = capture();
      const errors: ParseError[] = [];
      const user = snapshot.userSettings === null ? {} : parseJsonc(Buffer.from(snapshot.userSettings, 'base64').toString('utf8'), errors) as Record<string, unknown>;
      if (errors.length || !user || typeof user !== 'object' || Array.isArray(user)) throw new ToolError('pi_settings_invalid', '本机 Pi settings.json 无效', 409);
      let local: Awaited<ReturnType<PiPluginService['localPackages']>>;
      let project: Awaited<ReturnType<PiPluginService['localPackages']>>;
      try {
        local = await this.localPackages(agentDir);
        project = cwd ? await this.localPackages(agentDir, cwd, user.npmCommand) : [];
      } catch (error) {
        if (JSON.stringify(capture()) !== JSON.stringify(snapshot)) continue;
        throw error;
      }
      // 此同步尾部直到返回不得插入 await；包含应用资源 revision 和全部四份配置原始字节。
      if (JSON.stringify(capture()) !== JSON.stringify(snapshot)) continue;
      return crypto.createHash('sha256').update(JSON.stringify([path.resolve(agentDir), snapshot, local, project])).digest('hex');
    }
    throw new ToolError('plugin_config_changing', '本机插件配置正在变化，请稍后重试', 409);
  }
  async prepareLocalWorkHome(agentDir: string, cwd?: string): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.prepareLocalWorkHomeAttempt(agentDir, cwd); }
      catch (error) {
        if (!(error instanceof ToolError) || error.code !== 'plugin_snapshot_changed') throw error;
      }
    }
    throw new ToolError('plugin_config_changing', '本机插件配置正在变化，请稍后重试', 409);
  }
  private async prepareLocalWorkHomeAttempt(agentDir: string, cwd?: string): Promise<string> {
    const revision = await this.localWorkRevision(agentDir, cwd);
    const work = this.nativeWorkPackages();
    const settings = this.settings();
    const localPath = path.join(agentDir, 'settings.json');
    const errors: ParseError[] = [];
    const user = fs.existsSync(localPath) ? parseJsonc(fs.readFileSync(localPath, 'utf8'), errors) as Record<string, unknown> : {};
    if (errors.length || !user || typeof user !== 'object' || Array.isArray(user)) throw new ToolError('pi_settings_invalid', '本机 Pi settings.json 无效', 409);
    const project = cwd ? await this.localPackages(agentDir, cwd, user.npmCommand) : [];
    const names = new Set(project.map((entry) => entry.name).filter(Boolean));
    const local = (await this.localPackages(agentDir)).filter((entry) => {
      if (!entry.declaration) return false;
      if (!entry.name) return true;
      if (names.has(entry.name)) { console.warn(`[PiPluginService] Skipping duplicate local package: ${entry.name}`); return false; }
      names.add(entry.name); return true;
    });
    const enabled = this.cache.filter((pkg) => pkg.enabled);
    const app = enabled.filter((_pkg, index) => {
      const name = work.packages[index].packageName;
      if (!name) return true;
      if (names.has(name)) { console.warn(`[PiPluginService] Skipping duplicate application package: ${name}`); return false; }
      names.add(name); return true;
    }).map((pkg) => {
        const declaration = this.declarations().find((entry) => sourceOf(entry) === pkg.source);
        if (!declaration) throw new ToolError('plugin_refresh_required', '应用插件声明已变化', 409);
        return typeof declaration === 'string' ? pkg.installPath : { ...declaration, source: pkg.installPath };
      });
    settings.packages = [...local.map((entry) => entry.declaration!), ...app];
    const images = settings.images && typeof settings.images === 'object' && !Array.isArray(settings.images) ? settings.images as Record<string, unknown> : {};
    settings.images = { ...images, autoResize: false };
    for (const type of ['extensions', 'skills', 'prompts', 'themes'] as const) {
      const current = Array.isArray(settings[type]) ? settings[type] as unknown[] : [];
      const entries = Array.isArray(user[type]) ? user[type] as unknown[] : [];
      const paths = entries.filter((entry): entry is string => typeof entry === 'string').map((entry) => {
        if (/^[+!-]?builtin:/.test(entry)) return entry;
        const prefix = /^[+!-]/.test(entry) ? entry[0] : '';
        const value = prefix ? entry.slice(1) : entry;
        return prefix + path.resolve(agentDir, value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
      });
      const dir = path.join(agentDir, type);
      settings[type] = [...current, ...paths, ...(fs.existsSync(dir) ? [dir] : [])];
    }
    const root = resolveInside(this.deps.dataRoot, 'agent/pi-home-local', 'mkdir');
    // Windows uses inherited ACLs. Node's mode bits cannot represent those permissions.
    const supportsPosixModes = process.platform !== 'win32';
    if (supportsPosixModes) fs.chmodSync(root, 0o700);
    // 进程池无法可靠识别所有仍在使用某目录的外部/退出竞态进程；保守不清理。
    const normalizedCwd = fs.realpathSync.native(cwd ?? os.homedir());
    const key = crypto.createHash('sha256').update(JSON.stringify([normalizedCwd, revision])).digest('hex');
    const overlay = path.join(root, key);
    const contents = JSON.stringify(settings, null, 2);
    const links = ['mcp.json', 'mcp-auth.json'].filter((name) => fs.existsSync(path.join(agentDir, name)));
    const valid = (dir: string) => {
      try {
        const stat = fs.lstatSync(dir);
        if (!stat.isDirectory() || (supportsPosixModes && (stat.mode & 0o777) !== 0o700)) return false;
        const file = path.join(dir, 'settings.json');
        if (!fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8') !== contents) return false;
        return ['mcp.json', 'mcp-auth.json'].every((name) => {
          const link = path.join(dir, name);
          try { const stat = fs.lstatSync(link); return links.includes(name) && stat.isSymbolicLink() && fs.readlinkSync(link) === path.join(agentDir, name); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return !links.includes(name); throw error; }
        });
      } catch { return false; }
    };
    let exists = false;
    try { fs.lstatSync(overlay); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (exists) {
      if (revision !== await this.localWorkRevision(agentDir, cwd)) throw new ToolError('plugin_snapshot_changed', '本机插件配置正在变化，请稍后重试', 409);
      if (!valid(overlay)) throw new ToolError('pi_settings_invalid', '已有 Pi 覆盖目录不完整或已更改，拒绝覆盖', 409);
      return overlay;
    }
    const temp = fs.mkdtempSync(path.join(root, '.tmp-'));
    try {
      if (supportsPosixModes) fs.chmodSync(temp, 0o700);
      fs.writeFileSync(path.join(temp, 'settings.json'), contents, { mode: 0o600 });
      for (const name of links) fs.symlinkSync(path.join(agentDir, name), path.join(temp, name));
      if (!valid(temp)) throw new ToolError('pi_settings_invalid', 'Pi 覆盖目录校验失败', 409);
      if (revision !== await this.localWorkRevision(agentDir, cwd)) throw new ToolError('plugin_snapshot_changed', '本机插件配置正在变化，请稍后重试', 409);
      try { fs.renameSync(temp, overlay); }
      catch (error) { if (!valid(overlay)) throw error; }
      return overlay;
    } finally { if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true }); }
  }
  async enabledWorkBuiltins(): Promise<string[]> {
    const runtime = await this.deps.resolver.resolveRuntime(this.deps.agentConfig());
    if (!runtime.nodePath || !runtime.piPackageRoot) throw new ToolError('agent_not_ready', 'Pi 运行时不可用', 503);
    const raw = this.settings().extensions;
    const extensions = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && /^[+!-]?builtin:/.test(item)) : [];
    const script = `const {pathToFileURL}=require('node:url'),path=require('node:path');(async()=>{
      const [root,dir,input]=process.argv.slice(1); const load=p=>import(pathToFileURL(path.join(root,'dist',p+'.js')).href);
      const {SettingsManager}=await load('core/settings-manager'),{DefaultPackageManager}=await load('core/package-manager'),{builtInExtensions}=await load('extensions/index');
      const manager=new DefaultPackageManager({cwd:dir,agentDir:dir,settingsManager:SettingsManager.inMemory({extensions:JSON.parse(input)},{projectTrusted:false}),builtinExtensions:builtInExtensions.map(x=>x.name)});
      const resolved=await manager.resolve(); console.log(JSON.stringify(resolved.extensions.filter(x=>x.path.startsWith('builtin:')&&x.enabled).map(x=>x.path)));
    })().catch(e=>{console.error(e);process.exitCode=1});`;
    const env = this.env(); env.PI_OFFLINE = '1'; env.HOME = this.agentDir; env.USERPROFILE = this.agentDir;
    const { stdout } = await run(runtime.nodePath, ['-e', script, runtime.piPackageRoot, this.agentDir, JSON.stringify(extensions)],
      { cwd: this.agentDir, env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout) as string[];
  }
  runtimeResources() {
    this.assertRuntimeReady();
    // amagi task_submit/query/resume conflict with the app task family. Dedicated BuildRuntimeHost
    // loads its frozen copy with its own policy; ordinary sessions keep the existing controlled tools.
    const enabled = this.cache.filter((pkg) => pkg.enabled && !this.isManagedAmagi(pkg.source));
    const hash = crypto.createHash('sha256').update(this.revision);
    for (const pkg of enabled) {
      const files = new Set([path.join(pkg.installPath, 'package.json'), ...pkg.resources.filter((r) => r.enabled !== false).map((r) => r.path)]);
      if (fs.existsSync(pkg.installPath) && fs.statSync(pkg.installPath).isFile()) files.add(pkg.installPath);
      for (const file of files) { try { if (fs.statSync(file).isFile()) hash.update(fs.readFileSync(file)); } catch { /* 缺失在下方明确报错 */ } }
      if (!fs.existsSync(pkg.installPath)) throw new ToolError('plugin_missing', `插件文件缺失：${pkg.name}`, 409);
    }
    const paths = (type: string) => [...new Set(enabled.flatMap((pkg) => pkg.resources.filter((resource) => resource.type === type && resource.enabled !== false).map((resource) => resource.path)))];
    return { sources: paths('extensions'), skills: paths('skills'), prompts: paths('prompts'), themes: paths('themes'), revision: hash.digest('hex'), external: enabled.some((pkg) => pkg.sourceType !== 'builtin'),
      nativeWorkPackages: () => this.nativeWorkPackages(), localWorkRevision: (dir: string, cwd?: string) => this.localWorkRevision(dir, cwd), prepareLocalWorkHome: (dir: string, cwd?: string) => this.prepareLocalWorkHome(dir, cwd), enabledWorkBuiltins: () => this.enabledWorkBuiltins() };
  }
  private validSource(source: unknown): string {
    if (typeof source !== 'string' || !source.trim() || source.length > 2048 || source.trim().startsWith('-') || /[\x00-\x1f;&|<>^%`$()]/.test(source)) throw new ToolError('invalid_request', '请输入有效的npm、git源或本地绝对路径');
    const value = source.trim();
    if (value.startsWith('npm:') || /^(git:|https:\/\/|git@)/.test(value)) return value;
    if (!path.isAbsolute(value) || !fs.existsSync(value)) throw new ToolError('invalid_request', '本地插件请填写已存在的绝对路径');
    return fs.realpathSync.native(value);
  }
  async mutate(action: 'install' | 'update' | 'remove' | 'toggle', input: { source?: unknown; id?: unknown; enabled?: unknown; expectedRevision?: unknown }): Promise<PiPluginsDto> {
    if (this.mutating || this.deps.running()) throw new ToolError('plugin_busy', '有对话/构建正在运行，请结束后再管理Pi插件', 409);
    if (input.expectedRevision !== this.revision) throw new ToolError('plugin_revision_conflict', '插件列表已变化，请刷新后再操作', 409);
    const selected = this.cache.find((pkg) => pkg.id === input.id);
    if (action !== 'install' && !selected) throw new ToolError('plugin_not_found', '插件不存在', 404);
    if ((action === 'remove' || action === 'update') && selected?.sourceType === 'builtin') throw new ToolError('invalid_request', '内置插件由应用维护，可配置或停用');
    if (action === 'toggle' && selected?.managed) throw new ToolError('invalid_request', '内置构建编排插件由应用维护，无需手动启停');
    if (action === 'toggle' && typeof input.enabled !== 'boolean') throw new ToolError('invalid_request', '启用状态必须为布尔值');
    const source = action === 'install' ? this.validSource(input.source) : selected!.source;
    const previous = this.settings();
    const previousFilters = this.savedFilters();
    this.mutating = true;
    this.generation += 1;
    try {
      await this.deps.retireIdle();
      if (action === 'toggle') {
        const settings = this.settings();
        const filters = this.savedFilters();
        settings.packages = this.declarations(settings).map((entry) => {
          if (sourceOf(entry) !== source) return entry;
          if (input.enabled) { const restored = filters[source] ?? source; delete filters[source]; return restored; }
          if (!disabled(entry)) filters[source] = entry;
          return { source, extensions: [], skills: [], prompts: [], themes: [] };
        });
        this.saveSettings(settings); this.saveFilters(filters);
      } else {
        const runtime = await this.deps.resolver.resolveRuntime(this.deps.agentConfig());
        if (!runtime.nodePath || !runtime.piCliPath) throw new ToolError('agent_not_ready', 'Pi运行时不可用', 503);
        await run(runtime.nodePath, [runtime.piCliPath, action === 'install' ? 'install' : action === 'remove' ? 'remove' : 'update', source],
          { cwd: this.agentDir, env: this.env(), timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
      }
      if (action === 'remove') { const filters = this.savedFilters(); delete filters[source]; this.saveFilters(filters); }
      const result = await this.inspect(); result.busy = false; return result;
    } catch (error) {
      this.saveSettings(previous); this.saveFilters(previousFilters);
      await this.inspect().catch(() => undefined);
      throw error instanceof ToolError ? error : new ToolError('plugin_operation_failed', `Pi插件操作失败：${error instanceof Error ? error.message.slice(0, 1500) : String(error)}`);
    } finally { this.mutating = false; }
  }
}
