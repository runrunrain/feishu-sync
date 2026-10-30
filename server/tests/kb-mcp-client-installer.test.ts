import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hono } from 'hono';
import { McpClientInstaller } from '../src/kb/mcp-client-installer.js';
import { kbMcpInstallRoutes } from '../src/routes/kb-mcp-install.js';
import type { KbMcpInfoDto } from '../src/types/agent-knowledge.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-install-')); roots.push(root);
  const home = path.join(root, 'home'); const dataRoot = path.join(root, 'data');
  fs.mkdirSync(home); fs.mkdirSync(dataRoot);
  const info: KbMcpInfoDto = { available: true, command: 'app.exe', args: ['mcp.cjs', '--kb-root', 'old-root'], env: { ELECTRON_RUN_AS_NODE: '1' }, alternative: { command: 'node', args: [], note: '' }, snippet: '' };
  const installer = new McpClientInstaller({ homeDir: home, dataRoot, info: () => info });
  return { root, home, dataRoot, info, installer, agents: path.join(home, '.agents', '.mcp.json'), claude: path.join(home, '.claude.json') };
}
function read(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }

describe('用户级 MCP 安装与清理', () => {
  it('合并到 .agents 并只清理本应用条目，保留其他配置和换行格式', () => {
    const f = fixture(); fs.mkdirSync(path.dirname(f.agents));
    const original = '\uFEFF{\r\n  "notes": "keep exactly",\r\n  "mcpServers": {\r\n    "existing": { "command": "other", "args": ["a"] }\r\n  },\r\n  "unknown": {"x": 42}\r\n}\r\n';
    fs.writeFileSync(f.agents, original);
    expect(f.installer.status().find((item) => item.target === 'agents')?.state).toBe('not_installed');
    expect(f.installer.install('agents').state).toBe('installed');
    const installed = fs.readFileSync(f.agents, 'utf8');
    expect(installed.startsWith('\uFEFF')).toBe(true);
    expect(installed).toContain('"existing": { "command": "other", "args": ["a"] }');
    expect(installed).toContain('"unknown": {"x": 42}');
    expect(installed.replaceAll('\r\n', '')).not.toContain('\n');
    expect(read(f.agents).mcpServers['feishu-kb']).toEqual({ command: 'app.exe', args: f.info.args, env: { ...f.info.env, FEISHU_SYNC_MCP_INSTALL_ID: expect.any(String) } });
    expect(f.installer.install('agents').state).toBe('installed');
    const data = read(f.agents); data.userAdded = { enabled: true }; fs.writeFileSync(f.agents, JSON.stringify(data, null, 2));
    expect(f.installer.remove('agents').state).toBe('not_installed');
    expect(read(f.agents)).toEqual({ notes: 'keep exactly', mcpServers: { existing: { command: 'other', args: ['a'] } }, unknown: { x: 42 }, userAdded: { enabled: true } });
  });

  it('Claude 用户级位置是 ~/.claude.json，创建的空 MCP 容器可安全清除', () => {
    const f = fixture();
    fs.writeFileSync(f.claude, '{"projects":{"original":{"enabled":true}},"unknown":17}\n');
    expect(f.installer.install('claude')).toMatchObject({ path: f.claude, state: 'installed' });
    expect(read(f.claude).projects.original.enabled).toBe(true);
    expect(read(f.claude).mcpServers['feishu-kb'].args).toEqual(f.info.args);
    f.installer.remove('claude');
    expect(read(f.claude)).toEqual({ projects: { original: { enabled: true } }, unknown: 17 });
  });

  it('用户在应用创建的 MCP 容器中新增条目后，清理保留该容器和新增条目', () => {
    const f = fixture(); f.installer.install('claude');
    const edited = read(f.claude); edited.mcpServers.other = { command: 'user-tool' }; fs.writeFileSync(f.claude, JSON.stringify(edited));
    f.installer.remove('claude');
    expect(read(f.claude)).toEqual({ mcpServers: { other: { command: 'user-tool' } } });
  });

  it.skipIf(process.platform === 'win32')('保留已有配置文件的权限位', () => {
    const f = fixture(); fs.writeFileSync(f.claude, '{"other":true}'); fs.chmodSync(f.claude, 0o640);
    f.installer.install('claude');
    expect(fs.statSync(f.claude).mode & 0o777).toBe(0o640);
    f.installer.remove('claude');
    expect(fs.statSync(f.claude).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform !== 'win32')('Windows 下安装与清理均保留原文件 ACL', () => {
    const f = fixture(); fs.writeFileSync(f.claude, '{"other":true}');
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = (script: string) => execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { SystemRoot: systemRoot, FEISHU_SYNC_TEST_ACL_FILE: f.claude }, windowsHide: true, encoding: 'utf8',
    }).trim();
    const before = command("$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:FEISHU_SYNC_TEST_ACL_FILE; $acl.SetAccessRuleProtection($true,$false); $name=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($name,'FullControl','Allow'); $acl.SetAccessRule($rule); Set-Acl -LiteralPath $env:FEISHU_SYNC_TEST_ACL_FILE -AclObject $acl; (Get-Acl -LiteralPath $env:FEISHU_SYNC_TEST_ACL_FILE).Sddl");
    f.installer.install('claude');
    expect(command('(Get-Acl -LiteralPath $env:FEISHU_SYNC_TEST_ACL_FILE).Sddl')).toBe(before);
    f.installer.remove('claude');
    expect(command('(Get-Acl -LiteralPath $env:FEISHU_SYNC_TEST_ACL_FILE).Sddl')).toBe(before);
  });

  it('拒绝覆盖未由应用安装的同名条目，也不清除用户修改过的条目', () => {
    const f = fixture(); fs.mkdirSync(path.dirname(f.agents));
    const original = '{"mcpServers":{"feishu-kb":{"command":"mine"},"other":{"url":"https://example.org"}}}';
    fs.writeFileSync(f.agents, original);
    expect(f.installer.status()[0].state).toBe('conflict');
    expect(() => f.installer.install('agents')).toThrow(/已有同名配置/);
    expect(() => f.installer.remove('agents')).toThrow(/已有同名配置/);
    expect(fs.readFileSync(f.agents, 'utf8')).toBe(original);
    fs.writeFileSync(f.agents, '{"mcpServers":{"other":{"command":"other"}}}');
    f.installer.install('agents');
    const edited = read(f.agents); edited.mcpServers['feishu-kb'].args.push('--custom'); fs.writeFileSync(f.agents, JSON.stringify(edited));
    expect(f.installer.status()[0].state).toBe('modified');
    expect(() => f.installer.remove('agents')).toThrow(/已被其他程序或用户修改/);
    expect(read(f.agents)).toEqual(edited);
  });

  it('标准库位置变化后，只更新仍由应用管理的配置', () => {
    const f = fixture(); f.installer.install('claude');
    f.info.args = ['mcp.cjs', '--kb-root', 'new-root'];
    expect(f.installer.status()[1].state).toBe('needs_update');
    f.installer.install('claude');
    expect(read(f.claude).mcpServers['feishu-kb'].args).toEqual(f.info.args);
    expect(f.installer.status()[1].state).toBe('installed');
  });

  it('带空格、中文和引号的用户目录可安全安装与清理', () => {
    const f = fixture();
    const home = path.join(f.root, "用户 & '资料'"); fs.mkdirSync(home);
    const file = path.join(home, '.claude.json'); fs.writeFileSync(file, '{"other":"保留"}');
    const installer = new McpClientInstaller({ homeDir: home, dataRoot: f.dataRoot, info: () => f.info });
    installer.install('claude');
    expect(read(file).other).toBe('保留');
    installer.remove('claude');
    expect(read(file)).toEqual({ other: '保留' });
  });

  it('旧安装记录不能接管后来由用户新建的同名配置', () => {
    const f = fixture(); f.installer.install('claude');
    const old = read(f.claude).mcpServers['feishu-kb'];
    fs.writeFileSync(f.claude, JSON.stringify({ mcpServers: {} }));
    expect(f.installer.status()[1].state).toBe('not_installed');
    const userEntry = { command: old.command, args: old.args, env: { ...f.info.env } };
    fs.writeFileSync(f.claude, JSON.stringify({ mcpServers: { 'feishu-kb': userEntry } }));
    expect(f.installer.status()[1].state).toBe('modified');
    expect(() => f.installer.remove('claude')).toThrow();
    expect(read(f.claude).mcpServers['feishu-kb']).toEqual(userEntry);
  });

  it.each(['{bad', '{"mcpServers": []}', '{"mcpServers":{},"mcpServers":{}}', '{"mcpServers":{"feishu-kb":{},"feishu-kb":{}}}'])('拒绝无效或歧义的用户配置并保留原文件：%s', (text) => {
    const f = fixture(); fs.writeFileSync(f.claude, text);
    expect(f.installer.status()[1].state).toBe('invalid');
    expect(() => f.installer.install('claude')).toThrow();
    expect(fs.readFileSync(f.claude, 'utf8')).toBe(text);
  });

  it('拒绝包含无效 UTF-8 的配置，避免替换其他内容中的字节', () => {
    const f = fixture();
    const original = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
    fs.writeFileSync(f.claude, original);
    expect(f.installer.status()[1].state).toBe('invalid');
    expect(() => f.installer.install('claude')).toThrow(/UTF-8/);
    expect(fs.readFileSync(f.claude)).toEqual(original);
  });

  it('首次安装时其他程序抢先创建配置，不能覆盖其新文件', () => {
    const f = fixture();
    const link = fs.linkSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (String(to) === f.claude) fs.writeFileSync(f.claude, '{"external":true}');
      return link(from, to);
    });
    expect(() => f.installer.install('claude')).toThrow();
    expect(read(f.claude)).toEqual({ external: true });
  });

  it('写入安装记录失败时回滚刚写入的配置', () => {
    const f = fixture(); const original = '{"other":{"value":true}}'; fs.writeFileSync(f.claude, original);
    const link = fs.linkSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (String(to).endsWith('mcp-client-installs.json')) throw new Error('simulated failure');
      return link(from, to);
    });
    expect(() => f.installer.install('claude')).toThrow();
    expect(fs.readFileSync(f.claude, 'utf8')).toBe(original);
  });

  it('安装记录失败且用户已再次修改时，不用回滚覆盖用户的新内容', () => {
    const f = fixture(); fs.writeFileSync(f.claude, '{"other":true}');
    const link = fs.linkSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (String(to).endsWith('mcp-client-installs.json')) {
        fs.writeFileSync(f.claude, '{"externalEdit":true}');
        throw new Error('simulated failure');
      }
      return link(from, to);
    });
    expect(() => f.installer.install('claude')).toThrow();
    expect(fs.readFileSync(f.claude, 'utf8')).toBe('{"externalEdit":true}');
  });

  it('拒绝修改硬链接配置文件', () => {
    const f = fixture();
    const original = path.join(f.home, 'original.json'); fs.writeFileSync(original, '{"other":true}');
    fs.linkSync(original, f.claude);
    expect(f.installer.status()[1].state).toBe('invalid');
    expect(() => f.installer.install('claude')).toThrow();
    expect(fs.readFileSync(original, 'utf8')).toBe('{"other":true}');
  });

  it('用户目录不可用时安装功能报错，但不会阻止服务构造', () => {
    const f = fixture();
    const installer = new McpClientInstaller({ homeDir: path.join(f.root, 'missing-home'), dataRoot: f.dataRoot, info: () => f.info });
    expect(installer.status().map((item) => item.state)).toEqual(['invalid', 'invalid']);
    expect(() => installer.install('claude')).toThrow(/用户目录不可用/);
  });

  it('安装期间配置发生外部修改时拒绝覆盖', () => {
    const f = fixture(); fs.writeFileSync(f.claude, '{"original":true}');
    const fsync = fs.fsyncSync.bind(fs); let changed = false;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      fsync(fd);
      if (!changed) { changed = true; fs.writeFileSync(f.claude, '{"external":true}'); }
    });
    expect(() => f.installer.install('claude')).toThrow(/其他程序修改/);
    expect(fs.readFileSync(f.claude, 'utf8')).toBe('{"external":true}');
  });
});

describe('MCP 安装路由权限', () => {
  it('只接受桌面令牌和固定目标，不接受 CLI 身份或自定义路径', async () => {
    const f = fixture(); const app = new Hono();
    app.route('/', kbMcpInstallRoutes({ installer: f.installer, desktopToken: 'desktop-secret' }));
    const post = (body: unknown, headers: Record<string, string> = {}) => app.request('/api/kb-mcp-install/install', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    expect((await post({ target: 'claude' })).status).toBe(401);
    expect((await post({ target: 'claude' }, { 'X-Desktop-Token': 'desktop-secret', 'X-Feishu-Sync-Actor': 'cli' })).status).toBe(403);
    expect((await post({ target: 'claude', path: f.claude }, { 'X-Desktop-Token': 'desktop-secret' })).status).toBe(400);
    expect(fs.existsSync(f.claude)).toBe(false);
    expect((await post({ target: 'claude' }, { 'X-Desktop-Token': 'desktop-secret' })).status).toBe(200);
    expect(read(f.claude).mcpServers['feishu-kb'].command).toBe('app.exe');
  });
});
