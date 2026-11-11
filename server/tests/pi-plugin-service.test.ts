import { afterAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PiPluginService } from '../src/agent/pi-plugin-service.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { buildDefaultAgentConfig } from '../src/types/agent-knowledge.js';
const roots: string[] = [];
afterAll(() => { vi.unstubAllEnvs(); roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });

it('本机包名称检查只读用户目录并按已安装路径解析 local/npm/git', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-local-packages-')); roots.push(root);
  const app = path.join(root, 'app'); const user = path.join(root, 'user');
  fs.mkdirSync(app); fs.mkdirSync(user);
  const packages = [
    ['local-pkg', 'same-local'],
    ['npm/node_modules/@example/pkg', '@example/pkg'],
    ['git/github.com/example/repo', 'same-git'],
  ];
  for (const [dir, name] of packages) {
    fs.mkdirSync(path.join(user, dir), { recursive: true });
    fs.writeFileSync(path.join(user, dir, 'package.json'), JSON.stringify({ name }));
  }
  fs.writeFileSync(path.join(user, 'settings.json'), `{
    // JSONC and filters are supported
    "packages": ["./local-pkg", "npm:@example/pkg@1.0.0", "git:github.com/example/repo", "./missing",
      {"source":"./local-pkg", "extensions":[], "skills":[], "prompts":[], "themes":[]}]
  }`);
  const snapshot = (dir: string): unknown => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [entry.name, entry.isDirectory() ? snapshot(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8')]);
  const before = snapshot(user);
  const resolver = new PiRuntimeResolver(); const config = buildDefaultAgentConfig(app);
  const runtime = await resolver.resolveRuntime(config);
  expect(runtime.nodePath).toBeTruthy(); expect(runtime.piPackageRoot).toBeTruthy();
  const service = new PiPluginService({ dataRoot: app, resolver, agentConfig: () => config, running: () => false, retireIdle: async () => {}, bundledAmagi: null });
  expect(await service.localPackageNames(user)).toEqual(new Set(['same-local', '@example/pkg', 'same-git']));
  expect(snapshot(user)).toEqual(before);
});

it('legacy npm 全局路径查询使用 npmCommand 而非 packageManager', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-npm-command-')); roots.push(root);
  const app = path.join(root, 'app'); const user = path.join(root, 'user'); const globalRoot = path.join(root, 'global');
  fs.mkdirSync(app); fs.mkdirSync(user); fs.mkdirSync(path.join(globalRoot, 'legacy-fixture'), { recursive: true });
  fs.writeFileSync(path.join(globalRoot, 'legacy-fixture/package.json'), JSON.stringify({ name: 'legacy-fixture' }));
  const command = path.join(root, 'fake-npm.cjs'); fs.writeFileSync(command, `process.stdout.write(${JSON.stringify(globalRoot)})`);
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({ npmCommand: [process.execPath, command], packageManager: 'unsupported-value', packages: ['npm:legacy-fixture'] }));
  const before = fs.readFileSync(path.join(user, 'settings.json'), 'utf8');
  const resolver = new PiRuntimeResolver(); const config = buildDefaultAgentConfig(app);
  const service = new PiPluginService({ dataRoot: app, resolver, agentConfig: () => config, running: () => false, retireIdle: async () => {}, bundledAmagi: null });
  expect(await service.localPackageNames(user)).toEqual(new Set(['legacy-fixture']));
  expect(fs.readdirSync(user)).toEqual(['settings.json']); expect(fs.readFileSync(path.join(user, 'settings.json'), 'utf8')).toBe(before);
});

it('project scope npm/git 包优先于同名用户包且保留其他过滤声明', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-project-priority-')); roots.push(root);
  const app = path.join(root, 'app'); const user = path.join(root, 'user'); const cwd = path.join(root, 'cwd');
  fs.mkdirSync(app); fs.mkdirSync(user); fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
  for (const [dir, name] of [['npm/node_modules/@test/npm-package', '@test/npm-package'], ['git/github.com/test/git-package', 'git-package']] as const) {
    const target = path.join(cwd, '.pi', dir); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name }));
  }
  for (const [dir, name] of [['npm-copy', '@test/npm-package'], ['git-copy', 'git-package'], ['remaining', 'remaining']] as const) {
    const target = path.join(user, dir); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name }));
  }
  fs.writeFileSync(path.join(cwd, '.pi/settings.json'), JSON.stringify({ packages: ['npm:@test/npm-package@1.0.0', 'git:github.com/test/git-package'] }));
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({ packages: ['./npm-copy', './git-copy', { source: './remaining', extensions: ['!ignore'] }] }));
  const resolver = new PiRuntimeResolver(); const config = buildDefaultAgentConfig(app);
  const service = new PiPluginService({ dataRoot: app, resolver, agentConfig: () => config, running: () => false, retireIdle: async () => {}, bundledAmagi: null });
  await service.refresh(); const overlay = await service.prepareLocalWorkHome(user, cwd);
  const packages = JSON.parse(fs.readFileSync(path.join(overlay, 'settings.json'), 'utf8')).packages;
  expect(packages).toContainEqual({ source: path.join(user, 'remaining'), extensions: ['!ignore'] });
  expect(JSON.stringify(packages)).not.toContain('npm-copy'); expect(JSON.stringify(packages)).not.toContain('git-copy');
  fs.writeFileSync(path.join(cwd, '.pi/settings.json'), JSON.stringify({ packages: ['git:github.com/test/missing'] }));
  await expect(service.prepareLocalWorkHome(user, cwd)).resolves.toBeTruthy();
});

it('缺失项目包放行，安装后 revision 变化并让同名用户包自动退出覆盖目录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-install-converge-')); roots.push(root);
  const app = path.join(root, 'app'); const user = path.join(root, 'user'); const cwd = path.join(root, 'cwd');
  fs.mkdirSync(app); fs.mkdirSync(path.join(user, 'copy'), { recursive: true }); fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(user, 'copy/package.json'), JSON.stringify({ name: 'fixture-package' }));
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({ packages: ['./copy'] }));
  fs.writeFileSync(path.join(cwd, '.pi/settings.json'), JSON.stringify({ packages: ['npm:fixture-package@1.0.0'] }));
  const resolver = new PiRuntimeResolver(); const config = buildDefaultAgentConfig(app);
  const service = new PiPluginService({ dataRoot: app, resolver, agentConfig: () => config, running: () => false, retireIdle: async () => {}, bundledAmagi: null });
  await service.refresh();
  const before = await service.localWorkRevision(user, cwd); const first = await service.prepareLocalWorkHome(user, cwd);
  const firstBytes = fs.readFileSync(path.join(first, 'settings.json'), 'utf8');
  expect(JSON.parse(firstBytes).packages).toContain(path.join(user, 'copy'));
  const installed = path.join(cwd, '.pi/npm/node_modules/fixture-package'); fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'fixture-package' }));
  const after = await service.localWorkRevision(user, cwd); expect(after).not.toBe(before);
  const second = await service.prepareLocalWorkHome(user, cwd); expect(second).not.toBe(first);
  expect(JSON.parse(fs.readFileSync(path.join(second, 'settings.json'), 'utf8')).packages).not.toContain(path.join(user, 'copy'));
  expect(fs.readFileSync(path.join(first, 'settings.json'), 'utf8')).toBe(firstBytes);
});

it('并发工作区与同工作区多 revision 使用独立、可复用的完整覆盖目录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-overlay-concurrent-')); roots.push(root);
  const app = path.join(root, 'app'); const user = path.join(root, 'user'); const a = path.join(root, 'a'); const b = path.join(root, 'b');
  fs.mkdirSync(app); fs.mkdirSync(user); fs.mkdirSync(path.join(a, '.pi'), { recursive: true }); fs.mkdirSync(path.join(b, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(user, 'mcp.json'), '{}'); fs.writeFileSync(path.join(user, 'mcp-auth.json'), '{}');
  fs.writeFileSync(path.join(a, '.pi/settings.json'), '{}'); fs.writeFileSync(path.join(b, '.pi/settings.json'), '{}');
  const resolver = new PiRuntimeResolver(); const config = buildDefaultAgentConfig(app);
  const service = new PiPluginService({ dataRoot: app, resolver, agentConfig: () => config, running: () => false, retireIdle: async () => {}, bundledAmagi: null });
  await service.refresh();
  const [a1, b1, a1Again] = await Promise.all([service.prepareLocalWorkHome(user, a), service.prepareLocalWorkHome(user, b), service.prepareLocalWorkHome(user, a)]);
  expect(a1Again).toBe(a1); expect(a1).not.toBe(b1);
  const bytes = fs.readFileSync(path.join(a1, 'settings.json'), 'utf8');
  if (process.platform !== 'win32') expect(fs.statSync(a1).mode & 0o777).toBe(0o700);
  expect(fs.readlinkSync(path.join(a1, 'mcp.json'))).toBe(path.join(user, 'mcp.json'));
  expect(fs.readlinkSync(path.join(a1, 'mcp-auth.json'))).toBe(path.join(user, 'mcp-auth.json'));
  fs.writeFileSync(path.join(a, '.pi/settings.json'), JSON.stringify({ extensions: ['-builtin:mcp'] }));
  const [a2, bAgain] = await Promise.all([service.prepareLocalWorkHome(user, a), service.prepareLocalWorkHome(user, b)]);
  expect(a2).not.toBe(a1); expect(bAgain).toBe(b1); expect(fs.readFileSync(path.join(a1, 'settings.json'), 'utf8')).toBe(bytes);
  expect(fs.readdirSync(path.dirname(a1)).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  fs.writeFileSync(path.join(a2, 'settings.json'), '{}');
  await expect(service.prepareLocalWorkHome(user, a)).rejects.toMatchObject({ code: 'pi_settings_invalid', status: 409 });
  expect(fs.readFileSync(path.join(a2, 'settings.json'), 'utf8')).toBe('{}');
});

it('revision 与 prepare 在真实异步 npm 查询内遇到配置变化时重取稳定快照', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-revision-race-')); roots.push(root);
  const app = path.join(root, 'app'); const user = path.join(root, 'user'); const cwd = path.join(root, 'cwd');
  fs.mkdirSync(app); fs.mkdirSync(user); fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
  const global = path.join(root, 'global'); fs.mkdirSync(path.join(global, 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(global, 'fixture/package.json'), JSON.stringify({ name: 'fixture' }));
  const marker = path.join(root, 'marker'); const command = path.join(root, 'npm.cjs');
  fs.writeFileSync(command, `const fs=require('node:fs'),m=${JSON.stringify(marker)};if(fs.existsSync(m)){const x=JSON.parse(fs.readFileSync(m));if(--x.remaining>0)fs.writeFileSync(m,JSON.stringify(x));else{fs.writeFileSync(x.file,x.value);if(x.repeat){x.value=x.value==='A'?'B':'A';x.remaining=1;fs.writeFileSync(m,JSON.stringify(x));}else fs.unlinkSync(m)}}process.stdout.write(${JSON.stringify(global)});`);
  const userSettings = path.join(user, 'settings.json');
  const base = { packages: ['npm:fixture'], npmCommand: [process.execPath, command] };
  fs.writeFileSync(userSettings, JSON.stringify(base));
  const files = [userSettings, path.join(user, 'mcp.json'), path.join(cwd, '.pi/settings.json'), path.join(cwd, '.pi/mcp.json')];
  for (const file of files.slice(1)) fs.writeFileSync(file, '{}');
  const resolver = new PiRuntimeResolver(); const config = buildDefaultAgentConfig(app);
  const service = new PiPluginService({ dataRoot: app, resolver, agentConfig: () => config, running: () => false, retireIdle: async () => {}, bundledAmagi: null });
  await service.refresh();
  for (const [index, file] of files.entries()) {
    const before = await service.localWorkRevision(user, cwd);
    const value = JSON.stringify(index === 0 ? { ...base, extensions: ['!builtin:mcp'] } : { changed: index });
    fs.writeFileSync(marker, JSON.stringify({ remaining: 1, file, value }));
    const during = await service.localWorkRevision(user, cwd); const after = await service.localWorkRevision(user, cwd);
    expect(during).toBe(after); expect(during).not.toBe(before);
  }
  fs.writeFileSync(userSettings, JSON.stringify(base));
  fs.writeFileSync(marker, JSON.stringify({ remaining: 3, file: userSettings, value: JSON.stringify({ ...base, extensions: ['!builtin:mcp'] }) }));
  const overlay = await service.prepareLocalWorkHome(user, cwd);
  expect(JSON.parse(fs.readFileSync(path.join(overlay, 'settings.json'), 'utf8')).extensions).toContain('!builtin:mcp');
  expect(fs.existsSync(marker)).toBe(false);
  fs.writeFileSync(marker, JSON.stringify({ remaining: 1, file: files[1], value: 'A', repeat: true }));
  await expect(service.localWorkRevision(user, cwd)).rejects.toMatchObject({ code: 'plugin_config_changing', status: 409 });
}, 30000);

it('builtin 解析不扫描祖先 .agents，应用 builtin 排除规则仍生效', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-builtin-discovery-')); roots.push(root);
  const app = path.join(root, 'app'); fs.mkdirSync(app);
  const ancestor = path.join(root, '.agents/skills/fixture'); fs.mkdirSync(ancestor, { recursive: true }); fs.writeFileSync(path.join(ancestor, 'SKILL.md'), 'fixture');
  const trace = path.join(root, 'trace'); const preload = path.join(root, 'trace.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),m=require('node:module'),out=${JSON.stringify(trace)},prefix=${JSON.stringify(path.join(root, '.agents'))};for(const key of ['readdirSync','readFileSync','statSync','existsSync']){const orig=fs[key];fs[key]=function(p,...args){if(String(p).startsWith(prefix))fs.appendFileSync(out,key+' '+String(p)+'\\n');return orig.call(this,p,...args)}}m.syncBuiltinESMExports();`);
  const resolver = new PiRuntimeResolver(); const config = buildDefaultAgentConfig(app); const runtime = await resolver.resolveRuntime(config);
  const service = new PiPluginService({ dataRoot: app, resolver, agentConfig: () => config, running: () => false, retireIdle: async () => {}, bundledAmagi: null });
  await service.refresh();
  const settingsPath = path.join(service.agentDir, 'settings.json'); const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, extensions: ['-builtin:codemode', '!builtin:mcp'] }));
  const wrapper = path.join(root, 'node-wrapper'); fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(runtime.nodePath)} --require ${JSON.stringify(preload)} "$@"\n`, { mode: 0o700 });
  const spy = vi.spyOn(resolver, 'resolveRuntime').mockResolvedValue({ ...runtime, nodePath: wrapper });
  try {
    const builtins = await service.enabledWorkBuiltins();
    expect(builtins).not.toContain('builtin:codemode'); expect(builtins).not.toContain('builtin:mcp'); expect(builtins).toContain('builtin:tool-search');
    expect(fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '').toBe('');
  } finally { spy.mockRestore(); }
}, 30000);

it('当前 Pi 从 cwd 而非祖先读取项目 settings，避免屏蔽不会加载的祖先包', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-project-ancestor-')); roots.push(root);
  const app = path.join(root, 'app'); const user = path.join(root, 'user'); const cwd = path.join(root, 'parent', 'child');
  fs.mkdirSync(app); fs.mkdirSync(user); fs.mkdirSync(cwd, { recursive: true });
  const parentPi = path.join(root, 'parent', '.pi'); fs.mkdirSync(path.join(parentPi, 'package'), { recursive: true });
  fs.writeFileSync(path.join(parentPi, 'package/package.json'), JSON.stringify({ name: '@feishu-sync/knowledge-workbench' }));
  fs.writeFileSync(path.join(parentPi, 'settings.json'), JSON.stringify({ packages: ['./package'] }));
  const resolver = new PiRuntimeResolver(); const config = buildDefaultAgentConfig(app); const runtime = await resolver.resolveRuntime(config);
  const sdk = await import(pathToFileURL(path.join(runtime.piPackageRoot!, 'dist/core/settings-manager.js')).href);
  expect(sdk.SettingsManager.create(cwd, user).getProjectSettings().packages).toBeUndefined();
  const service = new PiPluginService({ dataRoot: app, resolver, agentConfig: () => config, running: () => false, retireIdle: async () => {}, bundledAmagi: null });
  await service.refresh(); const overlay = await service.prepareLocalWorkHome(user, cwd);
  const packages = JSON.parse(fs.readFileSync(path.join(overlay, 'settings.json'), 'utf8')).packages;
  expect(packages).toContain(service.builtinRoot);
});

it('Pi resolver 对用户资源过滤与覆盖后的启用结果一致', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pattern-overlay-')); roots.push(root);
  const app = path.join(root, 'app'); const user = path.join(root, 'user'); const cwd = path.join(root, 'cwd');
  fs.mkdirSync(app); fs.mkdirSync(user); fs.mkdirSync(cwd); vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root);
  for (const name of ['secret', 'visible']) {
    const dir = path.join(user, 'skills', name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\nbody`);
  }
  const userSettings = { extensions: ['!builtin:mcp', '!builtin:*', '-builtin:codemode', '+builtin:tool-search'], skills: ['!skills/secret/**', '+skills/visible/SKILL.md'] };
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify(userSettings));
  const resolver = new PiRuntimeResolver(); const config = buildDefaultAgentConfig(app); const runtime = await resolver.resolveRuntime(config);
  expect(runtime.piPackageRoot).toBeTruthy();
  const service = new PiPluginService({ dataRoot: app, resolver, agentConfig: () => config, running: () => false, retireIdle: async () => {}, bundledAmagi: null });
  await service.refresh(); const overlay = await service.prepareLocalWorkHome(user, cwd);
  const rewritten = JSON.parse(fs.readFileSync(path.join(overlay, 'settings.json'), 'utf8'));
  expect(rewritten.extensions).toEqual(expect.arrayContaining(userSettings.extensions));
  expect(rewritten.skills).toContain('!' + path.join(user, 'skills/secret/**'));
  expect(rewritten.skills).toContain('+' + path.join(user, 'skills/visible/SKILL.md'));
  const load = (name: string) => import(pathToFileURL(path.join(runtime.piPackageRoot!, 'dist/core', `${name}.js`)).href);
  const { SettingsManager } = await load('settings-manager'); const { DefaultPackageManager } = await load('package-manager');
  const resolve = async (agentDir: string, settings: unknown) => new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.inMemory(settings), builtinExtensions: ['mcp', 'codemode', 'tool-search'] }).resolve();
  const before = await resolve(user, userSettings); const after = await resolve(overlay, rewritten);
  const builtins = (value: any) => value.extensions.filter((item: any) => item.path.startsWith('builtin:')).map((item: any) => [item.path, item.enabled]).sort();
  const skills = (value: any) => value.skills.filter((item: any) => item.path.startsWith(path.join(user, 'skills'))).map((item: any) => [item.path, item.enabled]).sort();
  expect(builtins(after)).toEqual(builtins(before)); expect(skills(after)).toEqual(skills(before));
  expect(builtins(after)).toEqual([['builtin:codemode', false], ['builtin:mcp', false], ['builtin:tool-search', true]]);
  vi.unstubAllEnvs();
});

it('生成私有本机覆盖目录，改写资源路径并按名称去重', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-local-overlay-')); roots.push(root);
  const app = path.join(root, 'app'); const user = path.join(root, 'user'); fs.mkdirSync(app); fs.mkdirSync(user);
  fs.mkdirSync(path.join(user, 'same')); fs.mkdirSync(path.join(user, 'same2')); fs.mkdirSync(path.join(user, 'skills'));
  fs.writeFileSync(path.join(user, 'same/package.json'), JSON.stringify({ name: '@feishu-sync/knowledge-workbench' }));
  fs.writeFileSync(path.join(user, 'same2/package.json'), JSON.stringify({ name: '@feishu-sync/knowledge-workbench' }));
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({ packages: [{ source: './same', skills: ['*'] }, './same2'], skills: ['./extra'], extensions: ['-builtin:codemode'] }));
  fs.writeFileSync(path.join(user, 'mcp.json'), '{}'); fs.writeFileSync(path.join(user, 'mcp-auth.json'), '{}');
  const snapshot = (dir: string): unknown => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [entry.name, entry.isDirectory() ? snapshot(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8')]);
  const before = snapshot(user);
  const resolver = new PiRuntimeResolver(); const config = buildDefaultAgentConfig(app);
  const service = new PiPluginService({ dataRoot: app, resolver, agentConfig: () => config, running: () => false, retireIdle: async () => {}, bundledAmagi: null });
  await service.refresh();
  const revision = await service.localWorkRevision(user);
  const overlay = await service.prepareLocalWorkHome(user);
  const result = JSON.parse(fs.readFileSync(path.join(overlay, 'settings.json'), 'utf8'));
  expect(result.packages).toEqual([{ source: path.join(user, 'same'), skills: ['*'] }]);
  expect(result.skills).toEqual(expect.arrayContaining([path.join(user, 'extra'), path.join(user, 'skills')]));
  expect(result.extensions).toContain('-builtin:codemode');
  expect(fs.readlinkSync(path.join(overlay, 'mcp.json'))).toBe(path.join(user, 'mcp.json'));
  expect(fs.readlinkSync(path.join(overlay, 'mcp-auth.json'))).toBe(path.join(user, 'mcp-auth.json'));
  expect(snapshot(user)).toEqual(before);
  if (process.platform !== 'win32') expect(fs.statSync(overlay).mode & 0o777).toBe(0o700);
  fs.writeFileSync(path.join(user, 'mcp.json'), '{"changed":true}');
  expect(await service.localWorkRevision(user)).not.toBe(revision);
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
  const projectRevision = await service.localWorkRevision(user, cwd);
  fs.writeFileSync(path.join(cwd, '.pi/settings.json'), '{}');
  const changedSettings = await service.localWorkRevision(user, cwd); expect(changedSettings).not.toBe(projectRevision);
  fs.writeFileSync(path.join(cwd, '.pi/mcp.json'), '{}');
  expect(await service.localWorkRevision(user, cwd)).not.toBe(changedSettings);
});

it('原生Pi包安装/资源解析/启停/更新/移除，保留本地文件与通用Pi；并发/运行中操作拒绝', async (ctx) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-pi-plugin-')); roots.push(root);
  const data = path.join(root, 'app'); fs.mkdirSync(data);
  const config = buildDefaultAgentConfig(data); const resolver = new PiRuntimeResolver();
  config.runtime.backend = 'pi';
  const runtime = await resolver.resolveRuntime(config);
  if (!runtime.nodePath || !runtime.piCliPath) { ctx.skip(); return; }
  const generic = path.join(root, 'generic-pi'); fs.mkdirSync(generic); fs.writeFileSync(path.join(generic, 'settings.json'), '{"packages":["npm:generic-untouched"]}');
  vi.stubEnv('PI_CODING_AGENT_DIR', generic);
  const pkg = path.join(root, 'fixture-package'); fs.mkdirSync(path.join(pkg, 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'skills', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'skills/fixture/SKILL.md'), '---\nname: fixture\ndescription: Fixture only\n---\nNative skill.');
  fs.writeFileSync(path.join(pkg, 'extensions/index.ts'), 'export default function(pi) { pi.on("before_agent_start", (e) => ({systemPrompt:e.systemPrompt+" NATIVE_PACKAGE_MARKER"})); }');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@fixture/native-pi', version: '1.0.0', pi: { extensions: ['./extensions/index.ts'], skills: ['./skills'] } }));
  const before = fs.readFileSync(path.join(pkg, 'extensions/index.ts'), 'utf8');
  let running = false; let retired = 0;
  const service = new PiPluginService({ dataRoot: data, resolver, agentConfig: () => config, running: () => running, retireIdle: async () => { retired++; }, bundledAmagi: null });
  const initial = await service.refresh(); expect(initial.packages).toHaveLength(1); expect(initial.packages[0].sourceType).toBe('builtin');
  let installed = await service.mutate('install', { expectedRevision: initial.revision, source: pkg });
  expect(installed.packages).toHaveLength(2); const plugin = installed.packages.find((p) => p.name === '@fixture/native-pi')!;
  expect(plugin.resources.map((r) => r.type)).toEqual(expect.arrayContaining(['extensions', 'skills']));
  expect(service.runtimeResources().sources).toContain(path.join(fs.realpathSync.native(pkg), 'extensions/index.ts'));
  expect(service.protectedRoots()).toContain(fs.realpathSync.native(pkg));
  const settingsPath = path.join(service.agentDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const filtered = { source: plugin.source, extensions: ['extensions/index.ts'], skills: [], prompts: [], themes: [] };
  settings.packages = settings.packages.map((entry: any) => (typeof entry === 'string' ? entry : entry.source) === plugin.source ? filtered : entry);
  fs.writeFileSync(settingsPath, JSON.stringify(settings)); installed = await service.refresh();
  expect(service.runtimeResources().skills).toEqual([]);
  await expect(service.mutate('toggle', { expectedRevision: initial.revision, id: plugin.id, enabled: false })).rejects.toMatchObject({ code: 'plugin_revision_conflict' });
  running = true;
  await expect(service.mutate('remove', { expectedRevision: installed.revision, id: plugin.id })).rejects.toMatchObject({ code: 'plugin_busy' }); running = false;
  const off = await service.mutate('toggle', { expectedRevision: installed.revision, id: plugin.id, enabled: false });
  expect(off.packages.find((p) => p.id === plugin.id)?.enabled).toBe(false); expect(service.runtimeResources().sources).not.toContain(path.join(fs.realpathSync.native(pkg), 'extensions/index.ts'));
  const on = await service.mutate('toggle', { expectedRevision: off.revision, id: plugin.id, enabled: true });
  expect(service.runtimeResources().sources).toContain(path.join(fs.realpathSync.native(pkg), 'extensions/index.ts'));
  expect(JSON.parse(fs.readFileSync(settingsPath,'utf8')).packages.find((entry: any) => entry.source === plugin.source)).toEqual(filtered);
  const updated = await service.mutate('update', { expectedRevision: on.revision, id: plugin.id });
  const removed = await service.mutate('remove', { expectedRevision: updated.revision, id: plugin.id }); expect(removed.packages).toHaveLength(1);
  expect(fs.readFileSync(path.join(pkg, 'extensions/index.ts'), 'utf8')).toBe(before);
  expect(fs.readFileSync(path.join(generic, 'settings.json'), 'utf8')).toBe('{"packages":["npm:generic-untouched"]}');
  expect(retired).toBe(5);
  await expect(service.mutate('install', { expectedRevision: removed.revision, source: 'npm:bad;injection' })).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(service.mutate('install', { expectedRevision: removed.revision, source: path.join(root, 'missing') })).rejects.toMatchObject({ code: 'invalid_request' });
  const standalone = path.join(root, 'standalone.ts'); fs.writeFileSync(standalone, 'export default function(pi) {}');
  const single = await service.mutate('install', { expectedRevision: removed.revision, source: standalone });
  const singlePlugin = single.packages.find((p) => p.sourceType === 'local')!;
  expect(singlePlugin.resources.some((r) => r.path === fs.realpathSync.native(standalone))).toBe(true);
  const again = await service.mutate('remove', { expectedRevision: single.revision, id: singlePlugin.id });
  const builtin = again.packages[0];
  const disabled = await service.mutate('toggle', { expectedRevision: again.revision, id: builtin.id, enabled: false });
  expect(service.runtimeResources().sources).toEqual([]);
  expect(disabled.packages[0].enabled).toBe(false);
}, 60000);
