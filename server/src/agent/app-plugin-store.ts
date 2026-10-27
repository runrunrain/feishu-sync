/** 应用专属上下文插件注册表。只加载受控Pi扩展，用户内容始终作为文本读取。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { resolveInside, atomicWriteFile, PathGuardError } from './path-guard.js';
import { ToolError } from './agent-tool-service.js';
import { readAgentPromptAssets, piContextExtensionPath } from './agent-assets.js';
import type { AgentContextPlugin, AgentPluginsDto, AgentPluginInput, AgentPluginScope } from '../types/agent-plugin.js';

type Registry = { schemaVersion: 1; overrides: Record<string, AgentPluginInput>; custom: AgentContextPlugin[] };
export interface AppPluginSnapshot { revision: string; path: string; extensionPath: string; extensionPaths?: string[]; externalPlugins?: boolean; skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[] }
const SCOPES = new Set(['discuss', 'work', 'build']);
const REGISTRY = 'agent/plugins/registry.json';
const MAX_CONTENT = 64 * 1024;

export class AppPluginStore {
  constructor(readonly dataRoot: string, private assets = readAgentPromptAssets, private nativeResources?: () => { sources: string[]; revision: string; external: boolean; skills?: string[]; prompts?: string[]; themes?: string[] }) {}

  private defaults(): AgentContextPlugin[] {
    const assets = this.assets();
    if (!assets) throw new ToolError('plugin_assets_missing', '内置上下文插件资产缺失，请重新构建应用', 503);
    const plugin = (id: string, name: string, description: string, scopes: AgentPluginScope[], content: string): AgentContextPlugin =>
      ({ id, name, description, scopes, content, kind: 'context', builtin: true, enabled: true });
    return [
      plugin('discuss-context', '知识库对话上下文', '设计讨论、检索与回答方式', ['discuss'],
        '你是知识库设计讨论助手。优先检索标准知识库，按需要核对原始文档。区分已有事实、推断和建议；来源不足时直接说明，保留具体问题。来源追溯使用文档标题，避免在自然回答中堆放内部标识。对话模式只读，不声称已修改任何文件。'),
      plugin('work-context', 'Work 工作上下文', '本地工作方式与写入说明', ['work'],
        '你是本地知识工作助手。先检索知识库与相关工作文件，再完成用户要求的修改。原始知识库和标准知识库只读，写入仅限当前授权Workspace。以工具实际结果确认完成，不虚构文件变化。当前应用不提供shell工具。'),
      plugin('kb-build-rules', '标准库构建规则', '源读取、主题组织与构建流程', ['build'], assets.buildRules),
      plugin('kb-style', '标准库文风', '自然完整的知识表述、排版与来源纪律', ['build'], assets.styleGuide),
    ];
  }

  private readRegistry(): Registry {
    let file: string;
    try { file = resolveInside(this.dataRoot, REGISTRY, 'read'); }
    catch (error) {
      if (error instanceof PathGuardError && error.code === 'not_found') return { schemaVersion: 1, overrides: {}, custom: [] };
      throw error;
    }
    try {
      if (fs.statSync(file).size > 512 * 1024) throw new Error('too large');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Registry;
      if (raw.schemaVersion !== 1 || !raw.overrides || typeof raw.overrides !== 'object' || Array.isArray(raw.overrides)
        || !Array.isArray(raw.custom) || raw.custom.length > 30) throw new Error('schema');
      for (const [id, input] of Object.entries(raw.overrides)) {
        if (!['discuss-context', 'work-context', 'kb-build-rules', 'kb-style'].includes(id)) throw new Error('id');
        this.validateInput(input, true);
      }
      const ids = new Set<string>();
      for (const plugin of raw.custom) {
        if (!/^custom_[a-f0-9]{16}$/.test(plugin.id) || ids.has(plugin.id)
          || plugin.builtin !== false || plugin.kind !== 'context') throw new Error('custom');
        ids.add(plugin.id); this.validateInput(plugin, false, true);
      }
      return raw;
    } catch { throw new ToolError('plugin_registry_invalid', '应用插件配置无效；请检查应用数据目录中的agent/plugins/registry.json', 409); }
  }

  list(): AgentPluginsDto {
    const registry = this.readRegistry();
    const plugins = this.defaults().map((plugin) => ({ ...plugin, ...registry.overrides[plugin.id] })).concat(registry.custom);
    if (Buffer.byteLength(JSON.stringify(plugins)) > 256 * 1024) throw new ToolError('plugin_limit', '插件内容总量不得超过256KB');
    return { revision: crypto.createHash('sha256').update(JSON.stringify(plugins)).digest('hex'), plugins };
  }

  private validateInput(input: AgentPluginInput, builtin: boolean, complete = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ToolError('invalid_request', '插件配置必须为对象');
    for (const key of Object.keys(input)) {
      if (!['name', 'description', 'enabled', 'scopes', 'content', ...(complete ? ['id', 'kind', 'builtin'] : [])].includes(key)) {
        throw new ToolError('invalid_request', `不支持的插件字段：${key}`);
      }
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new ToolError('invalid_request', 'enabled必须为布尔值');
    for (const [key, limit, required] of [['name', 80, true], ['description', 300, false], ['content', MAX_CONTENT, false]] as const) {
      const value = input[key];
      if (value !== undefined && (typeof value !== 'string' || Buffer.byteLength(value) > limit || (required && !value.trim()))) {
        throw new ToolError('invalid_request', `${key}必须是有效文本，长度不超过${limit}字节`);
      }
      if (complete && value === undefined) throw new ToolError('invalid_request', `缺少${key}`);
    }
    if (input.scopes !== undefined && (!Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > 3
      || input.scopes.some((scope) => !SCOPES.has(scope)) || new Set(input.scopes).size !== input.scopes.length)) {
      throw new ToolError('invalid_request', '适用范围只能选择对话、Work和构建');
    }
    if (complete && (!input.scopes || typeof input.enabled !== 'boolean')) throw new ToolError('invalid_request', '插件缺少适用范围或状态');
    if (builtin && (input.name !== undefined || input.description !== undefined || input.scopes !== undefined)) {
      throw new ToolError('invalid_request', '内置插件仅允许调整内容与启用状态');
    }
  }

  mutate(action: 'create' | 'update' | 'delete' | 'reset', id: string | null, expectedRevision: unknown, input: AgentPluginInput = {}): AgentPluginsDto {
    const current = this.list();
    if (expectedRevision !== current.revision) throw new ToolError('plugin_revision_conflict', '插件已被其他操作修改，请刷新后再保存', 409);
    const registry = this.readRegistry();
    const found = current.plugins.find((plugin) => plugin.id === id);
    if (action !== 'create' && !found) throw new ToolError('plugin_not_found', '插件不存在', 404);
    if (action === 'create') {
      this.validateInput(input, false);
      if (!input.name?.trim() || !input.scopes || input.content === undefined) throw new ToolError('invalid_request', '请填写插件名称、适用范围与内容');
      if (registry.custom.length >= 30) throw new ToolError('plugin_limit', '最多新增30个上下文插件');
      registry.custom.push({ id: `custom_${crypto.randomBytes(8).toString('hex')}`, name: input.name.trim(), description: '',
        enabled: true, scopes: input.scopes, content: input.content, ...input, builtin: false, kind: 'context' });
    } else if (action === 'update') {
      this.validateInput(input, found!.builtin);
      if (found!.builtin) registry.overrides[id!] = { ...registry.overrides[id!], ...input };
      else registry.custom = registry.custom.map((plugin) => plugin.id === id ? { ...plugin, ...input } : plugin);
    } else if (action === 'reset') {
      if (!found!.builtin) throw new ToolError('invalid_request', '仅内置插件支持恢复默认');
      delete registry.overrides[id!];
    } else {
      if (found!.builtin) throw new ToolError('invalid_request', '内置插件可停用，不可删除');
      registry.custom = registry.custom.filter((plugin) => plugin.id !== id);
    }
    const next = this.defaults().map((plugin) => ({ ...plugin, ...registry.overrides[plugin.id] })).concat(registry.custom);
    if (Buffer.byteLength(JSON.stringify(next)) > 256 * 1024) throw new ToolError('plugin_limit', '插件内容总量不得超过256KB');
    resolveInside(this.dataRoot, 'agent/plugins', 'mkdir');
    const target = resolveInside(this.dataRoot, REGISTRY, 'write');
    atomicWriteFile(target, JSON.stringify(registry, null, 2)); fs.chmodSync(target, 0o600);
    return this.list();
  }

  snapshot(scope: AgentPluginScope): AppPluginSnapshot {
    const extensionPath = piContextExtensionPath();
    if (!extensionPath) throw new ToolError('plugin_assets_missing', 'Pi上下文扩展缺失，请重新构建应用', 503);
    const { plugins } = this.list();
    const native = this.nativeResources?.();
    const content = JSON.stringify({ schemaVersion: 1, scope, nativeRevision: native?.revision, plugins: plugins.filter((p) => p.enabled && p.scopes.includes(scope)) });
    const revision = crypto.createHash('sha256').update(content).digest('hex');
    resolveInside(this.dataRoot, 'agent/plugins/snapshots', 'mkdir');
    const target = resolveInside(this.dataRoot, `agent/plugins/snapshots/${revision}.json`, 'write');
    if (!fs.existsSync(target)) { atomicWriteFile(target, content); fs.chmodSync(target, 0o600); }
    else if (fs.readFileSync(target, 'utf8') !== content) throw new ToolError('plugin_snapshot_invalid', '上下文插件快照被修改，请检查应用插件目录', 409);
    return { revision, path: target, extensionPath, ...(native ? { extensionPaths: native.sources, externalPlugins: native.external, skillPaths: native.skills, promptPaths: native.prompts, themePaths: native.themes } : {}) };
  }
}
