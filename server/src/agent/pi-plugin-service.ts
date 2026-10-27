/** Pi原生package管理，参考CodeBox：CLI安装/更新/移除，Pi SDK解析manifest与资源。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWriteFile, resolveInside, isPathInside } from './path-guard.js';
import { piWorkbenchPackageRoot } from './agent-assets.js';
import { buildPiProcessEnv } from './pi-rpc-process.js';
import { ToolError } from './agent-tool-service.js';
import type { PiRuntimeResolver } from './runtime-resolver.js';
import type { AgentConfig } from '../types/agent-knowledge.js';
import type { PiPackagePlugin, PiPluginsDto } from '../types/pi-plugin.js';

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
  constructor(private deps: { dataRoot: string; resolver: PiRuntimeResolver; agentConfig: () => AgentConfig;
    running: () => boolean; retireIdle: () => Promise<void> }) {
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
    const builtin = path.resolve(installPath) === this.builtinRoot;
    return { id: crypto.createHash('sha256').update(source).digest('hex').slice(0, 24), source,
      sourceType: builtin ? 'builtin' : source.startsWith('npm:') ? 'npm' : /^(git:|https?:|git@)/.test(source) ? 'git' : 'local',
      name: builtin ? '知识库工作台' : typeof manifest.name === 'string' ? manifest.name : path.basename(installPath || source),
      description: typeof manifest.description === 'string' ? manifest.description : '', version: typeof manifest.version === 'string' ? manifest.version : '',
      enabled: !off, installPath, resources };
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
  runtimeResources() {
    if (this.mutating) throw new ToolError('plugin_busy', '插件管理进行中，请完成后再启动对话或构建', 409);
    if (this.cache.length !== this.declarations().length) throw new ToolError('plugin_refresh_required', '插件资源尚未就绪，请先在设置中刷新插件', 409);
    const enabled = this.cache.filter((pkg) => pkg.enabled);
    const hash = crypto.createHash('sha256').update(this.revision);
    for (const pkg of enabled) {
      const files = new Set([path.join(pkg.installPath, 'package.json'), ...pkg.resources.filter((r) => r.enabled !== false).map((r) => r.path)]);
      if (fs.existsSync(pkg.installPath) && fs.statSync(pkg.installPath).isFile()) files.add(pkg.installPath);
      for (const file of files) { try { if (fs.statSync(file).isFile()) hash.update(fs.readFileSync(file)); } catch { /* 缺失在下方明确报错 */ } }
      if (!fs.existsSync(pkg.installPath)) throw new ToolError('plugin_missing', `插件文件缺失：${pkg.name}`, 409);
    }
    const paths = (type: string) => [...new Set(enabled.flatMap((pkg) => pkg.resources.filter((resource) => resource.type === type && resource.enabled !== false).map((resource) => resource.path)))];
    return { sources: paths('extensions'), skills: paths('skills'), prompts: paths('prompts'), themes: paths('themes'), revision: hash.digest('hex'), external: enabled.some((pkg) => pkg.sourceType !== 'builtin') };
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
