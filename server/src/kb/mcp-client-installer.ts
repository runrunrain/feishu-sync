/** Local user-level MCP configuration. Never accepts paths or commands from the renderer. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyEdits, findNodeAtLocation, modify, parseTree, type Node as JsonNode } from 'jsonc-parser';
import type { KbMcpInfoDto } from '../types/agent-knowledge.js';

export type McpClientTarget = 'agents' | 'claude';
export type McpInstallState = 'not_installed' | 'installed' | 'needs_update' | 'conflict' | 'modified' | 'invalid';
export interface McpInstallStatus { target: McpClientTarget; path: string; state: McpInstallState; message?: string }
type OwnedEntry = { path: string; digest: string; createdServers: boolean; installId: string };
type Registry = { version: 1; entries: Partial<Record<McpClientTarget, OwnedEntry>> };
type Snapshot = { exists: boolean; text: string; mode: number };
const SERVER_NAME = 'feishu-kb';
const MAX_CONFIG_BYTES = 32 * 1024 * 1024;

export class McpInstallError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const problem = (code: string, message: string): never => { throw new McpInstallError(code, message); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
function snapshot(file: string, limit = MAX_CONFIG_BYTES): Snapshot {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > limit) {
      return problem('unsafe_file', '配置文件不是安全的普通文件，或文件过大，请手动检查。');
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > limit) return problem('unsafe_file', '配置文件不安全，请手动检查。');
      const bytes = fs.readFileSync(fd);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) return problem('invalid_encoding', '配置文件不是有效的 UTF-8，原文件未修改。');
      return { exists: true, text, mode: opened.mode & 0o777 };
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, text: '', mode: 0o600 };
    if (error instanceof McpInstallError) throw error;
    return problem('read_failed', '无法读取配置文件，请检查权限。');
  }
}
function sameSnapshot(a: Snapshot, b: Snapshot): boolean { return a.exists === b.exists && (!a.exists || (a.text === b.text && a.mode === b.mode)); }

/** Windows rename replaces the destination ACL. File.Replace keeps it. */
function windowsFileOperation(script: string, temporary: string, target: string, expectedHash = ''): void {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { SystemRoot: systemRoot, FEISHU_SYNC_MCP_TEMP: temporary, FEISHU_SYNC_MCP_TARGET: target, FEISHU_SYNC_MCP_HASH: expectedHash },
    stdio: 'ignore', windowsHide: true, timeout: 10_000,
  });
}

/** Write beside the target, then atomically replace only the version we inspected. */
function replace(file: string, before: Snapshot, text: string | null): void {
  if (text === null) {
    if (!sameSnapshot(snapshot(file), before)) return problem('concurrent_change', '配置刚刚被其他程序修改，请刷新后重试。');
    if (before.exists) fs.unlinkSync(file);
    return;
  }
  const tmp = path.join(path.dirname(file), `.feishu-sync-mcp-${crypto.randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, before.exists ? before.mode : 0o600);
    if (process.platform === 'win32' && before.exists) {
      // Restrict the empty temporary file before writing potentially sensitive config.
      fs.closeSync(fd); fd = null;
      windowsFileOperation("$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:FEISHU_SYNC_MCP_TARGET; Set-Acl -LiteralPath $env:FEISHU_SYNC_MCP_TEMP -AclObject $acl", tmp, file);
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) return problem('unsafe_file', '临时配置文件不安全，原文件未修改。');
    }
    fs.writeFileSync(fd, text, 'utf8');
    if (process.platform !== 'win32') fs.fchmodSync(fd, before.exists ? before.mode : 0o600);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    if (!sameSnapshot(snapshot(file), before)) return problem('concurrent_change', '配置刚刚被其他程序修改，请刷新后重试。');
    if (!before.exists) {
      // Hard-link creation is exclusive: a concurrently created file is never replaced.
      fs.linkSync(tmp, file);
    } else if (process.platform === 'win32') {
      const expectedHash = crypto.createHash('sha256').update(before.text, 'utf8').digest('hex').toUpperCase();
      windowsFileOperation("$ErrorActionPreference='Stop'; if ((Get-FileHash -LiteralPath $env:FEISHU_SYNC_MCP_TARGET -Algorithm SHA256).Hash -ne $env:FEISHU_SYNC_MCP_HASH) { exit 73 }; [System.IO.File]::Replace($env:FEISHU_SYNC_MCP_TEMP, $env:FEISHU_SYNC_MCP_TARGET, [System.Management.Automation.Language.NullString]::Value, $false)", tmp, file, expectedHash);
    } else {
      fs.renameSync(tmp, file);
    }
  } catch (error) {
    if (error instanceof McpInstallError) throw error;
    if ((error as { status?: number }).status === 73) return problem('concurrent_change', '配置刚刚被其他程序修改，请刷新后重试。');
    return problem('write_failed', '无法安全写入配置文件，请检查权限或其他程序是否正在使用该文件。');
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* renamed, or no temporary file */ }
  }
}

function countProperty(node: JsonNode | undefined, key: string): number {
  return node?.children?.filter((child) => child.type === 'property' && child.children?.[0]?.value === key).length ?? 0;
}
function parseConfig(before: Snapshot): { text: string; bom: string; data: Record<string, unknown>; servers: Record<string, unknown> } {
  const bom = before.exists && before.text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = before.exists ? before.text.slice(bom.length) : '{}\n';
  let data: unknown;
  try { data = JSON.parse(text); } catch { return problem('invalid_json', '配置文件不是有效的 JSON；请修复后重试，原文件未修改。'); }
  if (!object(data) || (data.mcpServers !== undefined && !object(data.mcpServers))) {
    return problem('invalid_config', '配置文件或 mcpServers 不是对象；原文件未修改。');
  }
  const tree = parseTree(text);
  if (!tree || countProperty(tree, 'mcpServers') > 1 || countProperty(findNodeAtLocation(tree, ['mcpServers']), SERVER_NAME) > 1) {
    return problem('invalid_config', '配置中存在重复的 MCP 字段，请先手动检查。');
  }
  return { text, bom, data, servers: (data.mcpServers as Record<string, unknown> | undefined) ?? {} };
}
function patchConfig(text: string, entry: unknown, removeContainer = false): string {
  const pathParts = removeContainer ? ['mcpServers'] : ['mcpServers', SERVER_NAME];
  // Formatting the enclosing object would rewrite unrelated server entries.
  const changed = applyEdits(text, modify(text, pathParts, entry, {}));
  JSON.parse(changed); // Never replace the original with invalid JSON.
  return changed;
}

export class McpClientInstaller {
  private readonly home: string;
  private readonly registryFile: string;
  constructor(private readonly options: { dataRoot: string; homeDir?: string; info: () => KbMcpInfoDto }) {
    const home = options.homeDir ?? os.homedir();
    // A missing network-backed home must not prevent the rest of the app starting.
    try { this.home = fs.realpathSync(home); } catch { this.home = path.resolve(home); }
    this.registryFile = path.join(options.dataRoot, 'mcp-client-installs.json');
  }
  private targetPath(target: McpClientTarget): string {
    if (target === 'agents') return path.join(this.home, '.agents', '.mcp.json');
    if (target === 'claude') return path.join(this.home, '.claude.json');
    return problem('invalid_target', '请选择 .agents 或 Claude Code。');
  }
  private checkTargetDirectory(target: McpClientTarget, create: boolean): void {
    try {
      if (!fs.statSync(this.home).isDirectory()) return problem('home_unavailable', '用户目录不可用，请检查后重试。');
    } catch (error) {
      if (error instanceof McpInstallError) throw error;
      return problem('home_unavailable', '用户目录不可用，请检查后重试。');
    }
    if (target !== 'agents') return;
    const dir = path.join(this.home, '.agents');
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return problem('unsafe_directory', '.agents 不是安全的普通目录，请手动检查。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (create) fs.mkdirSync(dir, { mode: 0o700 });
    }
  }
  private registry(): { before: Snapshot; data: Registry } {
    const before = snapshot(this.registryFile, 64 * 1024);
    if (!before.exists) return { before, data: { version: 1, entries: {} } };
    let data: unknown;
    try { data = JSON.parse(before.text); } catch { return problem('registry_invalid', '安装记录无法读取，未修改客户端配置。'); }
    if (!object(data) || data.version !== 1 || !object(data.entries)) return problem('registry_invalid', '安装记录无效，未修改客户端配置。');
    for (const entry of Object.values(data.entries)) {
      if (!object(entry) || typeof entry.path !== 'string' || typeof entry.digest !== 'string' || !/^[0-9a-f]{64}$/.test(entry.digest) || typeof entry.createdServers !== 'boolean' || typeof entry.installId !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.installId)) {
        return problem('registry_invalid', '安装记录无效，未修改客户端配置。');
      }
    }
    return { before, data: data as unknown as Registry };
  }
  private entry(info: KbMcpInfoDto, installId: string): Record<string, unknown> {
    // Per-install marker prevents an old registry record claiming a new user entry.
    return { command: info.command, args: info.args, env: { ...info.env, FEISHU_SYNC_MCP_INSTALL_ID: installId } };
  }
  private inspect(target: McpClientTarget, registry: Registry, info: KbMcpInfoDto): McpInstallStatus {
    const file = this.targetPath(target);
    try {
      this.checkTargetDirectory(target, false);
      const parsed = parseConfig(snapshot(file));
      const current = parsed.servers[SERVER_NAME];
      if (current === undefined) return { target, path: file, state: 'not_installed' };
      const owned = registry.entries[target];
      if (!owned || owned.path !== file) return { target, path: file, state: 'conflict', message: '已有同名配置，应用不会覆盖或清理。' };
      if (digest(current) !== owned.digest) return { target, path: file, state: 'modified', message: '配置已被其他程序或用户修改，应用不会覆盖或清理。' };
      return { target, path: file, state: digest(current) === digest(this.entry(info, owned.installId)) ? 'installed' : 'needs_update' };
    } catch (error) {
      return { target, path: file, state: 'invalid', message: error instanceof McpInstallError ? error.message : '无法读取配置文件。' };
    }
  }
  status(): McpInstallStatus[] {
    const { data } = this.registry();
    const info = this.options.info();
    return (['agents', 'claude'] as const).map((target) => this.inspect(target, data, info));
  }
  install(target: McpClientTarget): McpInstallStatus {
    const file = this.targetPath(target);
    const info = this.options.info();
    if (!info.available) return problem('mcp_unavailable', '本地 MCP 程序不可用，请先构建或更新应用。');
    const registry = this.registry();
    const currentStatus = this.inspect(target, registry.data, info);
    if (currentStatus.state === 'conflict' || currentStatus.state === 'modified' || currentStatus.state === 'invalid') {
      return problem(currentStatus.state, currentStatus.message ?? '配置不可修改。');
    }
    this.checkTargetDirectory(target, true);
    const before = snapshot(file);
    const parsed = parseConfig(before);
    // Recheck after directory creation so a newly created user entry is never overwritten.
    const present = parsed.servers[SERVER_NAME];
    const owned = registry.data.entries[target];
    if (present !== undefined && (!owned || owned.path !== file || digest(present) !== owned.digest)) return problem('concurrent_change', '配置刚刚发生变化，请刷新后重试。');
    const stillOwned = present !== undefined && owned?.path === file;
    const installId = stillOwned ? owned.installId : crypto.randomUUID();
    const entry = this.entry(info, installId);
    const nextText = parsed.bom + patchConfig(parsed.text, entry);
    const next: Registry = { version: 1, entries: { ...registry.data.entries, [target]: { path: file, digest: digest(entry), installId, createdServers: stillOwned ? owned.createdServers : parsed.data.mcpServers === undefined } } };
    this.commit(file, before, nextText, registry.before, next);
    return this.inspect(target, next, info);
  }
  remove(target: McpClientTarget): McpInstallStatus {
    const file = this.targetPath(target);
    const registry = this.registry();
    const info = this.options.info();
    const state = this.inspect(target, registry.data, info);
    if (state.state === 'conflict' || state.state === 'modified' || state.state === 'invalid') return problem(state.state, state.message ?? '配置不可清理。');
    const owned = registry.data.entries[target];
    if (!owned || owned.path !== file) return state;
    const before = snapshot(file);
    const parsed = parseConfig(before);
    const current = parsed.servers[SERVER_NAME];
    if (current !== undefined && digest(current) !== owned.digest) return problem('concurrent_change', '配置刚刚发生变化，请刷新后重试。');
    let nextText = before.text;
    if (current !== undefined) {
      const removeContainer = owned.createdServers && Object.keys(parsed.servers).length === 1;
      nextText = parsed.bom + patchConfig(parsed.text, undefined, removeContainer);
    }
    const entries = { ...registry.data.entries }; delete entries[target];
    const next: Registry = { version: 1, entries };
    this.commit(file, before, current === undefined ? null : nextText, registry.before, next, current === undefined);
    return { target, path: file, state: 'not_installed' };
  }
  private commit(file: string, before: Snapshot, text: string | null, registryBefore: Snapshot, registry: Registry, skipTarget = false): void {
    if (!skipTarget) replace(file, before, text);
    try {
      replace(this.registryFile, registryBefore, JSON.stringify(registry, null, 2) + '\n');
    } catch (error) {
      if (!skipTarget) {
        try {
          const current = snapshot(file);
          if (current.exists && current.text === text) replace(file, current, before.exists ? before.text : null);
        } catch { /* Never overwrite a concurrent edit during rollback. */ }
      }
      throw error;
    }
  }
}
