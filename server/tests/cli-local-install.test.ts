import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CliLocalInstaller } from '../src/cli/local-install.js';
import { CliEndpoint } from '../src/cli-endpoint.js';
import { ConfigManager } from '../src/modules/config-manager.js';
import { cliAdminRoutes } from '../src/routes/cli-admin.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-cli-install-'));
  roots.push(root);
  const data = path.join(root, 'app data');
  const home = path.join(root, 'user home');
  fs.mkdirSync(data);
  fs.mkdirSync(home);
  return { data, home, installer: new CliLocalInstaller(data, home) };
}

it('installs the default skill and shim once and honors cleanup on restart', async () => {
  const { data, home, installer } = fixture();
  if (!installer.cliAvailable) {
    const { bundleCli } = await import('../scripts/lib/cli-bundle.mjs');
    await bundleCli();
  }
  const errors: unknown[] = [];
  installer.installDefaults(error => errors.push(error));
  expect(errors).toEqual([]);
  expect(installer.shimStatus()).toMatchObject({ state: 'installed', path: installer.nativeShimPath });
  expect(fs.existsSync(installer.shimPath)).toBe(true);
  expect(fs.existsSync(installer.cmdPath)).toBe(true);
  const skill = installer.skillStatus('agents');
  expect(skill).toMatchObject({ state: 'installed', path: path.join(home, '.agents', 'skills', 'feishu-sync', 'SKILL.md') });
  expect(fs.readFileSync(skill.path, 'utf8')).toContain(JSON.stringify(installer.nativeShimPath));
  expect(installer.skillStatus('claude').state).toBe('not_installed');
  expect(installer.skillStatus('codex').state).toBe('not_installed');

  installer.removeSkill('agents');
  installer.removeShim();
  const restarted = new CliLocalInstaller(data, home);
  restarted.installDefaults(error => errors.push(error));
  expect(errors).toEqual([]);
  expect(restarted.skillStatus('agents').state).toBe('not_installed');
  expect(restarted.shimStatus().state).toBe('not_installed');
  restarted.installSkill('agents');
  restarted.installShim();
  expect(restarted.skillStatus('agents').state).toBe('installed');
  expect(restarted.shimStatus().state).toBe('installed');
});

it('keeps targets independent and protects custom content during reinstall and cleanup', () => {
  const { home, installer } = fixture();
  installer.installSkill('claude');
  installer.installSkill('codex');
  const claude = installer.skillStatus('claude');
  const codex = installer.skillStatus('codex');
  expect(claude.path).toBe(path.join(home, '.claude', 'skills', 'feishu-sync', 'SKILL.md'));
  expect(codex.path).toBe(path.join(home, '.codex', 'skills', 'feishu-sync', 'SKILL.md'));
  const otherFile = path.join(path.dirname(claude.path), 'notes.md');
  fs.writeFileSync(otherFile, 'user notes');
  installer.removeSkill('claude');
  expect(fs.readFileSync(otherFile, 'utf8')).toBe('user notes');
  expect(installer.skillStatus('codex').state).toBe('installed');
  fs.appendFileSync(codex.path, '\nuser customization\n');
  expect(installer.skillStatus('codex').state).toBe('conflict');
  expect(() => installer.installSkill('codex')).toThrow(/外部修改/);
  expect(() => installer.removeSkill('codex')).toThrow(/外部修改/);
  expect(fs.readFileSync(codex.path, 'utf8')).toContain('user customization');
});

it('manages a selected target through the desktop API and keeps CLI credentials out of it', async () => {
  const { data, installer } = fixture();
  const configManager = new ConfigManager(path.join(data, 'config.json'));
  expect((await configManager.load()).cli?.enabled).toBe(true);
  await configManager.updateConfig({ cli: { enabled: false } });
  expect((await new ConfigManager(path.join(data, 'config.json')).load()).cli?.enabled).toBe(false);
  const app = cliAdminRoutes({
    cliEndpoint: new CliEndpoint(data, { enabledProvider: () => false }),
    desktopToken: 'fixture-desktop', configManager, installer,
  });
  const desktop = { 'X-Desktop-Token': 'fixture-desktop' };
  const target = '/api/cli/skill/codex';
  expect((await app.request(target, { method: 'PUT' })).status).toBe(401);
  expect((await app.request(target, { method: 'PUT', headers: { ...desktop, 'X-Cli-Token': 'fixture-cli' } })).status).toBe(403);
  expect((await app.request('/api/cli/skill/invalid', { method: 'PUT', headers: desktop })).status).toBe(400);
  expect(await (await app.request(target, { method: 'PUT', headers: desktop })).json())
    .toMatchObject({ target: 'codex', state: 'installed' });
  const info = await (await app.request('/api/cli/info', { headers: desktop })).json();
  expect(info).not.toHaveProperty('cliToken');
  expect(info).toMatchObject({ enabled: false, skillAvailable: true,
    skillTargets: [{ target: 'agents' }, { target: 'claude' }, { target: 'codex', state: 'installed' }] });
  expect(await (await app.request(target, { method: 'DELETE', headers: desktop })).json())
    .toMatchObject({ target: 'codex', state: 'not_installed' });
});

// 旧版应用（无哈希尾注）在另一套 Node/CLI 路径下生成的 shim：应识别为可管理的旧版文件
// （needs_update），允许升级/清理；任何被改动的行仍按外部修改保留（conflict）。
it('recognizes legacy app-generated shims generated under different paths and still protects tampered ones', async () => {
  const { data, installer } = fixture();
  if (!installer.cliAvailable) {
    const { bundleCli } = await import('../scripts/lib/cli-bundle.mjs');
    await bundleCli();
  }
  const bin = path.join(data, 'bin');
  fs.mkdirSync(bin);
  const legacySh = [
    '#!/bin/sh',
    '# feishu-sync CLI shim —— 由 feishu-sync 应用生成；重新生成请使用应用设置。',
    '# 用法示例：feishu-sync status --json',
    "export FEISHU_SYNC_HOME='/Users/x/.feishu-sync'",
    "exec '/opt/it'\\''s/node' '/Users/x/repo/server/dist/cli/feishu-sync-cli.cjs' \"$@\"", '',
  ].join('\n');
  const legacyCmd = [
    '@echo off', 'rem feishu-sync CLI shim - generated by feishu-sync app',
    'set "FEISHU_SYNC_HOME=C:/Users/x/.feishu-sync"',
    '"C:/node/node.exe" "C:/repo/server/dist/cli/feishu-sync-cli.cjs" %*',
    'exit /b %ERRORLEVEL%', '',
  ].join('\r\n');
  fs.writeFileSync(installer.shimPath, legacySh, { mode: 0o755 });
  fs.writeFileSync(installer.cmdPath, legacyCmd);
  expect(installer.shimStatus().state).toBe('needs_update');
  installer.installShim();
  expect(installer.shimStatus().state).toBe('installed');
  expect(fs.readFileSync(installer.shimPath, 'utf8')).toContain('feishu-sync managed sha256:');

  fs.writeFileSync(installer.shimPath, legacySh, { mode: 0o755 });
  fs.writeFileSync(installer.cmdPath, legacyCmd);
  installer.removeShim();
  expect(installer.shimStatus().state).toBe('not_installed');

  for (const tampered of [
    legacySh.replace('exec ', 'rm -rf "$HOME/x"; exec '),
    legacySh + 'echo extra\n',
    legacySh.replace("'/Users/x/repo/server/dist/cli/feishu-sync-cli.cjs'", "'/Users/x/evil.sh'"),
    legacySh.replace(" \"$@\"", " \"$@\"; id"),
  ]) {
    fs.writeFileSync(installer.shimPath, tampered, { mode: 0o755 });
    expect(installer.shimStatus().state).toBe('conflict');
    expect(() => installer.installShim()).toThrow();
    expect(fs.readFileSync(installer.shimPath, 'utf8')).toBe(tampered);
  }
});
